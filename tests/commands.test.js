'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCommand } = require('../src/bot/commands');

test('recognises the planning command in its several spellings', () => {
  for (const text of ['PLANES', 'planes', '!planes', '/plan', 'lista']) {
    assert.deepEqual(parseCommand(text), { kind: 'planning' }, text);
  }
});

test('recognises help', () => {
  assert.deepEqual(parseCommand('ayuda'), { kind: 'help' });
  assert.deepEqual(parseCommand('?'), { kind: 'help' });
});

test('parses votes in both directions', () => {
  assert.deepEqual(parseCommand('E1 si'), { kind: 'vote', id: 'E1', value: 'si' });
  assert.deepEqual(parseCommand('e1 SÍ'), { kind: 'vote', id: 'E1', value: 'si' });
  assert.deepEqual(parseCommand('C2 no'), { kind: 'vote', id: 'C2', value: 'no' });
  assert.deepEqual(parseCommand('C2 👎'), { kind: 'vote', id: 'C2', value: 'no' });
});

test('a bare plan id asks for the detail', () => {
  assert.deepEqual(parseCommand('E3'), { kind: 'detail', id: 'E3' });
});

test('an unparseable answer to a plan id is reported, not guessed', () => {
  assert.deepEqual(parseCommand('E1 quizas'), { kind: 'unknown-vote', id: 'E1', answer: 'quizas' });
});

test('ordinary chatter is ignored so the bot stays quiet in groups', () => {
  for (const text of ['', '   ', 'hola que tal', 'vale nos vemos', '😀']) {
    assert.equal(parseCommand(text), null, JSON.stringify(text));
  }
});
