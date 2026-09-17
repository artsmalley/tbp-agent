const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// Run the real compiled handler with controlled model and Teams boundaries.
// No credentials, network calls, or changes to the global module loader.
function harness(extractImages = async () => ({ images: [], problems: [] })) {
  let handle;
  const calls = [];
  const replies = [];
  const provider = {
    fromHistory: history => structuredClone(history),
    runRound: (_system, _tools, history) => {
      const result = deferred();
      calls.push({ history, ...result });
      return result.promise;
    },
  };
  const modules = {
    '@microsoft/agents-activity': { ActivityTypes: { Message: 'message' } },
    '@microsoft/agents-hosting': {
      MemoryStorage: class {},
      AgentApplication: class {
        onConversationUpdate() {}
        onActivity(_type, handler) { handle = handler; }
      },
    },
    './skillPrompt': { SKILL_MD: 'Test coaching prompt' },
    './providers': { createProvider: () => provider },
    './attachments': { extractImages },
    './imageLimits': require('../lib/src/imageLimits'),
  };
  const file = path.join(__dirname, '../lib/src/agent.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports: {},
    console: { log() {}, warn() {}, error() {} },
    require: id => {
      assert.ok(id in modules, `Unexpected dependency: ${id}`);
      return modules[id];
    },
  }, { filename: file });
  return {
    calls,
    replies,
    send(text, id = 'learner', deliver) {
      return handle({
        activity: { text, conversation: { id } },
        sendActivity: async answer => {
          if (deliver) await deliver(answer);
          replies.push({ id, answer });
        },
      });
    },
  };
}

test('overlapping messages preserve both exchanges in order', async () => {
  const h = harness();
  const first = h.send('Scratches on assembly');
  const second = h.send('Only on night shift');
  await flush();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ text: 'Where are the scratches?' });
  await first;
  await flush();
  assert.deepEqual(h.calls[1].history.map(m => m.content), [
    'Scratches on assembly', 'Where are the scratches?', 'Only on night shift',
  ]);
  h.calls[1].resolve({ text: 'What differs on that shift?' });
  await second;
  assert.equal(h.replies.length, 2);
});

test('reset discards pending and queued old turns without blocking the new session', async () => {
  const h = harness();
  const old = h.send('Old problem');
  const queued = h.send('Old followup');
  await flush();
  await h.send('start over');
  const fresh = h.send('New problem');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].history.map(m => m.content), ['New problem']);
  h.calls[1].resolve({ text: 'New answer' });
  await fresh;
  h.calls[0].resolve({ text: 'Stale answer' });
  await Promise.all([old, queued]);
  assert.deepEqual(h.replies.map(r => r.answer), [
    "Session reset. Hello, I'm TBP Coach.", 'New answer',
  ]);
  assert.equal(h.calls.length, 2);
  const followup = h.send('Continue');
  await flush();
  assert.deepEqual(h.calls[2].history.map(m => m.content), [
    'New problem', 'New answer', 'Continue',
  ]);
  h.calls[2].resolve({ text: 'Continue answer' });
  await followup;
});

test('different learners can receive replies concurrently', async () => {
  const h = harness();
  const a = h.send('Problem A', 'a');
  const b = h.send('Problem B', 'b');
  await flush();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ text: 'Answer B' });
  await b;
  assert.deepEqual(h.replies, [{ id: 'b', answer: 'Answer B' }]);
  h.calls[0].resolve({ text: 'Answer A' });
  await a;
});

test('model failure does not poison history or block the next turn', async () => {
  const h = harness();
  const first = h.send('Failed question');
  const second = h.send('Retry question');
  await flush();
  h.calls[0].reject(new Error('Model unavailable'));
  await first;
  await flush();
  assert.deepEqual(h.calls[1].history.map(m => m.content), ['Retry question']);
  h.calls[1].resolve({ text: 'Successful answer' });
  await second;
});

test('reset during attachment download suppresses the old turn', async () => {
  const download = deferred();
  const h = harness(() => download.promise);
  const old = h.send('Old photo');
  await flush();
  await h.send('start over');
  download.resolve({ images: [], problems: ['Download failed'] });
  await old;
  assert.equal(h.calls.length, 0);
  assert.equal(h.replies.length, 1);
});

test('a stale model failure does not send an error into the reset session', async () => {
  const h = harness();
  const old = h.send('Old problem');
  await flush();
  await h.send('start over');
  h.calls[0].reject(new Error('Late failure'));
  await old;
  assert.equal(h.replies.length, 1);
});

test('failed Teams delivery leaves history intact and releases the queue', async () => {
  const h = harness();
  const first = h.send('Undelivered question', 'learner', async () => {
    throw new Error('Teams unavailable');
  });
  const rejected = assert.rejects(first, /Teams unavailable/);
  const next = h.send('Next question');
  await flush();
  h.calls[0].resolve({ text: 'Undelivered answer' });
  await rejected;
  await flush();
  assert.deepEqual(h.calls[1].history.map(m => m.content), ['Next question']);
  h.calls[1].resolve({ text: 'Delivered answer' });
  await next;
});

test('follow-up model calls retain recent photos and prune old photos to the byte budget', async () => {
  const h = harness(async context => ({
    images: context.activity.text === 'Followup' ? [] : [
      { mediaType: 'image/png', data: 'a'.repeat(4_000_000) },
      { mediaType: 'image/png', data: 'b'.repeat(4_000_000) },
    ],
    problems: [],
  }));
  for (const question of ['Original photos', 'New photos', 'Followup']) {
    const pending = h.send(question);
    await flush();
    const call = h.calls.at(-1);
    assert.ok(call.history.flatMap(m => m.images ?? []).reduce((sum, image) => sum + image.data.length, 0) <= 12_000_000);
    call.resolve({ text: 'Coaching reply' });
    await pending;
  }
  const followup = h.calls[2].history;
  assert.equal(followup[0].images.length, 1);
  assert.match(followup[0].content, /Original photos.*removed from context/);
  assert.equal(followup[2].images.length, 2);
  assert.equal(followup[4].content, 'Followup');
});
