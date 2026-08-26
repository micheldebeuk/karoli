'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sendPlanning } = require('../src/send');
const { fakeProvider, fakePlanningSource, baseConfig } = require('./helpers');

const PLANS = [
  { id: 'E1', plan: 'Caldetes', dia: 'Sabado 29/08/2026', horario: '09:30-14:00' },
];

test('sends every part to every recipient', async () => {
  const provider = fakeProvider();
  const cfg = baseConfig({ recipients: ['+34600111222', '120363000000000000@g.us'] });
  const { results, failed } = await sendPlanning({ cfg, provider, planningSource: fakePlanningSource(PLANS) });

  assert.equal(failed.length, 0);
  assert.equal(results.length, 2);
  assert.deepEqual(provider.sent.map((s) => s.recipient), [
    '34600111222@s.whatsapp.net',
    '120363000000000000@g.us',
  ]);
  assert.match(provider.sent[0].text, /E1 · Caldetes/);
});

test('a malformed recipient is skipped, the rest still get the planning', async () => {
  const provider = fakeProvider();
  const cfg = baseConfig({ recipients: ['not-a-number', '+34600111222'] });
  const { results, failed } = await sendPlanning({ cfg, provider, planningSource: fakePlanningSource(PLANS) });

  assert.equal(failed.length, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].recipient, '34600111222@s.whatsapp.net');
});

test('one recipient failing mid-send does not cost the others theirs', async () => {
  const provider = fakeProvider();
  const realSend = provider.send.bind(provider);
  provider.send = async (recipient, text) => {
    if (recipient.startsWith('34600333444')) throw new Error('blocked you');
    return realSend(recipient, text);
  };
  const cfg = baseConfig({ recipients: ['+34600333444', '+34600111222'] });
  const { failed, results } = await sendPlanning({ cfg, provider, planningSource: fakePlanningSource(PLANS) });

  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /blocked you/);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(provider.sent.length, 1);
});
