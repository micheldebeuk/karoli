'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBot } = require('../src/bot');
const { fakeProvider, fakePlanningSource, baseConfig, incoming } = require('./helpers');

const PLANS = [
  { id: 'E1', plan: 'Caldetes', dia: 'Sabado 29/08/2026', horario: '09:30-14:00', categoria: 'Escapada - mar y playa' },
  { id: 'C2', plan: 'El Born CCM', dia: 'Domingo 30/08/2026', horario: '17:00-19:00', categoria: 'Cultura - exposicion' },
];

function makeBot({ cfg = {}, writable = true } = {}) {
  const provider = fakeProvider();
  const planningSource = fakePlanningSource(PLANS, { writable });
  const bot = createBot({ cfg: baseConfig(cfg), provider, planningSource });
  return { bot, provider, planningSource };
}

test('AYUDA answers with the command list', async () => {
  const { bot, provider } = makeBot();
  await bot.handleIncoming(incoming('ayuda'));
  assert.equal(provider.replies.length, 1);
  assert.match(provider.replies[0].text, /Comandos del bot de planes/);
});

test('PLANES resends the planning', async () => {
  const { bot, provider } = makeBot();
  await bot.handleIncoming(incoming('PLANES'));
  assert.ok(provider.replies.length >= 1);
  assert.match(provider.replies[0].text, /E1 · Caldetes/);
});

test('a bare plan id returns just that plan', async () => {
  const { bot, provider } = makeBot();
  await bot.handleIncoming(incoming('C2'));
  assert.match(provider.replies[0].text, /C2 · El Born CCM/);
  assert.doesNotMatch(provider.replies[0].text, /Caldetes/);
});

test('an unknown plan id says so instead of failing silently', async () => {
  const { bot, provider } = makeBot();
  await bot.handleIncoming(incoming('Z9'));
  assert.match(provider.replies[0].text, /No encuentro el plan \*Z9\*/);
});

test('a vote from a known number is recorded', async () => {
  const { bot, provider, planningSource } = makeBot();
  await bot.handleIncoming(incoming('E1 si', { from: '34600333444@s.whatsapp.net' }));
  assert.deepEqual(planningSource.votes, [{ id: 'E1', voter: 'Karina', value: 'si' }]);
  assert.match(provider.replies[0].text, /Voto de \*Karina\* guardado/);
});

test('a vote from an unlisted number is refused, not stored', async () => {
  const { bot, provider, planningSource } = makeBot();
  await bot.handleIncoming(incoming('E1 si', { from: '34699999999@s.whatsapp.net' }));
  assert.deepEqual(planningSource.votes, []);
  assert.match(provider.replies[0].text, /no está en la lista de votantes/);
});

test('a read-only source acknowledges the vote honestly rather than claiming it saved', async () => {
  const { bot, provider } = makeBot({ writable: false });
  await bot.handleIncoming(incoming('E1 no'));
  assert.match(provider.replies[0].text, /Anotado/);
  assert.match(provider.replies[0].text, /Todavía no se guarda en la hoja de Google/);
});

test('a device-suffixed JID still matches its voter', async () => {
  const { bot, planningSource } = makeBot();
  await bot.handleIncoming(incoming('E1 si', { from: '34600111222:12@s.whatsapp.net' }));
  assert.deepEqual(planningSource.votes, [{ id: 'E1', voter: 'Olivier', value: 'si' }]);
});

test('ordinary group chatter draws no reply', async () => {
  const { bot, provider } = makeBot();
  for (const text of ['hola', 'jajaja', 'vale nos vemos el sabado']) {
    await bot.handleIncoming(incoming(text, { chat: '120363000000000000@g.us' }));
  }
  assert.equal(provider.replies.length, 0);
});

test('a failing source is reported to the chat, not swallowed', async () => {
  const provider = fakeProvider();
  const planningSource = fakePlanningSource(PLANS);
  planningSource.load = async () => {
    throw new Error('sheet unavailable');
  };
  const bot = createBot({ cfg: baseConfig(), provider, planningSource });
  await bot.handleIncoming(incoming('PLANES'));
  assert.match(provider.replies[0].text, /Algo ha fallado/);
});

test('the bot refuses to start on a transport that cannot receive', () => {
  const provider = fakeProvider({ supportsIncoming: false, name: 'cloud' });
  assert.throws(
    () => createBot({ cfg: baseConfig(), provider, planningSource: fakePlanningSource(PLANS) }),
    /cannot receive messages/,
  );
});
