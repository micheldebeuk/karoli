'use strict';

const { normalizePlanning } = require('../src/planning/schema');

/** In-memory WhatsApp transport that records everything instead of sending. */
function fakeProvider(overrides = {}) {
  const sent = [];
  const replies = [];
  const handlers = [];
  return {
    name: 'fake',
    supportsGroups: true,
    supportsIncoming: true,
    sent,
    replies,
    handlers,
    isRegistered: () => true,
    async connect() {},
    async send(recipient, text) {
      sent.push({ recipient, text });
      return { key: { id: `fake-${sent.length}` } };
    },
    async reply(incoming, text) {
      replies.push({ chatJid: incoming.chatJid, text });
      return { key: { id: `fake-reply-${replies.length}` } };
    },
    onMessage(h) {
      handlers.push(h);
    },
    async listGroups() {
      return [];
    },
    async whoami() {
      return { id: 'fake' };
    },
    async close() {},
    ...overrides,
  };
}

/** In-memory planning source; `writable` decides whether votes persist. */
function fakePlanningSource(plans, { writable = true } = {}) {
  const votes = [];
  const data = { title: 'Planes de Fin de Semana', plans };
  return {
    name: 'fake',
    writable,
    votes,
    loads: 0,
    async load() {
      this.loads += 1;
      return normalizePlanning(data);
    },
    async recordVote(vote) {
      if (!writable) {
        throw Object.assign(new Error('read-only source'), { code: 'ENOTIMPLEMENTED' });
      }
      votes.push(vote);
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    recipients: ['+34600111222'],
    voters: { 34600111222: 'Olivier', 34600333444: 'Karina' },
    upcomingOnly: false,
    dryRun: false,
    timezone: 'Europe/Madrid',
    ...overrides,
  };
}

function incoming(text, { from = '34600111222@s.whatsapp.net', chat = null, pushName = 'Olivier' } = {}) {
  const chatJid = chat || from;
  return {
    text,
    chatJid,
    senderJid: from,
    pushName,
    isGroup: chatJid.endsWith('@g.us'),
    raw: { key: { remoteJid: chatJid } },
  };
}

module.exports = { fakeProvider, fakePlanningSource, baseConfig, incoming };
