import { env, json, secretsMatch, issueSession, clearSession, sessionExpiry } from './_lib.js';

// One shared password guards the console. Anyone holding it can send WhatsApp
// messages to the configured recipients, so failures are throttled and the
// answer never says which part was wrong.

const attempts = new Map(); // per warm instance; see the note in README

function throttle(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now >= entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + 10 * 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    clearSession(res);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET') {
    return json(res, 200, { authenticated: Boolean(sessionExpiry(req)) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (req.headers['x-planes-console'] !== '1') {
    return json(res, 403, { error: 'bad_request', message: 'Missing console header.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!throttle(ip)) {
    return json(res, 429, { error: 'too_many_requests', message: 'Too many attempts. Wait ten minutes.' });
  }

  let password = '';
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    password = String(body.password || '');
  } catch {
    return json(res, 400, { error: 'bad_request', message: 'Expected a JSON body.' });
  }

  let expected;
  try {
    expected = env('CONSOLE_PASSWORD');
  } catch (err) {
    return json(res, 500, { error: 'not_configured', message: err.message });
  }
  if (!password || !secretsMatch(password, expected)) {
    return json(res, 401, { error: 'unauthorized', message: 'That password is not right.' });
  }

  const expiresAt = issueSession(res);
  return json(res, 200, { ok: true, expiresAt });
}
