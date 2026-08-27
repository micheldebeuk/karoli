'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const { logger } = require('./logger');
const { renderPlanning } = require('./format');
const { sendPlanning } = require('./send');

/**
 * HTTP control surface for the bot.
 *
 * It runs INSIDE the `listen` process on purpose. The Baileys session
 * directory is a single linked device: two processes opening it at once fight
 * over the Signal key state and end up logged out. So exactly one process owns
 * the socket, and everything that wants to send — the weekly cron, the web
 * console — asks it over this API instead of opening its own.
 *
 * Bind it to 127.0.0.1 and put TLS in front (the same shape as the losali
 * proxy at api.losalidirect.com). The bearer token is the only credential; on
 * a public interface over plain HTTP it would be readable in transit.
 */

const MAX_BODY_BYTES = 64 * 1024;

function secretsMatch(a, b) {
  // Compare digests so differing lengths cannot short-circuit the comparison.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

/** Fixed-window limiter; enough for a single-process control API. */
function createLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, retryAfter: 0 };
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { ok: true, retryAfter: 0 };
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('Body must be a JSON object'), { status: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function createControlServer({ cfg, provider, planningSource, commit = null }) {
  if (!cfg.control.token) {
    throw Object.assign(
      new Error('PLANES_CONTROL_TOKEN is not set — refusing to expose a send endpoint with no credential.'),
      { code: 'ECONFIG' },
    );
  }
  if (cfg.control.token.length < 24) {
    throw Object.assign(
      new Error('PLANES_CONTROL_TOKEN is too short; use at least 24 characters (openssl rand -hex 24).'),
      { code: 'ECONFIG' },
    );
  }

  const startedAt = Date.now();
  const sendLimiter = createLimiter({ limit: cfg.control.sendLimit, windowMs: cfg.control.sendWindowMs });
  const authLimiter = createLimiter({ limit: 20, windowMs: 60_000 });
  const history = [];

  function remember(entry) {
    history.unshift({ at: new Date().toISOString(), ...entry });
    history.length = Math.min(history.length, 20);
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function authorize(req, res, clientKey) {
    const gate = authLimiter(clientKey);
    if (!gate.ok) {
      json(res, 429, { error: 'too_many_requests', retryAfter: gate.retryAfter });
      return false;
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !secretsMatch(token, cfg.control.token)) {
      // Deliberately vague: never hint whether the token was absent or wrong.
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  /** Per-request dry run, without disturbing the live provider. */
  function asDryRun(real) {
    return {
      ...real,
      name: `dry-run(${real.name})`,
      async send(recipient, text) {
        logger.info(`[dry-run] would send to ${recipient} (${text.length} chars)`);
        return { dryRun: true };
      },
    };
  }

  /** A filtered view of the real source, so send.js stays the only path to the transport. */
  function scopedSource(exclude) {
    return {
      name: planningSource.name,
      async load() {
        const planning = await planningSource.load();
        return { ...planning, plans: planning.plans.filter((p) => !exclude.has(p.id.toUpperCase())) };
      },
    };
  }

  function excludeSet(body) {
    return new Set((Array.isArray(body.exclude) ? body.exclude : []).map((id) => String(id).toUpperCase()));
  }

  const routes = {
    // Unauthenticated on purpose so a reverse proxy or uptime check can use it.
    // It must never leak configuration.
    'GET /api/health': async (req, res) => {
      json(res, 200, {
        ok: true,
        service: 'planes',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        commit,
      });
    },

    'GET /api/status': async (req, res) => {
      let planning = null;
      let planningError = null;
      try {
        const loaded = await planningSource.load();
        planning = { title: loaded.title, count: loaded.plans.length };
      } catch (err) {
        planningError = err.message;
      }
      json(res, 200, {
        provider: provider.name,
        source: planningSource.name,
        linked: provider.isRegistered(),
        recipients: cfg.recipients,
        voters: Object.values(cfg.voters),
        upcomingOnly: cfg.upcomingOnly,
        dryRun: cfg.dryRun,
        timezone: cfg.timezone,
        planning,
        planningError,
        history,
        commit,
      });
    },

    'GET /api/planning': async (req, res) => {
      const loaded = await planningSource.load();
      json(res, 200, {
        title: loaded.title,
        upcomingOnly: cfg.upcomingOnly,
        plans: loaded.plans.map((p) => ({
          id: p.id, plan: p.plan, categoria: p.categoria, tipo: p.tipo,
          dia: p.dia, dayLabel: p.dayLabel, horario: p.horario, estado: p.estado,
          votoOlivier: p.votoOlivier, votoKarina: p.votoKarina,
          enlace: p.enlace, maps: p.maps, notas: p.notas,
          date: p.date ? p.date.toISOString() : null,
        })),
        parts: renderPlanning(loaded, { upcomingOnly: cfg.upcomingOnly }),
      });
    },

    'POST /api/preview': async (req, res, body) => {
      const loaded = await planningSource.load();
      const exclude = excludeSet(body);
      const plans = loaded.plans.filter((p) => !exclude.has(p.id.toUpperCase()));
      const upcomingOnly = body.upcomingOnly === undefined ? cfg.upcomingOnly : Boolean(body.upcomingOnly);
      json(res, 200, {
        parts: renderPlanning({ ...loaded, plans }, { upcomingOnly }),
        included: plans.length,
        upcomingOnly,
      });
    },

    'POST /api/send': async (req, res, body, clientKey) => {
      const gate = sendLimiter(clientKey);
      if (!gate.ok) {
        return json(res, 429, {
          error: 'too_many_requests',
          message: `At most ${cfg.control.sendLimit} sends per ${Math.round(cfg.control.sendWindowMs / 60000)} minutes.`,
          retryAfter: gate.retryAfter,
        });
      }

      const recipients = Array.isArray(body.recipients) && body.recipients.length
        ? body.recipients.map((r) => String(r).trim()).filter(Boolean)
        : cfg.recipients;
      if (!recipients.length) {
        return json(res, 400, { error: 'no_recipients', message: 'Nobody would receive the planning.' });
      }

      const dryRun = body.dryRun === undefined ? cfg.dryRun : Boolean(body.dryRun);
      const upcomingOnly = body.upcomingOnly === undefined ? cfg.upcomingOnly : Boolean(body.upcomingOnly);

      const result = await sendPlanning({
        cfg: { ...cfg, recipients, dryRun, upcomingOnly },
        provider: dryRun && !cfg.dryRun ? asDryRun(provider) : provider,
        planningSource: scopedSource(excludeSet(body)),
      });

      const summary = {
        dryRun,
        upcomingOnly,
        parts: result.parts.length,
        results: result.results,
        delivered: result.results.filter((r) => r.ok).length,
        failed: result.failed.length,
      };
      remember({ kind: 'send', ...summary });
      json(res, result.failed.length ? 207 : 200, summary);
    },

    // Route B's ingest point: a scheduled Claude Routine reads the Google Sheet
    // with the operator's own Drive connector and POSTs the rows here, so no
    // Google credentials ever live on the VPS.
    'POST /api/planning/import': async (req, res, body) => {
      if (typeof planningSource.save !== 'function') {
        return json(res, 409, {
          error: 'source_not_writable',
          message: `PLANNING_SOURCE=${planningSource.name} cannot accept a push. Set PLANNING_SOURCE=pushed.`,
        });
      }
      if (!Array.isArray(body.plans)) {
        return json(res, 400, { error: 'bad_request', message: 'Expected { plans: [...] }.' });
      }
      if (!body.plans.length) {
        // Never let a bad scrape silently wipe a good planning.
        return json(res, 400, {
          error: 'empty_planning',
          message: 'Refusing to replace the planning with zero plans.',
        });
      }
      if (body.plans.length > 500) {
        return json(res, 400, { error: 'too_many_plans', message: 'At most 500 plans.' });
      }

      const saved = planningSource.save(body);
      remember({ kind: 'import', plans: saved.plans.length, title: saved.title });
      logger.info(`Planning pushed: ${saved.plans.length} plan(s) — "${saved.title}".`);
      json(res, 200, {
        ok: true,
        title: saved.title,
        plans: saved.plans.length,
        pushedAt: saved.pushedAt,
        parts: renderPlanning(saved, { upcomingOnly: cfg.upcomingOnly }).length,
      });
    },

    'GET /api/groups': async (req, res) => {
      json(res, 200, { groups: await provider.listGroups() });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    // Behind a reverse proxy every connection looks local, so prefer the
    // forwarded address to keep the limiter bucketing real clients apart.
    const clientKey = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';

    res.setHeader('x-content-type-options', 'nosniff');
    // Nothing in a browser talks to this directly — the Vercel functions do,
    // server side — so no origin is allowed to read it from a page.
    res.setHeader('access-control-allow-origin', 'null');

    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'not_found' });
    if (key !== 'GET /api/health' && !authorize(req, res, clientKey)) return;

    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      await handler(req, res, body, clientKey);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) logger.error(`Control API ${key} failed:`, err);
      json(res, status, {
        error: status >= 500 ? 'internal_error' : 'bad_request',
        message: status >= 500 ? 'The bot failed to handle that. Check its logs.' : err.message,
      });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(cfg.control.port, cfg.control.host, () => {
          logger.info(`Control API on http://${cfg.control.host}:${cfg.control.port}`);
          if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.control.host)) {
            logger.warn(
              `Control API is bound to ${cfg.control.host}, not loopback. Terminate TLS in front of it — ` +
                'the bearer token travels in the clear over plain HTTP.',
            );
          }
          resolve(server);
        });
      });
    },
    address() {
      const a = server.address();
      return a ? `http://${cfg.control.host}:${a.port}` : null;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createControlServer, createLimiter };
