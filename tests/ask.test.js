'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logger } = require('../src/logger');
logger.setLevel('silent');

const { createQueue } = require('../src/ask/queue');
const { createAskWorker } = require('../src/ask/worker');
const { sessionIdFor, extractText, classify, buildArgs, childEnv } = require('../src/ask/claude');
const { createBot } = require('../src/bot');
const { fakeProvider, fakePlanningSource, baseConfig, incoming } = require('./helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'planes-ask-'));
let n = 0;
const freshDir = () => path.join(TMP, `q${(n += 1)}`);

function askCfg(overrides = {}) {
  return {
    ask: {
      enabled: true,
      bin: 'claude',
      model: 'sonnet',
      prefix: 'claude',
      requirePrefixInDirect: false,
      queueDir: freshDir(),
      workDir: path.join(TMP, 'work'),
      tickMs: 1,
      timeoutMs: 1000,
      maxAttempts: 3,
      dailyLimit: 25,
      maxQuestionChars: 1500,
      maxAnswerChars: 1200,
      systemPrompt: 'sistema',
      ...overrides,
    },
  };
}

// --- the subscription guarantee -------------------------------------------

test('the child never inherits an API key, so it cannot slip onto API billing', () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used';
  process.env.ANTHROPIC_AUTH_TOKEN = 'also-not';
  try {
    const env = childEnv(baseConfig(askCfg()));
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});

test('the CLI is invoked with no tools and no --bare', () => {
  const args = buildArgs(baseConfig(askCfg()), { question: '¿que tal?', sessionId: 'abc' });

  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], '', 'no tools may be granted');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
  assert.ok(!args.includes('--bare'), '--bare would read an API key instead of the subscription');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
});

test('each chat gets its own stable conversation id', () => {
  const a = sessionIdFor('34600111222@s.whatsapp.net');
  const b = sessionIdFor('120363000000000000@g.us');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(a, sessionIdFor('34600111222@s.whatsapp.net'), 'must be stable across restarts');
});

// --- parsing the CLI's answer ---------------------------------------------

test('reads the answer out of --output-format json', () => {
  assert.equal(extractText(JSON.stringify({ result: 'Hola' })), 'Hola');
  assert.equal(extractText(JSON.stringify({ content: [{ type: 'text', text: 'Hola' }] })), 'Hola');
  assert.equal(extractText('plain text answer'), 'plain text answer');
  assert.equal(extractText(''), '');
});

test('a rate limit is told apart from a real failure', () => {
  assert.equal(classify({}, 'Usage limit reached, resets at 5pm').code, 'ERATELIMIT');
  assert.equal(classify({}, 'Please run claude setup-token').code, 'EAUTH');
  assert.equal(classify({ killed: true }, '').code, 'ETIMEOUT');
  assert.equal(classify({}, 'segfault').code, 'ECLAUDE');
});

// --- the queue -------------------------------------------------------------

test('a queued question survives a restart', () => {
  const dir = freshDir();
  createQueue({ dir }).enqueue({ question: '¿llueve?', chatJid: 'x@s.whatsapp.net', sessionId: 's' });

  // A brand-new queue object over the same directory — as after a reboot.
  const job = createQueue({ dir }).claimNext();
  assert.equal(job.question, '¿llueve?');
});

test('a job scheduled for later is not claimed early', () => {
  const q = createQueue({ dir: freshDir() });
  const job = q.enqueue({ question: 'x', chatJid: 'c', sessionId: 's' });
  q.fail(job, { error: 'rate limited', retryAfterMs: 60_000 });

  assert.equal(q.claimNext(Date.now()), null);
  assert.ok(q.claimNext(Date.now() + 61_000), 'claimable once the window passes');
});

test('backoff grows and the job is dropped after maxAttempts', () => {
  const q = createQueue({ dir: freshDir(), maxAttempts: 3 });
  let job = q.enqueue({ question: 'x', chatJid: 'c', sessionId: 's' });

  const first = q.fail(job, { error: 'boom' });
  const second = q.fail(first.job, { error: 'boom' });
  assert.ok(second.retryInMs > first.retryInMs, 'backoff must grow');

  const third = q.fail(second.job, { error: 'boom' });
  assert.equal(third.gaveUp, true);
  assert.equal(q.claimNext(Date.now() + 10 * 3600_000), null);
});

