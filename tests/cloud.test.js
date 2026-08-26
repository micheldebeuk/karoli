'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { logger } = require('../src/logger');
logger.setLevel('silent'); // the provider logs every send; keep the test output readable

const { createCloudProvider } = require('../src/whatsapp/cloud');

const CFG = {
  cloud: {
    token: 'EAA-test-token',
    phoneNumberId: '1234567890',
    apiVersion: 'v21.0',
    templateName: 'planes_fin_de_semana',
    templateLang: 'es',
  },
};

function cfg(overrides = {}) {
  return { cloud: { ...CFG.cloud, ...overrides } };
}

/** Queue of canned responses; records every request the provider makes. */
function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected extra fetch to ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => {
        if (next.invalidJson) throw new SyntaxError('Unexpected token < in JSON');
        return next.body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const OK = { status: 200, body: { messages: [{ id: 'wamid.TEST' }] } };
const outsideWindow = (code) => ({
  status: 400,
  body: { error: { message: 'Message failed to send outside the 24 hour window', code } },
});

test('posts a text message to the right endpoint with the right payload', async (t) => {
  const f = fakeFetch([OK]);
  t.mock.method(globalThis, 'fetch', f);

  const res = await createCloudProvider(cfg()).send('+34 600 11 12 22', 'hola\nmundo');

  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer EAA-test-token');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '34600111222', // normalised from the spaced, +-prefixed form
    type: 'text',
    text: { preview_url: true, body: 'hola\nmundo' }, // newlines survive in free-form
  });
  assert.equal(res.messages[0].id, 'wamid.TEST');
});

test('honours a non-default API version', async (t) => {
  const f = fakeFetch([OK]);
  t.mock.method(globalThis, 'fetch', f);
  await createCloudProvider(cfg({ apiVersion: 'v23.0' })).send('+34600111222', 'x');
  assert.match(f.calls[0].url, /\/v23\.0\/1234567890\/messages$/);
});

test('refuses a group recipient before making any request', async (t) => {
  const f = fakeFetch([]);
  t.mock.method(globalThis, 'fetch', f);

  await assert.rejects(
    () => createCloudProvider(cfg()).send('120363000000000000@g.us', 'hola'),
    /cannot post to groups/,
  );
  assert.equal(f.calls.length, 0, 'must not hit the API at all');
});

test('an error that is not a closed window propagates, with no template fallback', async (t) => {
  const f = fakeFetch([
    { status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } },
  ]);
  t.mock.method(globalThis, 'fetch', f);

  await assert.rejects(() => createCloudProvider(cfg()).send('+34600111222', 'hola'), (err) => {
    assert.match(err.message, /Cloud API 401: Invalid OAuth access token/);
    assert.equal(err.status, 401);
    assert.equal(err.apiCode, 190);
    return true;
  });
  assert.equal(f.calls.length, 1, 'a bad token must not trigger a template retry');
});

test('falls back to a template when the 24h window is closed', async (t) => {
  const f = fakeFetch([outsideWindow(131047), OK]);
  t.mock.method(globalThis, 'fetch', f);

  const res = await createCloudProvider(cfg()).send('+34600111222', '*Planes*\n\nE1 · Caldetes\n🕒 09:30');

  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.type, 'text');
  assert.deepEqual(f.calls[1].body, {
    messaging_product: 'whatsapp',
    to: '34600111222',
    type: 'template',
    template: {
      name: 'planes_fin_de_semana',
      language: { code: 'es' },
      // Newlines are illegal in template variables — they must be flattened.
      components: [{ type: 'body', parameters: [{ type: 'text', text: '*Planes* · E1 · Caldetes · 🕒 09:30' }] }],
    },
  });
  assert.equal(res.messages[0].id, 'wamid.TEST');
});

