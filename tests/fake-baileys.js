'use strict';

/**
 * A stand-in for @whiskeysockets/baileys that lets a test drive the connection
 * state machine directly: create sockets, emit `connection.update` and
 * `messages.upsert`, and inspect what was sent. No network, no session files.
 */

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeSocket(options) {
  const listeners = new Map();
  const sock = {
    options,
    sent: [],
    ended: false,
    endedWith: undefined,
    pairingRequests: [],
    user: { id: '34600111222:7@s.whatsapp.net' },
    groups: {},

    ev: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
      },
    },

    /**
     * Fire an event the way a real EventEmitter does: dispatch to every handler
     * and return, WITHOUT awaiting them. Awaiting here would deadlock any test
     * that drives a reconnect, because the close handler does not settle until
     * the *next* socket opens — which only the test can make happen.
     * The returned promise just lets pending microtasks run.
     */
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) {
        try {
          const result = handler(payload);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          // An EventEmitter swallows handler errors; tests assert on effects.
        }
      }
      return tick();
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },

    async sendMessage(jid, content, opts) {
      sock.sent.push({ jid, content, opts });
      return { key: { id: `fake-${sock.sent.length}`, remoteJid: jid } };
    },
    async groupFetchAllParticipating() {
      return sock.groups;
    },
    async requestPairingCode(digits) {
      sock.pairingRequests.push(digits);
      return '12345678';
    },
    end(err) {
      sock.ended = true;
      sock.endedWith = err;
    },
  };
  return sock;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.registered] whether the stored creds are already paired
 */
function makeFakeBaileys({ registered = true } = {}) {
  const sockets = [];
  const waiting = new Map();
  const savedCreds = [];

  function makeWASocket(options) {
    const sock = fakeSocket(options);
    sockets.push(sock);
    const index = sockets.length - 1;
    if (waiting.has(index)) {
      waiting.get(index).resolve(sock);
      waiting.delete(index);
    }
    return sock;
  }

  /**
   * Resolves once the Nth socket has been constructed.
   *
   * Rejects rather than hanging if it never is: a provider that stops
   * reconnecting should surface as one clear failure, not as a timed-out test
   * that cancels every test after it.
   */
  function socketAt(index, timeoutMs = 2000) {
    if (sockets[index]) return Promise.resolve(sockets[index]);
    if (!waiting.has(index)) waiting.set(index, deferred());

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `socket #${index} was never created (${sockets.length} so far) — ` +
              'the provider did not open or reconnect as expected',
          ),
        );
      }, timeoutMs);
      waiting.get(index).promise.then((sock) => {
        clearTimeout(timer);
        resolve(sock);
      });
    });
  }

  const mod = {
    default: makeWASocket,
    async useMultiFileAuthState() {
      return {
        state: { creds: { registered }, keys: {} },
        saveCreds: async () => savedCreds.push(true),
      };
    },
    async fetchLatestBaileysVersion() {
      return { version: [2, 3000, 1], isLatest: true };
    },
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401, connectionClosed: 428, restartRequired: 515 },
    Browsers: { ubuntu: (name) => ['Ubuntu', name, '22.04.4'] },
  };

  return { mod, sockets, socketAt, savedCreds };
}

/** Let pending microtasks/timers settle without a fixed sleep. */
async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

/** Shape of a `connection.update` close carrying a Boom-style status code. */
function closeUpdate(statusCode, message = 'socket closed') {
  return {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) },
  };
}

module.exports = { makeFakeBaileys, fakeSocket, tick, closeUpdate };
