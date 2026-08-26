'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logger } = require('../src/logger');
logger.setLevel('silent');

const { createBaileysProvider } = require('../src/whatsapp/baileys');
const { makeFakeBaileys, tick, closeUpdate } = require('./fake-baileys');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'planes-baileys-'));

function cfg(overrides = {}) {
  return {
    baileys: {
      sessionDir: path.join(TMP, `s${Math.random().toString(36).slice(2)}`),
      deviceName: 'Planes Bot',
      connectTimeoutMs: 250,
      pairTimeoutMs: 250,
      maxReconnects: 3,
      reconnectBaseMs: 1,
      pairHandshakeMs: 1,
      sendDelayMs: 0,
      ...overrides,
    },
  };
}

/** Build a provider on the fake client, ready to be driven by the test. */
function harness(overrides = {}, fakeOpts = {}) {
  const fake = makeFakeBaileys(fakeOpts);
  const provider = createBaileysProvider(cfg(overrides), { baileys: fake.mod });
  return { provider, ...fake };
}

// --- connecting -----------------------------------------------------------

test('connect resolves once the socket reports open', async () => {
  const { provider, socketAt } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });

  assert.equal(await connecting, sock);
  assert.deepEqual(await provider.whoami(), sock.user);
  await provider.close();
});

test('the socket is built with the configured device name and no terminal QR', async () => {
  const { provider, socketAt } = harness({ deviceName: 'Karolito Bot' });

  provider.connect();
  const sock = await socketAt(0);

  assert.deepEqual(sock.options.browser, ['Ubuntu', 'Karolito Bot', '22.04.4']);
  assert.equal(sock.options.printQRInTerminal, false);
  assert.equal(sock.options.syncFullHistory, false);
  assert.ok(sock.listenerCount('creds.update') >= 1, 'credential updates must be persisted');

  await sock.emit('connection.update', { connection: 'open' });
  await provider.close();
});

test('a second connect reuses the live socket instead of opening another', async () => {
  const { provider, socketAt, sockets } = harness();

  const first = provider.connect();
  const sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await first;

  await provider.connect();
  await tick();
  assert.equal(sockets.length, 1);
  await provider.close();
});

// --- sending --------------------------------------------------------------

test('send connects, then delivers to the normalised JID', async () => {
  const { provider, socketAt } = harness();

  const sending = provider.send('+34 600 11 12 22', 'hola');
  const sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await sending;

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, '34600111222@s.whatsapp.net');
  assert.deepEqual(sock.sent[0].content, { text: 'hola' });
  await provider.close();
});

test('send posts to a group JID untouched', async () => {
  const { provider, socketAt } = harness();

  const sending = provider.send('120363000000000000@g.us', 'planes');
  const sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await sending;

  assert.equal(sock.sent[0].jid, '120363000000000000@g.us');
  await provider.close();
});

test('reply quotes the message it is answering', async () => {
  const { provider, socketAt } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await connecting;

  const raw = { key: { remoteJid: '120363000000000000@g.us', id: 'ABC' } };
  await provider.reply({ chatJid: '120363000000000000@g.us', raw }, 'vale');

  assert.equal(sock.sent[0].jid, '120363000000000000@g.us');
  assert.equal(sock.sent[0].opts.quoted, raw);
  await provider.close();
});

test('listGroups reports the JIDs needed for WHATSAPP_RECIPIENTS', async () => {
  const { provider, socketAt } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  sock.groups = { '120363000000000000@g.us': { id: '120363000000000000@g.us', subject: 'Karolito', size: 3 } };
  await sock.emit('connection.update', { connection: 'open' });
  await connecting;

  assert.deepEqual(await provider.listGroups(), [
    { jid: '120363000000000000@g.us', subject: 'Karolito', size: 3 },
  ]);
  await provider.close();
});

// --- pairing --------------------------------------------------------------

test('a QR outside a login run fails loudly instead of waiting forever', async () => {
  const { provider, socketAt } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  await sock.emit('connection.update', { qr: 'qr-payload' });

  await assert.rejects(connecting, (err) => {
    assert.equal(err.code, 'EUNLINKED');
    assert.match(err.message, /npm run login/);
    return true;
  });
  await provider.close();
});

test('a QR during a login run is surfaced, not treated as a failure', async () => {
  const { provider, socketAt } = harness();

  const logging = provider.login({ mode: 'qr' });
  const sock = await socketAt(0);
  await sock.emit('connection.update', { qr: 'qr-payload' });
  await tick();
  await sock.emit('connection.update', { connection: 'open' });

  await logging; // resolves rather than rejecting on the QR
  await provider.close();
});

