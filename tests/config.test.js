'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { load, validateForSend } = require('../src/config');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN = {
  WHATSAPP_PROVIDER: 'baileys',
  WHATSAPP_RECIPIENTS: '+34600111222',
  PLANNING_SOURCE: 'fixture',
  PLANNING_VOTERS: '+34600111222=Olivier,+34 600 33 34 44=Karina',
  DRY_RUN: undefined,
  WA_CLOUD_TOKEN: undefined,
  WA_CLOUD_PHONE_NUMBER_ID: undefined,
};

test('parses recipients and voters', () => {
  withEnv(CLEAN, () => {
    const cfg = load();
    assert.deepEqual(cfg.recipients, ['+34600111222']);
    assert.deepEqual(cfg.voters, { 34600111222: 'Olivier', 34600333444: 'Karina' });
    assert.equal(validateForSend(cfg), cfg);
  });
});

test('rejects an unknown provider and an empty recipient list', () => {
  withEnv({ ...CLEAN, WHATSAPP_PROVIDER: 'carrier-pigeon' }, () => {
    assert.throws(() => validateForSend(load()), /WHATSAPP_PROVIDER must be one of/);
  });
  withEnv({ ...CLEAN, WHATSAPP_RECIPIENTS: '' }, () => {
    assert.throws(() => validateForSend(load()), /nobody would receive/);
  });
});

test('refuses a group recipient on the Cloud API instead of failing at send time', () => {
  withEnv(
    {
      ...CLEAN,
      WHATSAPP_PROVIDER: 'cloud',
      WA_CLOUD_TOKEN: 'tok',
      WA_CLOUD_PHONE_NUMBER_ID: '123',
      WHATSAPP_RECIPIENTS: '120363000000000000@g.us',
    },
    () => {
      assert.throws(() => validateForSend(load()), /cannot post to groups/);
    },
  );
});

test('the cloud provider demands its credentials', () => {
  withEnv({ ...CLEAN, WHATSAPP_PROVIDER: 'cloud' }, () => {
    assert.throws(() => validateForSend(load()), /WA_CLOUD_TOKEN is required/);
  });
});

test('DRY_RUN accepts the usual truthy spellings', () => {
  for (const raw of ['1', 'true', 'YES', 'on']) {
    withEnv({ ...CLEAN, DRY_RUN: raw }, () => assert.equal(load().dryRun, true, raw));
  }
  for (const raw of ['0', 'false', '', 'no']) {
    withEnv({ ...CLEAN, DRY_RUN: raw }, () => assert.equal(load().dryRun, false, JSON.stringify(raw)));
  }
});
