'use strict';

const { logger } = require('../logger');
const { toJid, describe } = require('./jid');

/** Renders and logs, sends nothing. Used by WHATSAPP_PROVIDER=dry-run and DRY_RUN=1. */
function createDryRunProvider(wrapped) {
  const sent = [];
  return {
    name: wrapped ? `dry-run(${wrapped.name})` : 'dry-run',
    supportsGroups: true,
    supportsIncoming: Boolean(wrapped && wrapped.supportsIncoming),
    sent,

    isRegistered: () => true,
    async connect() {
      return null;
    },
    async send(recipient, text) {
      const jid = toJid(recipient);
      sent.push({ jid, text });
      logger.info(`[dry-run] would send to ${describe(jid)}:\n${'─'.repeat(48)}\n${text}\n${'─'.repeat(48)}`);
      return { dryRun: true, jid };
    },
    async reply(incoming, text) {
      logger.info(`[dry-run] would reply in ${incoming.chatJid}:\n${text}`);
      return { dryRun: true };
    },
    onMessage(handler) {
      if (wrapped && wrapped.supportsIncoming) wrapped.onMessage(handler);
    },
    async listGroups() {
      return wrapped ? wrapped.listGroups() : [];
    },
    async whoami() {
      return { id: 'dry-run', provider: 'dry-run' };
    },
    async close() {
      if (wrapped) await wrapped.close();
    },
  };
}

module.exports = { createDryRunProvider };
