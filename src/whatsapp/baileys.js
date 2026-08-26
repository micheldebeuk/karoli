'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { logger, pinoCompatible } = require('../logger');
const { toJid, describe, isGroup } = require('./jid');

// Loaded lazily: `preview`, `dry-run` and the Cloud API path must work on a
// checkout where the (heavy) Baileys dependency was never installed.
function requireBaileys() {
  try {
    return require('@whiskeysockets/baileys');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      throw Object.assign(
        new Error('@whiskeysockets/baileys is not installed. Run `npm install` first.'),
        { code: 'EDEPMISSING' },
      );
    }
    throw err;
  }
}

const DEFAULT_SEND_DELAY_MS = 900; // be gentle: consecutive sends look less bot-like

function statusCodeOf(error) {
  return (error && error.output && error.output.statusCode) || 0;
}

/**
 * WhatsApp Web (multi-device) transport.
 *
 * Session state lives in cfg.baileys.sessionDir. Those files ARE the linked
 * device — anyone who has them can send as this account, so the directory is
 * gitignored and created 0700.
 */
function createBaileysProvider(cfg) {
  let sock = null;
  let saveCreds = null;
  let openPromise = null;
  let closing = false;
  const messageHandlers = [];

  function ensureSessionDir() {
    fs.mkdirSync(cfg.baileys.sessionDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(cfg.baileys.sessionDir, 0o700);
    } catch {
      /* best effort — a stricter umask elsewhere is not a failure */
    }
  }

  function isRegistered() {
    return fs.existsSync(path.join(cfg.baileys.sessionDir, 'creds.json'));
  }

  /**
   * Open (or reuse) a connection.
   *
   * Two failure modes matter on the VPS and both are handled here rather than
   * left to hang: WhatsApp being unreachable (the socket never reports
   * anything, so a hard timeout is the only way out), and a connection that
   * drops repeatedly (backoff, and give up eventually so pm2 can restart us
   * instead of a tight loop).
   *
   * @param {object} [opts]
   * @param {'qr'|'code'|false} [opts.pairing] how to surface a pairing challenge
   * @param {string} [opts.pairWithNumber] phone number for pairing-code login
   */
  function connect(opts = {}) {
    if (openPromise) return openPromise;
    openPromise = establish(opts, 0);
    // A failed attempt must not poison later calls — clear the cached promise
    // so the next connect() genuinely retries.
    openPromise.catch(() => {
      openPromise = null;
    });
    return openPromise;
  }

  async function establish(opts, attempt) {
    /* eslint-disable-next-line no-param-reassign */
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
      Browsers,
    } = requireBaileys();

    ensureSessionDir();
    const waLogger = pinoCompatible();
    const { state, saveCreds: save } = await useMultiFileAuthState(cfg.baileys.sessionDir);
    saveCreds = save;

    const { version } = await fetchLatestBaileysVersion();
    logger.debug(`Baileys using WhatsApp Web version ${version.join('.')}`);

    const wantsPairingCode = opts.pairing === 'code' && !state.creds.registered;

    sock = makeWASocket({
      version,
      logger: waLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      browser: Browsers.ubuntu(cfg.baileys.deviceName),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);
    wireMessageEvents();

    const connected = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      // A pairing run is human-paced (find the phone, open the menu, type the
      // code), so it gets a much longer leash than an unattended send.
      const budget = opts.pairing ? cfg.baileys.pairTimeoutMs : cfg.baileys.connectTimeoutMs;
      const timer = setTimeout(() => {
        settle(
          reject,
          Object.assign(
            new Error(
              `WhatsApp did not connect within ${Math.round(budget / 1000)}s. ` +
                'The VPS may be unable to reach web.whatsapp.com, or the session may be stale. ' +
                'Check outbound network, then try `npm run status`.',
            ),
            { code: 'ETIMEDOUT' },
          ),
        );
        try {
          sock.end(undefined);
        } catch {
          /* already gone */
        }
      }, budget);
      // Deliberately NOT unref'd: when WhatsApp is unreachable the socket stops
      // holding the event loop open, and an unref'd timer would let node exit 0
      // without ever settling — a failed send that looks like a success.

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && opts.pairing === 'qr') {
          logger.info('Scan this QR in WhatsApp > Linked devices > Link a device:');
          try {
            require('qrcode-terminal').generate(qr, { small: true });
          } catch {
            logger.info(`QR payload (render it yourself): ${qr}`);
          }
        } else if (qr && opts.pairing !== 'code') {
          settle(
            reject,
            Object.assign(
              new Error(
                'WhatsApp is asking to link a device, but this process is not a login run. ' +
                  'Run `npm run login` (or `npm run login -- --pair +34...`) first.',
              ),
              { code: 'EUNLINKED' },
            ),
          );
        }

        if (connection === 'open') {
          const me = sock.user && sock.user.id ? sock.user.id.split(':')[0] : 'unknown';
          logger.info(`WhatsApp connected as +${me}`);
          attempt = 0; // a healthy connection earns a fresh budget of retries
          settle(resolve, sock);
        }

        if (connection === 'close') {
          if (closing) return settle(resolve, null);

          const code = statusCodeOf(lastDisconnect && lastDisconnect.error);
          const reason = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || 'unknown';

          if (code === DisconnectReason.loggedOut) {
            logger.error(
              'WhatsApp session was logged out. Delete the session directory and pair again: ' +
                `rm -rf ${cfg.baileys.sessionDir} && npm run login`,
            );
            return settle(
              reject,
              Object.assign(new Error('WhatsApp session logged out'), { code: 'ELOGGEDOUT' }),
            );
          }

          if (attempt >= cfg.baileys.maxReconnects) {
            return settle(
              reject,
              Object.assign(
                new Error(
                  `WhatsApp connection failed ${attempt + 1} time(s) (last: ${reason}). Giving up so the ` +
                    'process can restart cleanly instead of looping.',
                ),
                { code: 'ECONNFAILED' },
              ),
            );
          }

          const delay = Math.min(2000 * 2 ** attempt, 30_000);
          logger.warn(
            `WhatsApp connection closed (status ${code || 'unknown'}: ${reason}) — ` +
              `reconnecting in ${delay / 1000}s (attempt ${attempt + 1}/${cfg.baileys.maxReconnects}).`,
          );
          await new Promise((r) => setTimeout(r, delay));
          if (closing) return settle(resolve, null);
          try {
            settle(resolve, await establish(opts, attempt + 1));
          } catch (err) {
            settle(reject, err);
          }
        }
      });
    });

    if (wantsPairingCode) {
      if (!opts.pairWithNumber) {
        throw new Error('Pairing-code login needs a phone number: npm run login -- --pair +34600111222');
      }
      const digits = String(opts.pairWithNumber).replace(/[^\d]/g, '');
      // The socket has to finish its handshake before it can mint a code.
      await new Promise((r) => setTimeout(r, 3000));
      const code = await sock.requestPairingCode(digits);
      const pretty = code.match(/.{1,4}/g).join('-');
      logger.info(`Pairing code for +${digits}: ${pretty}`);
      logger.info('Enter it in WhatsApp > Linked devices > Link with phone number. Valid a few minutes.');
    }

    return connected;
  }

  function wireMessageEvents() {
    sock.ev.on('messages.upsert', async (event) => {
      if (event.type !== 'notify') return;
      for (const raw of event.messages || []) {
        const parsed = parseIncoming(raw);
        if (!parsed) continue;
        for (const handler of messageHandlers) {
          try {
            await handler(parsed);
          } catch (err) {
            logger.error('Message handler failed:', err);
          }
        }
      }
    });
  }

  function parseIncoming(raw) {
    if (!raw || !raw.message || !raw.key) return null;
    if (raw.key.fromMe) return null; // never react to our own messages

    const m = raw.message;
    const text =
      m.conversation ||
      (m.extendedTextMessage && m.extendedTextMessage.text) ||
      (m.imageMessage && m.imageMessage.caption) ||
      (m.videoMessage && m.videoMessage.caption) ||
      '';
    if (!text.trim()) return null;

    const chatJid = raw.key.remoteJid;
    return {
      text: text.trim(),
      chatJid,
      senderJid: isGroup(chatJid) ? raw.key.participant || chatJid : chatJid,
      pushName: raw.pushName || '',
      isGroup: isGroup(chatJid),
      raw,
    };
  }

  return {
    name: 'baileys',
    supportsGroups: true,
    supportsIncoming: true,

    isRegistered,
    connect,

    async login({ mode = 'qr', number } = {}) {
      await connect({ pairing: mode, pairWithNumber: number });
      logger.info(`Session saved to ${cfg.baileys.sessionDir}`);
    },

    async send(recipient, text) {
      await connect();
      const jid = toJid(recipient);
      const res = await sock.sendMessage(jid, { text });
      logger.info(`Sent to ${describe(jid)} (${text.length} chars, id ${res && res.key ? res.key.id : '?'})`);
      await new Promise((r) => setTimeout(r, DEFAULT_SEND_DELAY_MS));
      return res;
    },

    /** Reply into the chat a message came from. */
    async reply(incoming, text) {
      await connect();
      return sock.sendMessage(incoming.chatJid, { text }, { quoted: incoming.raw });
    },

    onMessage(handler) {
      messageHandlers.push(handler);
    },

    async listGroups() {
      await connect();
      const groups = await sock.groupFetchAllParticipating();
      return Object.values(groups).map((g) => ({ jid: g.id, subject: g.subject, size: g.size }));
    },

    async whoami() {
      await connect();
      return sock.user || null;
    },

    async close() {
      closing = true;
      if (sock) {
        try {
          // `end()` closes the socket without unlinking the device.
          sock.end(undefined);
        } catch {
          /* already gone */
        }
      }
      sock = null;
      openPromise = null;
    },
  };
}

module.exports = { createBaileysProvider };
