'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { logger } = require('../logger');

/**
 * Runs Claude Code headless (`claude -p`) and returns the answer text.
 *
 * Billing: this deliberately uses the operator's Claude SUBSCRIPTION, not the
 * API. `claude setup-token` establishes an OAuth credential ("requires Claude
 * subscription" per its own help). Two things would silently switch it to
 * per-token API billing, so both are guarded here:
 *   * an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment can shadow
 *     the OAuth credential — they are stripped from the child's env;
 *   * `--bare` reads only an API key and never OAuth — it is never passed.
 * Verify on the box with `claude auth status`: it must say "oauth_token".
 *
 * Tools: none. Anyone who can message the number puts text in front of this,
 * so the model gets no Bash, no filesystem, no network. A questions-and-answers
 * bot does not need them and their absence removes the whole injection class.
 */

// A UUID per chat, so each WhatsApp thread is one continuing Claude conversation.
function sessionIdFor(chatJid) {
  const h = crypto.createHash('sha1').update(`planes:${chatJid}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,                                        // version 5
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + h.slice(18, 20), // variant
    h.slice(20, 32),
  ].join('-');
}

const RATE_LIMIT_RE = /(rate.?limit|usage limit|limit reached|too many requests|resets? at|try again later)/i;
const AUTH_RE = /(not logged in|authentication|unauthorized|invalid api key|please run.*login|setup-token)/i;

function childEnv(cfg) {
  const env = { ...process.env };
  // Never let a stray key move this off the subscription.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

function buildArgs(cfg, { question, sessionId }) {
  return [
    '-p', question,
    '--output-format', 'json',
    '--model', cfg.ask.model,
    '--session-id', sessionId,
    '--allowedTools', '',              // no tools at all
    '--permission-mode', 'manual',     // and nothing may be granted at runtime
    '--append-system-prompt', cfg.ask.systemPrompt,
  ];
}

/** Pull the answer text out of `--output-format json`. */
function extractText(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.result === 'string') return parsed.result;
    if (parsed && Array.isArray(parsed.content)) {
      return parsed.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    }
    if (parsed && typeof parsed.text === 'string') return parsed.text;
    return '';
  } catch {
    return raw; // not JSON after all — treat it as the answer
  }
}

function classify(err, stderr) {
  const text = `${stderr || ''} ${err && err.message ? err.message : ''}`;
  if (err && err.killed) return { code: 'ETIMEOUT' };
  if (RATE_LIMIT_RE.test(text)) return { code: 'ERATELIMIT' };
  if (AUTH_RE.test(text)) return { code: 'EAUTH' };
  return { code: 'ECLAUDE' };
}

function runClaude(cfg, { question, sessionId }) {
  fs.mkdirSync(cfg.ask.workDir, { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    execFile(
      cfg.ask.bin,
      buildArgs(cfg, { question, sessionId }),
      {
        cwd: cfg.ask.workDir, // an empty scratch dir: nothing of yours is in reach
        env: childEnv(cfg),
        timeout: cfg.ask.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        if (err) {
          const { code } = classify(err, stderr);
          const message = String(stderr || err.message || '').trim().slice(0, 500);
          logger.warn(`claude -p failed (${code}): ${message}`);
          return reject(Object.assign(new Error(message || `claude failed (${code})`), { code }));
        }
        const text = extractText(stdout).trim();
        if (!text) {
          return reject(Object.assign(new Error('claude returned an empty answer'), { code: 'EEMPTY' }));
        }
        resolve({ text, sessionId });
      },
    );
  });
}

module.exports = { runClaude, sessionIdFor, extractText, classify, buildArgs, childEnv };
