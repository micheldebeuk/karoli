'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/logger');
logger.setLevel('silent');

const { createControlServer } = require('../src/server');
const { renderPlanning } = require('../src/format');
const { normalizePlanning } = require('../src/planning/schema');
const { fakeProvider, fakePlanningSource, baseConfig } = require('./helpers');

const TOKEN = 'a'.repeat(48);

const PLANS = [
  { id: 'E1', plan: 'Caldetes', dia: 'Sabado 29/08/2026', horario: '09:30-14:00', categoria: 'Escapada - mar y playa' },
  { id: 'C2', plan: 'El Born CCM', dia: 'Domingo 30/08/2026', horario: '17:00-19:00', categoria: 'Cultura - exposicion' },
];

function control(overrides = {}, cfgOverrides = {}) {
  return {
    control: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      sendLimit: 6,
      sendWindowMs: 900_000,
      dispatchTimeoutMs: 120_000,
      ...overrides,
    },
    ...cfgOverrides,
  };
}

/** Boot a real HTTP server on an ephemeral port and hand back a client. */
async function serve(t, { cfgOverrides = {}, controlOverrides = {}, providerOverrides = {} } = {}) {
  const provider = fakeProvider(providerOverrides);
  const planningSource = fakePlanningSource(PLANS);
  const cfg = baseConfig({ upcomingOnly: false, ...control(controlOverrides, cfgOverrides) });
  const api = createControlServer({ cfg, provider, planningSource, commit: 'abc1234' });

  await api.listen();
  const { port } = api.server.address();
  t.after(() => api.close());

  const call = async (path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  };

  return { call, provider, planningSource, cfg, port };
}

// --- refusing to start unsafely -------------------------------------------

test('refuses to expose a send endpoint with no token', () => {
  assert.throws(
    () => createControlServer({
      cfg: baseConfig(control({ token: '' })),
      provider: fakeProvider(),
      planningSource: fakePlanningSource(PLANS),
    }),
    /PLANES_CONTROL_TOKEN is not set/,
  );
});

test('refuses a guessable token', () => {
  assert.throws(
    () => createControlServer({
      cfg: baseConfig(control({ token: 'hunter2' })),
      provider: fakeProvider(),
      planningSource: fakePlanningSource(PLANS),
    }),
    /too short/,
  );
});

// --- auth ------------------------------------------------------------------

test('health needs no token and leaks no configuration', async (t) => {
  const { call } = await serve(t);
  const { status, payload } = await call('/api/health', { token: null });

  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /a{10}/, 'must never echo the token');
  for (const leak of ['recipients', 'provider', 'voters', 'token']) {
    assert.ok(!(leak in payload), `health must not expose ${leak}`);
  }
});

test('every other route refuses an absent, wrong or malformed token', async (t) => {
  const { call } = await serve(t);
  for (const path of ['/api/status', '/api/planning', '/api/groups']) {
    assert.equal((await call(path, { token: null })).status, 401, path);
    assert.equal((await call(path, { token: 'b'.repeat(48) })).status, 401, path);
    assert.equal((await call(path, { token: null, headers: { authorization: 'Basic xyz' } })).status, 401, path);
  }
  assert.equal((await call('/api/send', { method: 'POST', body: {}, token: null })).status, 401);
});

test('a 401 says nothing about why', async (t) => {
  const { call } = await serve(t);
  const missing = await call('/api/status', { token: null });
  const wrong = await call('/api/status', { token: 'b'.repeat(48) });
  assert.deepEqual(missing.payload, wrong.payload);
});

test('an unknown route is a plain 404', async (t) => {
  const { call } = await serve(t);
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/')).status, 404);
});

// --- reading ---------------------------------------------------------------

test('status reports what the operator needs before sending', async (t) => {
  const { call } = await serve(t);
  const { status, payload } = await call('/api/status');

  assert.equal(status, 200);
  assert.equal(payload.provider, 'fake');
  assert.equal(payload.linked, true);
  assert.deepEqual(payload.recipients, ['+34600111222']);
  assert.deepEqual(payload.planning, { title: 'Planes de Fin de Semana', count: 2 });
  assert.equal(payload.commit, 'abc1234');
  assert.ok(!JSON.stringify(payload).includes(TOKEN));
});

test('status survives a planning source that is down', async (t) => {
  const { call, planningSource } = await serve(t);
  planningSource.load = async () => { throw new Error('sheet unavailable'); };

  const { status, payload } = await call('/api/status');
  assert.equal(status, 200, 'a broken source must not take the whole API down');
  assert.equal(payload.planning, null);
  assert.match(payload.planningError, /sheet unavailable/);
});

test('planning returns the exact parts the bot would send', async (t) => {
  const { call } = await serve(t);
  const { payload } = await call('/api/planning');

  assert.deepStrictEqual(
    payload.parts,
    renderPlanning(normalizePlanning({ plans: PLANS }), { upcomingOnly: false }),
  );
  assert.equal(payload.plans.length, 2);
  assert.equal(payload.plans[0].id, 'E1');
});