test('a pairing-code login asks for a code with digits only', async () => {
  const { provider, socketAt } = harness({}, { registered: false });

  const logging = provider.login({ mode: 'code', number: '+34 600 11 12 22' });
  const sock = await socketAt(0);
  await tick(5);
  await sock.emit('connection.update', { connection: 'open' });
  await logging;

  assert.deepEqual(sock.pairingRequests, ['34600111222']);
  await provider.close();
});

test('an already-registered session does not ask for a new pairing code', async () => {
  const { provider, socketAt } = harness({}, { registered: true });

  const logging = provider.login({ mode: 'code', number: '+34600111222' });
  const sock = await socketAt(0);
  await tick(5);
  await sock.emit('connection.update', { connection: 'open' });
  await logging;

  assert.deepEqual(sock.pairingRequests, []);
  await provider.close();
});

// --- failure handling -----------------------------------------------------

test('a logged-out session says how to recover and does not retry', async () => {
  const { provider, socketAt, sockets } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  await sock.emit('connection.update', closeUpdate(401, 'logged out'));

  await assert.rejects(connecting, (err) => {
    assert.equal(err.code, 'ELOGGEDOUT');
    return true;
  });
  await tick();
  assert.equal(sockets.length, 1, 'a logged-out session must not be retried');
  await provider.close();
});

test('a transient close reconnects and the connect still resolves', async () => {
  const { provider, socketAt, sockets } = harness();

  const connecting = provider.connect();
  const first = await socketAt(0);
  await first.emit('connection.update', closeUpdate(428, 'connection closed'));

  const second = await socketAt(1);
  await second.emit('connection.update', { connection: 'open' });

  assert.equal(await connecting, second);
  assert.equal(sockets.length, 2);
  await provider.close();
});

test('repeated failures give up so pm2 can restart instead of looping', async () => {
  const { provider, socketAt, sockets } = harness({ maxReconnects: 2 });

  const connecting = provider.connect();
  for (let i = 0; i <= 2; i += 1) {
    const sock = await socketAt(i);
    await sock.emit('connection.update', closeUpdate(428, 'boom'));
  }

  await assert.rejects(connecting, (err) => {
    assert.equal(err.code, 'ECONNFAILED');
    assert.match(err.message, /Giving up/);
    return true;
  });
  assert.equal(sockets.length, 3, 'one initial attempt plus maxReconnects retries');
  await provider.close();
});

test('a healthy connection earns a fresh retry budget', async () => {
  // Without the counter reset on open, a long-running `listen` would exhaust
  // its retries over its lifetime and stop reconnecting after a few drops.
  const { provider, socketAt, sockets } = harness({ maxReconnects: 2 });

  const connecting = provider.connect();
  let sock = await socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await connecting;

  for (let i = 1; i <= 4; i += 1) {
    await sock.emit('connection.update', closeUpdate(428, 'dropped'));
    sock = await socketAt(i);
    await sock.emit('connection.update', { connection: 'open' });
  }

  assert.equal(sockets.length, 5, 'each successful open should reset the budget');
  await provider.close();
});

test('an unreachable WhatsApp times out with a readable error and ends the socket', async () => {
  const { provider, socketAt } = harness({ connectTimeoutMs: 60 });

  const connecting = provider.connect();
  const sock = await socketAt(0);

  await assert.rejects(connecting, (err) => {
    assert.equal(err.code, 'ETIMEDOUT');
    assert.match(err.message, /did not connect within 60s|did not connect within 0s/);
    assert.match(err.message, /web\.whatsapp\.com/);
    return true;
  });
  assert.equal(sock.ended, true, 'the dead socket must be closed, not leaked');
  await provider.close();
});

test('a failed connect does not poison the next one', async () => {
  const { provider, socketAt } = harness({ connectTimeoutMs: 60 });

  await assert.rejects(provider.connect(), (err) => err.code === 'ETIMEDOUT');

  // A later attempt must build a fresh socket rather than return the rejection.
  const connecting = provider.connect();
  const second = await socketAt(1);
  await second.emit('connection.update', { connection: 'open' });
  assert.equal(await connecting, second);
  await provider.close();
});

test('closing during a reconnect does not raise', async () => {
  const { provider, socketAt } = harness();

  const connecting = provider.connect();
  const sock = await socketAt(0);
  await provider.close();
  await sock.emit('connection.update', closeUpdate(428, 'closed while shutting down'));

  assert.equal(await connecting, null);
});