test('a corrupt job file is set aside instead of wedging the queue', () => {
  const dir = freshDir();
  const q = createQueue({ dir });
  q.enqueue({ question: 'good', chatJid: 'c', sessionId: 's' });
  fs.writeFileSync(path.join(q.pendingDir, '0000-broken.json'), '{not json');

  const job = q.claimNext();
  assert.equal(job.question, 'good');
  assert.ok(fs.readdirSync(q.doneDir).some((f) => f.startsWith('corrupt-')));
});

// --- deciding what counts as a question ------------------------------------

function bot({ ask = {}, ...rest } = {}) {
  const provider = fakeProvider();
  const queue = createQueue({ dir: freshDir() });
  const cfg = baseConfig({ ...rest, ...askCfg(ask) });
  const b = createBot({ cfg, provider, planningSource: fakePlanningSource([]), askQueue: queue });
  return { bot: b, provider, queue };
}

test('in a one-to-one chat any message from a known voter is a question', async () => {
  const { bot: b, queue } = bot();
  await b.handleIncoming(incoming('¿que hacemos el sabado?'));
  assert.equal(queue.claimNext().question, '¿que hacemos el sabado?');
});

test('in a group the bot only answers when named', async () => {
  const { bot: b, queue } = bot();
  const group = { chat: '120363000000000000@g.us' };

  await b.handleIncoming(incoming('que calor hace hoy', group));
  assert.equal(queue.claimNext(), null, 'must stay quiet on ordinary group chatter');

  await b.handleIncoming(incoming('Claude, ¿que tiempo hara el sabado?', group));
  assert.equal(queue.claimNext().question, '¿que tiempo hara el sabado?');
});

test('the prefix must be the whole word, not a prefix of another one', async () => {
  const { bot: b, queue } = bot();
  const group = { chat: '120363000000000000@g.us' };
  await b.handleIncoming(incoming('Claudia dice que si', group));
  assert.equal(queue.claimNext(), null);
});

test('strangers are never answered, in a group or otherwise', async () => {
  const { bot: b, queue } = bot();
  await b.handleIncoming(incoming('hola bot', { from: '34699999999@s.whatsapp.net' }));
  assert.equal(queue.claimNext(), null);
});

test('a real command still wins over the question path', async () => {
  const { bot: b, queue, provider } = bot();
  await b.handleIncoming(incoming('AYUDA'));
  assert.equal(queue.claimNext(), null);
  assert.match(provider.replies[0].text, /Comandos/);
});

test('an over-long question is truncated rather than passed on whole', async () => {
  const { bot: b, queue } = bot({ ask: { maxQuestionChars: 40 } });
  await b.handleIncoming(incoming('x'.repeat(500)));
  assert.equal(queue.claimNext().question.length, 40);
});

test('the ask path is inert when the feature is off', async () => {
  const { bot: b, queue } = bot({ ask: { enabled: false } });
  await b.handleIncoming(incoming('¿que tal?'));
  assert.equal(queue.claimNext(), null);
});

// --- the worker ------------------------------------------------------------

function worker({ runClaude, cfgOverrides = {} } = {}) {
  const provider = fakeProvider();
  const queue = createQueue({ dir: freshDir(), maxAttempts: 3 });
  const cfg = baseConfig(askCfg(cfgOverrides));
  return { w: createAskWorker({ cfg, provider, queue, runClaude }), provider, queue };
}