test('preview honours exclusions and the weekend toggle', async (t) => {
  const { call } = await serve(t);

  const all = await call('/api/preview', { method: 'POST', body: { upcomingOnly: false } });
  assert.equal(all.payload.included, 2);
  assert.match(all.payload.parts[0], /Caldetes/);

  const some = await call('/api/preview', { method: 'POST', body: { exclude: ['e1'], upcomingOnly: false } });
  assert.equal(some.payload.included, 1, 'exclusion must be case-insensitive');
  assert.doesNotMatch(some.payload.parts[0], /Caldetes/);
  assert.match(some.payload.parts[0], /El Born/);
});

// --- sending ---------------------------------------------------------------

test('send actually delivers through the transport', async (t) => {
  const { call, provider } = await serve(t);
  const { status, payload } = await call('/api/send', { method: 'POST', body: { upcomingOnly: false } });

  assert.equal(status, 200);
  assert.equal(payload.delivered, 1);
  assert.equal(payload.failed, 0);
  assert.equal(payload.dryRun, false);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].recipient, '34600111222@s.whatsapp.net');
  assert.match(provider.sent[0].text, /Caldetes/);
});

test('a dry run sends nothing but reports what it would have done', async (t) => {
  const { call, provider } = await serve(t);
  const { status, payload } = await call('/api/send', { method: 'POST', body: { dryRun: true, upcomingOnly: false } });

  assert.equal(status, 200);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.delivered, 1);
  assert.equal(provider.sent.length, 0, 'a dry run must not reach the transport');
});

test('send honours per-request recipients and exclusions', async (t) => {
  const { call, provider } = await serve(t);
  await call('/api/send', {
    method: 'POST',
    body: { recipients: ['+34600999888', '120363000000000000@g.us'], exclude: ['E1'], upcomingOnly: false },
  });

  assert.deepEqual(provider.sent.map((s) => s.recipient), [
    '34600999888@s.whatsapp.net',
    '120363000000000000@g.us',
  ]);
  assert.doesNotMatch(provider.sent[0].text, /Caldetes/);
});

test('a partial delivery is reported as 207, not as success', async (t) => {
  const { call } = await serve(t, {
    providerOverrides: {
      async send(recipient, text) {
        if (recipient.startsWith('34600999888')) throw new Error('blocked you');
        this.sent.push({ recipient, text });
        return { key: { id: 'x' } };
      },
    },
  });

  const { status, payload } = await call('/api/send', {
    method: 'POST',
    body: { recipients: ['+34600999888', '+34600111222'], upcomingOnly: false },
  });

  assert.equal(status, 207);
  assert.equal(payload.delivered, 1);
  assert.equal(payload.failed, 1);
  assert.match(payload.results.find((r) => !r.ok).error, /blocked you/);
});

test('a send with nobody to send to is refused', async (t) => {
  const { call } = await serve(t, { cfgOverrides: { recipients: [] } });
  const { status, payload } = await call('/api/send', { method: 'POST', body: {} });

  assert.equal(status, 400);
  assert.equal(payload.error, 'no_recipients');
});

test('sends are rate limited so a stuck client cannot spam the chat', async (t) => {
  const { call, provider } = await serve(t, { controlOverrides: { sendLimit: 2 } });

  assert.equal((await call('/api/send', { method: 'POST', body: { upcomingOnly: false } })).status, 200);
  assert.equal((await call('/api/send', { method: 'POST', body: { upcomingOnly: false } })).status, 200);

  const third = await call('/api/send', { method: 'POST', body: { upcomingOnly: false } });
  assert.equal(third.status, 429);
  assert.ok(third.payload.retryAfter > 0);
  assert.equal(provider.sent.length, 2, 'the blocked send must never reach WhatsApp');
});

test('the send history records what happened', async (t) => {
  const { call } = await serve(t);
  await call('/api/send', { method: 'POST', body: { dryRun: true, upcomingOnly: false } });

  const { payload } = await call('/api/status');
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].kind, 'send');
  assert.equal(payload.history[0].dryRun, true);
  assert.ok(Date.parse(payload.history[0].at));
});

// --- bad input -------------------------------------------------------------

test('a malformed body is a 400, not a crash', async (t) => {
  const { call } = await serve(t);
  assert.equal((await call('/api/preview', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await call('/api/preview', { method: 'POST', body: '[1,2,3]' })).status, 400);
});

test('an empty body falls back to the configured defaults', async (t) => {
  const { call } = await serve(t);
  assert.equal((await call('/api/preview', { method: 'POST', body: '' })).status, 200);
});

test('an oversized body is rejected rather than buffered', async (t) => {
  const { call } = await serve(t);
  const huge = JSON.stringify({ exclude: Array.from({ length: 20000 }, (_, i) => 'PLAN' + i) });
  const res = await call('/api/preview', { method: 'POST', body: huge }).catch((err) => ({ status: 0, err }));
  assert.ok(res.status === 413 || res.status === 0, `expected rejection, got ${res.status}`);
});

test('an internal failure does not leak a stack trace to the caller', async (t) => {
  const { call, planningSource } = await serve(t);
  planningSource.load = async () => { throw new Error('secret internal detail'); };

  const { status, payload } = await call('/api/planning');
  assert.equal(status, 500);
  assert.equal(payload.error, 'internal_error');
  assert.doesNotMatch(JSON.stringify(payload), /secret internal detail/);
});
