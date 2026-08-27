'use strict';

const { logger } = require('../logger');
const { runClaude: defaultRunClaude } = require('./claude');

/**
 * Drains the ask queue, one job per tick.
 *
 * Deliberately slow and serial. Answers are not urgent, and the subscription's
 * limits are shared with the operator's own Claude Code work — so this never
 * runs two questions at once and stops entirely once the daily cap is reached.
 */
function createAskWorker({ cfg, provider, queue, runClaude = defaultRunClaude, now = () => Date.now() }) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function replyTo(job, text) {
    // Reply into the chat the question came from, quoting it when we still can.
    const incoming = {
      chatJid: job.chatJid,
      raw: job.messageId ? { key: { remoteJid: job.chatJid, id: job.messageId } } : undefined,
    };
    if (incoming.raw) await provider.reply(incoming, text);
    else await provider.send(job.chatJid, text);
  }

  // Measure the note rather than reserving a guessed number of characters —
  // guessing is how a "trimmed" answer ends up longer than the cap it enforces.
  const TRIM_NOTE = '\n\n_(respuesta recortada)_';

  function trim(text) {
    const max = cfg.ask.maxAnswerChars;
    if (text.length <= max) return text;
    const room = Math.max(0, max - TRIM_NOTE.length);
    return `${text.slice(0, room).trimEnd()}${TRIM_NOTE}`;
  }

  async function handleFailure(job, err) {
    // A rate limit is not an error here — it is the expected steady state of a
    // subscription-backed bot. Wait for the window and keep the job.
    if (err.code === 'ERATELIMIT') {
      const wait = 30 * 60_000;
      const { gaveUp } = queue.fail(job, { error: err.message, retryAfterMs: wait });
      logger.info(`Rate limited; retrying "${job.id}" in ${wait / 60000} min.`);
      return gaveUp;
    }

    if (err.code === 'EAUTH') {
      // Nothing will fix itself; do not burn attempts retrying.
      queue.complete(job, { ok: false, error: err.message, gaveUp: true });
      logger.error(
        'Claude Code is not authenticated on this machine. Run `claude setup-token` as the bot user, ' +
          'then check `claude auth status` says "oauth_token".',
      );
      await replyTo(job, '🔌 No puedo responder: el bot no está conectado a Claude. Avisa a Olivier.').catch(() => {});
      return true;
    }

    const { gaveUp, retryInMs } = queue.fail(job, { error: err.message });
    if (gaveUp) {
      logger.error(`Giving up on "${job.id}" after ${job.attempts + 1} attempts: ${err.message}`);
      await replyTo(job, '😵 No he conseguido responder a eso. Inténtalo otra vez.').catch(() => {});
    } else {
      logger.warn(`"${job.id}" failed (${err.code}); retrying in ${Math.round(retryInMs / 60000)} min.`);
    }
    return gaveUp;
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const answeredToday = queue.completedSince(24 * 3600_000, now());
      if (answeredToday >= cfg.ask.dailyLimit) {
        logger.debug(`Daily cap reached (${answeredToday}/${cfg.ask.dailyLimit}); idling.`);
        return;
      }

      const job = queue.claimNext(now());
      if (!job) return;

      logger.info(`Asking Claude for "${job.id}" (attempt ${job.attempts + 1}).`);
      try {
        const { text } = await runClaude(cfg, { question: job.question, sessionId: job.sessionId });
        await replyTo(job, trim(text));
        queue.complete(job, { ok: true, chars: text.length });
        logger.info(`Answered "${job.id}" (${text.length} chars).`);
      } catch (err) {
        await handleFailure(job, err);
      }
    } catch (err) {
      logger.error('Ask worker tick failed:', err);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => {
        tick().catch((err) => logger.error('Ask worker:', err));
      }, cfg.ask.tickMs);
      if (typeof timer.unref === 'function') timer.unref();
      logger.info(
        `Ask worker running: every ${Math.round(cfg.ask.tickMs / 1000)}s, ` +
          `model ${cfg.ask.model}, cap ${cfg.ask.dailyLimit}/day.`,
      );
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createAskWorker };