test('an answer is replied into the chat it came from', async () => {
  const calls = [];
  const { w, provider, queue } = worker({
    runClaude: async (cfg, args) => {
      calls.push(args);
      return { text: 'El sabado hara sol.' };
    },
  });
  queue.enqueue({ question: '¿que tiempo?', chatJid: '120363@g.us', sessionId: 'sess-1', messageId: 'MSG1' });

  await w.tick();

  assert.equal(calls[0].question, '¿que tiempo?');
  assert.equal(calls[0].sessionId, 'sess-1');
  assert.equal(provider.replies[0].chatJid, '120363@g.us');
  assert.equal(provider.replies[0].text, 'El sabado hara sol.');
  assert.equal(queue.claimNext(Date.now() + 10 * 3600_000), null, 'the job is done');
});

test('a trimmed answer never exceeds the cap it is trimmed to', async () => {
  // The truncation note counts toward the limit; reserving a guessed number of
  // characters for it is how the cap gets overshot.
  for (const cap of [200, 60, 40, 26]) {
    const { w, provider, queue } = worker({
      runClaude: async () => ({ text: 'y'.repeat(5000) }),
      cfgOverrides: { maxAnswerChars: cap },
    });
    // No message id to quote, so the worker sends into the chat instead.
    queue.enqueue({ question: 'x', chatJid: 'c@s.whatsapp.net', sessionId: 's' });

    await w.tick();
    assert.equal(provider.replies.length, 0);
    assert.ok(provider.sent[0].text.length <= cap, `cap ${cap}: got ${provider.sent[0].text.length}`);
    assert.match(provider.sent[0].text, /recortada/);
  }
});

test('an answer that already fits is passed through untouched', async () => {
  const { w, provider, queue } = worker({ runClaude: async () => ({ text: 'Corto.' }) });
  queue.enqueue({ question: 'x', chatJid: 'c@s.whatsapp.net', sessionId: 's' });

  await w.tick();
  assert.equal(provider.sent[0].text, 'Corto.');
});

test('a rate limit keeps the question and says nothing in the chat', async () => {
  const { w, provider, queue } = worker({
    runClaude: async () => { throw Object.assign(new Error('usage limit reached'), { code: 'ERATELIMIT' }); },
  });
  queue.enqueue({ question: 'x', chatJid: 'c@s.whatsapp.net', sessionId: 's' });

  await w.tick();

  assert.equal(provider.replies.length, 0, 'a rate limit is normal; do not spam the chat');
  assert.equal(queue.claimNext(Date.now()), null, 'held off for the window');
  assert.ok(queue.claimNext(Date.now() + 31 * 60_000), 'but still queued');
});

test('a broken login is reported once and not retried forever', async () => {
  const { w, provider, queue } = worker({
    runClaude: async () => { throw Object.assign(new Error('please run claude setup-token'), { code: 'EAUTH' }); },
  });
  queue.enqueue({ question: 'x', chatJid: 'c@s.whatsapp.net', sessionId: 's' });

  await w.tick();
  assert.match(provider.sent[0].text, /no est./i);
  assert.equal(queue.claimNext(Date.now() + 24 * 3600_000), null, 'auth will not fix itself by retrying');
});

test('the daily cap stops the worker before it spends more', async () => {
  let ran = 0;
  const { w, queue } = worker({
    runClaude: async () => { ran += 1; return { text: 'ok' }; },
    cfgOverrides: { dailyLimit: 2 },
  });
  for (let i = 0; i < 4; i += 1) queue.enqueue({ question: `q${i}`, chatJid: 'c@s.whatsapp.net', sessionId: 's' });

  for (let i = 0; i < 4; i += 1) await w.tick();

  assert.equal(ran, 2, 'must stop at the cap');
  assert.equal(queue.stats().pending, 2, 'the rest stay queued for tomorrow');
});

test('only one question is in flight at a time', async () => {
  let concurrent = 0;
  let peak = 0;
  const { w, queue } = worker({
    runClaude: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return { text: 'ok' };
    },
  });
  queue.enqueue({ question: 'a', chatJid: 'c@s.whatsapp.net', sessionId: 's' });
  queue.enqueue({ question: 'b', chatJid: 'c@s.whatsapp.net', sessionId: 's' });

  await Promise.all([w.tick(), w.tick(), w.tick()]);
  assert.equal(peak, 1);
});
