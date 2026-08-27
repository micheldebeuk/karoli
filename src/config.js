'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// Node >= 21.7 can read .env natively. Do it once, and never let a missing file
// be fatal — on the VPS the values may come from the pm2 env instead.
function loadEnvFile() {
  const file = process.env.PLANES_ENV_FILE || path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return null;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
    return file;
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return file;
}

const PROVIDERS = ['baileys', 'cloud', 'dry-run'];
const SOURCES = ['fixture', 'pushed', 'google-sheets'];

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function list(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * "+34600111222=Olivier,+34600333444=Karina" -> { '34600111222': 'Olivier', ... }
 * Keyed on digits only so it matches whatever JID form WhatsApp hands back.
 */
function parseVoters(raw) {
  const map = {};
  for (const entry of String(raw || '').split(',')) {
    const [who, name] = entry.split('=');
    if (!who || !name) continue;
    const digits = who.replace(/[^\d]/g, '');
    if (digits) map[digits] = name.trim();
  }
  return map;
}

function load() {
  const envFile = loadEnvFile();

  const provider = String(process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
  const source = String(process.env.PLANNING_SOURCE || 'fixture').trim().toLowerCase();

  const cfg = {
    root: ROOT,
    envFile,
    dryRun: bool('DRY_RUN', false),
    timezone: process.env.TZ || 'Europe/Madrid',
    upcomingOnly: bool('PLANNING_UPCOMING_ONLY', true),
    recipients: list('WHATSAPP_RECIPIENTS'),
    voters: parseVoters(process.env.PLANNING_VOTERS),
    provider,
    baileys: {
      sessionDir: path.resolve(ROOT, process.env.WHATSAPP_SESSION_DIR || './data/wa-session'),
      deviceName: process.env.WHATSAPP_DEVICE_NAME || 'Planes Bot',
      // An unattended send must fail loudly rather than hang forever under pm2.
      connectTimeoutMs: int('WHATSAPP_CONNECT_TIMEOUT_MS', 60_000),
      // A login is human-paced: find the phone, open the menu, type the code.
      pairTimeoutMs: int('WHATSAPP_PAIR_TIMEOUT_MS', 240_000),
      maxReconnects: int('WHATSAPP_MAX_RECONNECTS', 5),
      // Reconnect backoff doubles from here, capped at 30s.
      reconnectBaseMs: int('WHATSAPP_RECONNECT_BASE_MS', 2000),
      // Grace period before asking for a pairing code, so the socket can finish
      // its handshake first.
      pairHandshakeMs: int('WHATSAPP_PAIR_HANDSHAKE_MS', 3000),
      // Pause between consecutive sends so a burst looks less bot-like.
      sendDelayMs: int('WHATSAPP_SEND_DELAY_MS', 900),
    },
    cloud: {
      token: process.env.WA_CLOUD_TOKEN || '',
      phoneNumberId: process.env.WA_CLOUD_PHONE_NUMBER_ID || '',
      apiVersion: process.env.WA_CLOUD_API_VERSION || 'v21.0',
      templateName: process.env.WA_CLOUD_TEMPLATE_NAME || '',
      templateLang: process.env.WA_CLOUD_TEMPLATE_LANG || 'es',
    },
    control: {
      enabled: bool('PLANES_CONTROL_ENABLED', false),
      // Loopback by default: the token is the only credential, so it must not
      // cross a public interface without TLS in front.
      host: process.env.PLANES_CONTROL_HOST || '127.0.0.1',
      port: int('PLANES_CONTROL_PORT', 3010),
      token: process.env.PLANES_CONTROL_TOKEN || '',
      sendLimit: int('PLANES_CONTROL_SEND_LIMIT', 6),
      sendWindowMs: int('PLANES_CONTROL_SEND_WINDOW_MS', 15 * 60 * 1000),
      // `dispatch` waits on a real WhatsApp send, so give it room.
      dispatchTimeoutMs: int('PLANES_CONTROL_DISPATCH_TIMEOUT_MS', 120_000),
    },
    // Route A: answers written by Claude Code running headless on the VPS,
    // authenticated with the operator's subscription (claude setup-token), not
    // an API key.
    ask: {
      enabled: bool('PLANES_ASK_ENABLED', false),
      bin: process.env.PLANES_ASK_CLAUDE_BIN || 'claude',
      model: process.env.PLANES_ASK_MODEL || 'sonnet',
      // In a group the bot must not answer every message, so it needs naming.
      // A one-to-one chat with a known voter needs no prefix.
      prefix: (process.env.PLANES_ASK_PREFIX || 'claude').trim().toLowerCase(),
      requirePrefixInDirect: bool('PLANES_ASK_PREFIX_IN_DIRECT', false),
      queueDir: path.resolve(ROOT, process.env.PLANES_ASK_QUEUE_DIR || './data/ask-queue'),
      workDir: path.resolve(ROOT, process.env.PLANES_ASK_WORK_DIR || './data/ask-workdir'),
      tickMs: int('PLANES_ASK_TICK_MS', 30_000),
      timeoutMs: int('PLANES_ASK_TIMEOUT_MS', 300_000),
      maxAttempts: int('PLANES_ASK_MAX_ATTEMPTS', 6),
      // Usage comes out of the same subscription pool as the operator's own
      // Claude Code work, so cap how much the chat can spend.
      dailyLimit: int('PLANES_ASK_DAILY_LIMIT', 25),
      maxQuestionChars: int('PLANES_ASK_MAX_QUESTION_CHARS', 1500),
      maxAnswerChars: int('PLANES_ASK_MAX_ANSWER_CHARS', 1200),
      systemPrompt: process.env.PLANES_ASK_SYSTEM_PROMPT
        || 'Eres un asistente en un chat de WhatsApp sobre planes de fin de semana en Barcelona. '
        + 'Responde en el idioma del mensaje, de forma breve y concreta. Sin markdown de titulos ni listas largas.',
    },
    planning: {
      source,
      fixtureFile: path.resolve(ROOT, process.env.PLANNING_FIXTURE || './fixtures/planning.json'),
      sheetId: process.env.PLANNING_SHEET_ID || '',
      sheetRange: process.env.PLANNING_SHEET_RANGE || 'A1:M',
      // Where PLANNING_SOURCE=pushed keeps the last planning a Routine sent.
      pushedFile: path.resolve(ROOT, process.env.PLANNING_PUSHED_FILE || './data/planning-pushed.json'),
    },
  };

  return cfg;
}

// Validation is separate from loading so `preview` can run on a bare checkout
// while `send` insists on a fully configured transport.
function validateForSend(cfg) {
  const errors = [];

  if (!PROVIDERS.includes(cfg.provider)) {
    errors.push(`WHATSAPP_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${cfg.provider}")`);
  }
  if (!SOURCES.includes(cfg.planning.source)) {
    errors.push(`PLANNING_SOURCE must be one of ${SOURCES.join(', ')} (got "${cfg.planning.source}")`);
  }
  if (cfg.recipients.length === 0) {
    errors.push('WHATSAPP_RECIPIENTS is empty — nobody would receive the planning.');
  }
  if (cfg.provider === 'cloud') {
    if (!cfg.cloud.token) errors.push('WA_CLOUD_TOKEN is required when WHATSAPP_PROVIDER=cloud');
    if (!cfg.cloud.phoneNumberId) {
      errors.push('WA_CLOUD_PHONE_NUMBER_ID is required when WHATSAPP_PROVIDER=cloud');
    }
    const groups = cfg.recipients.filter((r) => r.endsWith('@g.us'));
    if (groups.length) {
      errors.push(
        `The Cloud API cannot post to groups, but WHATSAPP_RECIPIENTS contains ${groups.join(', ')}. ` +
          'Use WHATSAPP_PROVIDER=baileys for group delivery.',
      );
    }
  }

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    err.code = 'ECONFIG';
    throw err;
  }
  return cfg;
}

module.exports = { load, validateForSend, PROVIDERS, SOURCES, ROOT };
