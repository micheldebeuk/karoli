'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toJid, isGroup, toE164Digits, describe } = require('../src/whatsapp/jid');

test('normalises E.164 numbers to user JIDs', () => {
  assert.equal(toJid('+34600111222'), '34600111222@s.whatsapp.net');
  assert.equal(toJid('+34 600 11 12 22'), '34600111222@s.whatsapp.net');
  assert.equal(toJid('0034600111222'), '0034600111222@s.whatsapp.net');
});

test('passes existing JIDs through untouched', () => {
  assert.equal(toJid('34600111222@s.whatsapp.net'), '34600111222@s.whatsapp.net');
  assert.equal(toJid('120363000000000000@g.us'), '120363000000000000@g.us');
});

test('rejects things that are not phone numbers', () => {
  assert.throws(() => toJid(''), /Empty recipient/);
  assert.throws(() => toJid('123'), /E\.164/);
  assert.throws(() => toJid('olivier@example.com'), /Unrecognised recipient JID/);
});

test('recognises groups and refuses them for the Cloud API', () => {
  assert.equal(isGroup('120363000000000000@g.us'), true);
  assert.equal(isGroup('34600111222@s.whatsapp.net'), false);
  assert.equal(toE164Digits('+34600111222'), '34600111222');
  assert.throws(() => toE164Digits('120363000000000000@g.us'), /cannot post to groups/);
});

test('describes recipients readably', () => {
  assert.equal(describe('34600111222@s.whatsapp.net'), '+34600111222');
  assert.match(describe('120363000000000000@g.us'), /^group /);
});