// --- inbound --------------------------------------------------------------

function upsert(messages) {
  return { type: 'notify', messages };
}

async function connected(overrides) {
  const h = harness(overrides);
  const connecting = h.provider.connect();
  const sock = await h.socketAt(0);
  await sock.emit('connection.update', { connection: 'open' });
  await connecting;
  return { ...h, sock };
}

test('an incoming direct message reaches the handler', async () => {
  const { provider, sock } = await connected();
  const seen = [];
  provider.onMessage((m) => seen.push(m));

  await sock.emit(
    'messages.upsert',
    upsert([
      {
        key: { remoteJid: '34600333444@s.whatsapp.net', fromMe: false, id: 'A' },
        message: { conversation: '  PLANES  ' },
        pushName: 'Karina',
      },
    ]),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'PLANES');
  assert.equal(seen[0].senderJid, '34600333444@s.whatsapp.net');
  assert.equal(seen[0].isGroup, false);
  assert.equal(seen[0].pushName, 'Karina');
  await provider.close();
});

test('in a group the participant is the sender, not the group', async () => {
  const { provider, sock } = await connected();
  const seen = [];
  provider.onMessage((m) => seen.push(m));

  await sock.emit(
    'messages.upsert',
    upsert([
      {
        key: {
          remoteJid: '120363000000000000@g.us',
          participant: '34600111222@s.whatsapp.net',
          fromMe: false,
          id: 'B',
        },
        message: { extendedTextMessage: { text: 'E1 SI' } },
      },
    ]),
  );

  assert.equal(seen[0].isGroup, true);
  assert.equal(seen[0].chatJid, '120363000000000000@g.us');
  assert.equal(seen[0].senderJid, '34600111222@s.whatsapp.net');
  assert.equal(seen[0].text, 'E1 SI');
  await provider.close();
});

test('the bot never reacts to its own messages, empty bodies or history syncs', async () => {
  const { provider, sock } = await connected();
  const seen = [];
  provider.onMessage((m) => seen.push(m));

  await sock.emit(
    'messages.upsert',
    upsert([
      { key: { remoteJid: 'x@s.whatsapp.net', fromMe: true }, message: { conversation: 'PLANES' } },
      { key: { remoteJid: 'x@s.whatsapp.net', fromMe: false }, message: { conversation: '   ' } },
      { key: { remoteJid: 'x@s.whatsapp.net', fromMe: false }, message: {} },
      { key: { remoteJid: 'x@s.whatsapp.net', fromMe: false } },
    ]),
  );
  // `append` is a history backfill, not a live message.
  await sock.emit('messages.upsert', {
    type: 'append',
    messages: [{ key: { remoteJid: 'x@s.whatsapp.net', fromMe: false }, message: { conversation: 'PLANES' } }],
  });

  assert.deepEqual(seen, []);
  await provider.close();
});

test('an image caption counts as a command', async () => {
  const { provider, sock } = await connected();
  const seen = [];
  provider.onMessage((m) => seen.push(m));

  await sock.emit(
    'messages.upsert',
    upsert([
      {
        key: { remoteJid: 'x@s.whatsapp.net', fromMe: false },
        message: { imageMessage: { caption: 'AYUDA' } },
      },
    ]),
  );

  assert.equal(seen[0].text, 'AYUDA');
  await provider.close();
});

test('one throwing handler does not stop the others', async () => {
  const { provider, sock } = await connected();
  const seen = [];
  provider.onMessage(() => {
    throw new Error('handler blew up');
  });
  provider.onMessage((m) => seen.push(m.text));

  await sock.emit(
    'messages.upsert',
    upsert([{ key: { remoteJid: 'x@s.whatsapp.net', fromMe: false }, message: { conversation: 'PLANES' } }]),
  );

  assert.deepEqual(seen, ['PLANES']);
  await provider.close();
});

// --- session state --------------------------------------------------------

test('isRegistered follows the presence of creds.json', () => {
  const sessionDir = path.join(TMP, 'registered-check');
  const { provider } = harness({ sessionDir });

  assert.equal(provider.isRegistered(), false);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{}');
  assert.equal(provider.isRegistered(), true);
});

test('the session directory is created private — it is a credential', async () => {
  const sessionDir = path.join(TMP, 'perms-check');
  const { provider, socketAt } = harness({ sessionDir });

  provider.connect();
  await socketAt(0);

  assert.equal(fs.statSync(sessionDir).mode & 0o777, 0o700);
  await provider.close();
});
