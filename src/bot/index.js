'use strict';

const { logger } = require('../logger');
const { renderPlanning, renderPlan } = require('../format');
const { parseCommand, HELP_TEXT } = require('./commands');
const { sessionIdFor } = require('../ask/claude');

/**
 * The interactive half: listens on the WhatsApp socket and answers commands.
 * It keeps no state of its own — every answer is derived from the planning
 * source, so a restart loses nothing.
 */
function createBot({ cfg, provider, planningSource, askQueue = null }) {
  if (!provider.supportsIncoming) {
    throw new Error(
      `The "${provider.name}" provider cannot receive messages. Use WHATSAPP_PROVIDER=baileys to run the bot.`,
    );
  }

  // Cache the planning briefly so a burst of replies in a group does not hit
  // the source once per message.
  let cached = null;
  let cachedAt = 0;
  const CACHE_MS = 60_000;

  async function loadPlanning({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && cached && now - cachedAt < CACHE_MS) return cached;
    cached = await planningSource.load();
    cachedAt = now;
    return cached;
  }

  function voterName(senderJid) {
    const digits = String(senderJid || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
    return cfg.voters[digits] || null;
  }

  /**
   * Decide whether a non-command message is a question for Claude.
   *
   * In a group the bot must be named — otherwise it would answer every message
   * in the chat. A one-to-one chat with a known voter needs no prefix, since
   * everything said there is addressed to the bot anyway.
   *
   * @returns {string|null} the question text, or null to stay quiet
   */
  function questionFrom(incoming) {
    if (!askQueue || !cfg.ask.enabled) return null;
    if (!voterName(incoming.senderJid)) return null; // never answer strangers

    const text = incoming.text.trim();
    const needsPrefix = incoming.isGroup || cfg.ask.requirePrefixInDirect;
    if (!needsPrefix) return text.slice(0, cfg.ask.maxQuestionChars);

    const prefix = cfg.ask.prefix;
    const lowered = text.toLowerCase();
    if (!lowered.startsWith(prefix)) return null;

    // Accept "Claude, ..." / "Claude: ..." / "Claude ..." but not "Claudia ...".
    const rest = text.slice(prefix.length);
    if (rest && !/^[\s,:;!?-]/.test(rest)) return null;

    const question = rest.replace(/^[\s,:;!?-]+/, '').trim();
    return question ? question.slice(0, cfg.ask.maxQuestionChars) : null;
  }

  async function handleIncoming(incoming) {
    const command = parseCommand(incoming.text);
    if (!command) return void (await maybeAsk(incoming));

    logger.info(
      `Command "${command.kind}" from ${incoming.pushName || incoming.senderJid}` +
        (incoming.isGroup ? ` in ${incoming.chatJid}` : ''),
    );

    try {
      switch (command.kind) {
        case 'help':
          return void (await provider.reply(incoming, HELP_TEXT));

        case 'planning': {
          const planning = await loadPlanning({ fresh: true });
          const parts = renderPlanning(planning, { upcomingOnly: cfg.upcomingOnly });
          for (const part of parts) await provider.reply(incoming, part);
          return;
        }

        case 'detail': {
          const planning = await loadPlanning();
          const plan = planning.plans.find((p) => p.id.toUpperCase() === command.id);
          if (!plan) {
            return void (await provider.reply(incoming, `No encuentro el plan *${command.id}*. Escribe *PLANES* para la lista.`));
          }
          return void (await provider.reply(incoming, `*${plan.dayLabel}*\n\n${renderPlan(plan)}`));
        }

        case 'unknown-vote':
          return void (await provider.reply(
            incoming,
            `No entiendo "${command.answer}". Responde *${command.id} SI* o *${command.id} NO*.`,
          ));

        case 'vote':
          return void (await handleVote(incoming, command));

        default:
          return;
      }
    } catch (err) {
      logger.error('Failed to handle command:', err);
      await provider
        .reply(incoming, '😵 Algo ha fallado procesando ese comando. Mira los logs del bot.')
        .catch(() => {});
    }
  }

  /** Queue a question for the ask worker; the answer arrives whenever it arrives. */
  async function maybeAsk(incoming) {
    const question = questionFrom(incoming);
    if (!question) return; // ordinary chatter: stay quiet

    try {
      const job = askQueue.enqueue({
        question,
        chatJid: incoming.chatJid,
        senderJid: incoming.senderJid,
        pushName: incoming.pushName,
        sessionId: sessionIdFor(incoming.chatJid),
        messageId: incoming.raw && incoming.raw.key ? incoming.raw.key.id : null,
      });
      logger.info(`Queued question "${job.id}" from ${incoming.pushName || incoming.senderJid}.`);
      // No "thinking…" message: the answer can be hours away, and a bot that
      // says something on every message is noise in a group.
    } catch (err) {
      logger.error('Could not queue the question:', err);
    }
  }

  async function handleVote(incoming, command) {
    const who = voterName(incoming.senderJid);
    if (!who) {
      logger.warn(`Ignoring vote from unlisted number ${incoming.senderJid}`);
      return void (await provider.reply(
        incoming,
        'Tu número no está en la lista de votantes, así que no guardo tu voto. 🙈',
      ));
    }

    const planning = await loadPlanning();
    const plan = planning.plans.find((p) => p.id.toUpperCase() === command.id);
    if (!plan) {
      return void (await provider.reply(incoming, `No encuentro el plan *${command.id}*.`));
    }

    try {
      await planningSource.recordVote({ id: plan.id, voter: who, value: command.value });
      cached = null; // force a refresh so the next listing shows the new vote
      const mark = command.value === 'si' ? '✅' : '❌';
      await provider.reply(incoming, `${mark} Voto de *${who}* guardado para *${plan.id} · ${plan.plan}*.`);
    } catch (err) {
      if (err && err.code === 'ENOTIMPLEMENTED') {
        // Expected until the Google Sheets writer lands — acknowledge honestly
        // rather than pretending the vote was stored.
        logger.warn(`Vote not persisted (${planningSource.name} is read-only): ${who} -> ${plan.id}=${command.value}`);
        await provider.reply(
          incoming,
          `📝 Anotado: *${who}* vota *${command.value.toUpperCase()}* a *${plan.id} · ${plan.plan}*.\n` +
            '_(Todavía no se guarda en la hoja de Google — falta conectar esa parte.)_',
        );
        return;
      }
      throw err;
    }
  }

  return {
    handleIncoming,
    questionFrom,
    async start() {
      provider.onMessage(handleIncoming);
      await provider.connect();
      logger.info('Bot listening for commands. Send AYUDA from WhatsApp to test.');
    },
  };
}

module.exports = { createBot };
