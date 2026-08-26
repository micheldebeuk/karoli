import crypto from 'node:crypto';

// Shared plumbing for the console's API routes. Nothing here is exported as a
// route: Vercel does not route files whose name starts with an underscore.

const COOKIE = 'planes_session';

export function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw Object.assign(new Error(`${name} is not configured on this deployment.`), { code: 'ECONFIG' });
  }
  return value;
}

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Constant-time comparison that does not leak length. */
export function secretsMatch(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

// --- session cookie -------------------------------------------------------
// A signed expiry, nothing else. There is one account, so the cookie carries
// no identity worth stealing beyond "this browser logged in".

function sign(value) {
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update(value).digest('base64url');
}

export function issueSession(res) {
  const hours = Number(env('SESSION_HOURS', '12')) || 12;
  const expiresAt = Date.now() + hours * 3600_000;
  const payload = String(expiresAt);
  const token = `${payload}.${sign(payload)}`;

  res.setHeader('set-cookie', [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${hours * 3600}`,
  ].join('; '));
  return expiresAt;
}

export function clearSession(res) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function sessionExpiry(req) {
  const raw = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;

  const token = raw.slice(COOKIE.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected;
  try {
    expected = sign(payload);
  } catch {
    return null; // SESSION_SECRET missing — treat as logged out, not as an error
  }
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return null;
  return expiresAt;
}

/**
 * Gate a route. Returns false (and answers) when the caller may not proceed.
 *
 * `SameSite=Strict` already stops another site sending the cookie, and the
 * custom header means a forged request can never be a "simple" one that skips
 * preflight. Both, because a send is not undoable.
 */
export function guard(req, res, { method = 'GET' } = {}) {
  if (req.method !== method) {
    json(res, 405, { error: 'method_not_allowed' });
    return false;
  }
  if (!sessionExpiry(req)) {
    json(res, 401, { error: 'unauthorized', message: 'Session expired. Log in again.' });
    return false;
  }
  if (method !== 'GET' && req.headers['x-planes-console'] !== '1') {
    json(res, 403, { error: 'bad_request', message: 'Missing console header.' });
    return false;
  }
  return true;
}

// --- talking to the bot ---------------------------------------------------

const TIMEOUTS = { default: 15_000, send: 120_000 };

/** Call the bot's control API on the VPS. Never let its token reach a browser. */
export async function callBot(path, { method = 'GET', body = null, timeoutMs = TIMEOUTS.default } = {}) {
  const base = env('PLANES_VPS_URL').replace(/\/+$/, '');
  if (!/^https:/i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(base)) {
    throw Object.assign(
      new Error('PLANES_VPS_URL must be https — the control token travels in this request.'),
      { code: 'ECONFIG' },
    );
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env('PLANES_CONTROL_TOKEN')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

export const SEND_TIMEOUT_MS = TIMEOUTS.send;

/** Turn an infrastructure failure into something a person can act on. */
export function explain(err) {
  if (err?.code === 'ECONFIG') return { status: 500, body: { error: 'not_configured', message: err.message } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return {
      status: 504,
      body: { error: 'bot_timeout', message: 'The bot did not answer in time. It may still be sending — check WhatsApp before retrying.' },
    };
  }
  return {
    status: 502,
    body: { error: 'bot_unreachable', message: 'Could not reach the bot on the VPS. Is planes-bot running?' },
  };
}