test('every window-closed error code triggers the fallback', async (t) => {
  for (const code of [131047, 131026, 470]) {
    const f = fakeFetch([outsideWindow(code), OK]);
    t.mock.method(globalThis, 'fetch', f);
    await createCloudProvider(cfg()).send('+34600111222', 'hola');
    assert.equal(f.calls.length, 2, `code ${code} should have retried as a template`);
    assert.equal(f.calls[1].body.type, 'template', `code ${code}`);
    t.mock.restoreAll();
  }
});

test('a flattened template variable never carries a newline or tab', async (t) => {
  const f = fakeFetch([outsideWindow(131047), OK]);
  t.mock.method(globalThis, 'fetch', f);

  await createCloudProvider(cfg()).send('+34600111222', 'a\n\n  b\tc   d\n');

  const text = f.calls[1].body.template.components[0].parameters[0].text;
  assert.doesNotMatch(text, /[\n\t]/);
  assert.equal(text, 'a · b c d');
});

test('flattening leaves no separator dangling at either end', async (t) => {
  const cases = [
    ['\n\nhola\n\n', 'hola'],
    ['\n', ''],
    ['*Planes*\n\nE1\n', '*Planes* · E1'],
    ['\tsangria\t', 'sangria'],
  ];
  for (const [input, expected] of cases) {
    const f = fakeFetch([outsideWindow(131047), OK]);
    t.mock.method(globalThis, 'fetch', f);
    await createCloudProvider(cfg()).send('+34600111222', input);
    assert.equal(
      f.calls[1].body.template.components[0].parameters[0].text,
      expected,
      JSON.stringify(input),
    );
    t.mock.restoreAll();
  }
});

test('a template variable is capped so Meta does not reject it for length', async (t) => {
  const f = fakeFetch([outsideWindow(131047), OK]);
  t.mock.method(globalThis, 'fetch', f);

  await createCloudProvider(cfg()).send('+34600111222', 'x'.repeat(5000));

  assert.equal(f.calls[1].body.template.components[0].parameters[0].text.length, 900);
});

test('without a configured template the failure explains the way out', async (t) => {
  const f = fakeFetch([outsideWindow(131047)]);
  t.mock.method(globalThis, 'fetch', f);

  await assert.rejects(
    () => createCloudProvider(cfg({ templateName: '' })).send('+34600111222', 'hola'),
    (err) => {
      assert.match(err.message, /outside the 24h window/);
      assert.match(err.message, /WA_CLOUD_TEMPLATE_NAME is not set/);
      assert.match(err.message, /baileys/); // points at the transport that would work
      assert.ok(err.cause, 'keeps the original API error attached');
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
});

test('a failure inside the template retry is not swallowed', async (t) => {
  const f = fakeFetch([
    outsideWindow(131047),
    { status: 400, body: { error: { message: 'Template name does not exist', code: 132001 } } },
  ]);
  t.mock.method(globalThis, 'fetch', f);

  await assert.rejects(
    () => createCloudProvider(cfg()).send('+34600111222', 'hola'),
    /Template name does not exist/,
  );
});

test('an HTML error page instead of JSON still yields a readable error', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeFetch([{ status: 502, invalidJson: true }]));

  await assert.rejects(
    () => createCloudProvider(cfg()).send('+34600111222', 'hola'),
    /Cloud API 502: unknown error/,
  );
});

test('isRegistered reflects whether the credentials are present', () => {
  assert.equal(createCloudProvider(cfg()).isRegistered(), true);
  assert.equal(createCloudProvider(cfg({ token: '' })).isRegistered(), false);
  assert.equal(createCloudProvider(cfg({ phoneNumberId: '' })).isRegistered(), false);
});

test('the inbound half says plainly that it is not supported', async () => {
  const p = createCloudProvider(cfg());
  assert.equal(p.supportsIncoming, false);
  assert.equal(p.supportsGroups, false);
  assert.equal(await p.connect(), null);
  assert.throws(() => p.onMessage(() => {}), /webhook/);
  await assert.rejects(() => p.reply({}, 'x'), /webhook/);
  await assert.rejects(() => p.listGroups(), /no notion of groups/);
});
