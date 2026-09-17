const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const limits = require('../lib/src/imageLimits');

const FILE_CARD = 'application/vnd.microsoft.teams.file.download.info';
const inline = () => ({ contentType: 'image/png', contentUrl: 'https://api.asm.skype.com/objects/photo' });
const file = (extension = 'png') => ({
  contentType: FILE_CARD, name: `a3.${extension}`,
  content: { fileType: extension, downloadUrl: 'https://company.sharepoint.com/photo?signature=private' },
});
function png(size = 32) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
}

function harness(fetch, timeout = 15000) {
  const exports = {};
  const filename = path.join(__dirname, '../lib/src/attachments.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, Buffer, URL, Headers, AbortController, fetch,
    setTimeout: fn => setTimeout(fn, timeout), clearTimeout,
    require: id => {
      if (id === './imageLimits') return limits;
      if (id === '@microsoft/agents-activity') return { Channels: { Msteams: 'msteams', M365Copilot: 'copilot' } };
      throw new Error(`Unexpected dependency ${id}`);
    },
  }, { filename });
  return (attachments, channelId = 'msteams') => exports.extractImages({
    activity: { attachments, channelId },
    adapter: { ConnectorClientKey: 'connector' },
    turnState: new Map([['connector', { httpClient: { defaultHeaders: { Authorization: 'Bearer test-only' } } }]]),
  });
}

test('inline images use connector auth; signed file downloads do not', async () => {
  const requests = [];
  const extract = harness(async (url, options) => {
    requests.push({ url, options });
    return new Response(png(), { headers: { 'content-type': 'application/octet-stream' } });
  });
  const result = await extract([inline(), file()]);
  assert.equal(result.images.length, 2);
  assert.equal(result.images[0].mediaType, 'image/png');
  assert.equal(requests[0].options.headers.get('authorization'), 'Bearer test-only');
  assert.equal(requests[1].options.headers.get('authorization'), null);
  assert.equal(result.problems.length, 0);
});

test('large Content-Length rejects without reading the body and cancels it', async () => {
  let cancelled = false, reads = 0;
  const extract = harness(async () => new Response(new ReadableStream({
    pull() { reads++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(limits.MAX_IMAGE_BYTES + 1) } }));
  const result = await extract([file()]);
  assert.equal(reads, 0);
  assert.equal(cancelled, true);
  assert.equal(result.images.length, 0);
  assert.match(result.problems[0], /under 4 MB/);
});

for (const declaredLength of [undefined, '10']) {
  test(`stream limit stops oversized download with ${declaredLength ? 'false' : 'no'} Content-Length`, async () => {
    let chunks = 0, cancelled = false;
    const extract = harness(async () => new Response(new ReadableStream({
      pull(controller) { chunks++; controller.enqueue(png(1_000_000)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: declaredLength ? { 'content-length': declaredLength } : {} }));
    const result = await extract([file()]);
    assert.equal(chunks, 5);
    assert.equal(cancelled, true);
    assert.equal(result.images.length, 0);
    assert.match(result.problems[0], /under 4 MB/);
  });
}

test('4 MB boundary succeeds, but combined encoded budget rejects the third large image', async () => {
  const extract = harness(async () => new Response(png(limits.MAX_IMAGE_BYTES)));
  const result = await extract([file(), file(), file()]);
  assert.equal(result.images.length, 2);
  assert.ok(result.images.reduce((sum, i) => sum + i.data.length, 0) <= limits.MAX_ENCODED_IMAGE_BYTES);
  assert.match(result.problems[0], /Image 3:.*too large together/);
});

test('only three image downloads are attempted per message', async () => {
  let downloads = 0;
  const extract = harness(async () => { downloads++; return new Response(png()); });
  const result = await extract([inline(), file(), file(), file()]);
  assert.equal(downloads, 3);
  assert.equal(result.images.length, 3);
  assert.match(result.problems[0], /three images per message/);
});

test('PDF, Word, and Excel receive instructions without a download', async () => {
  let downloads = 0;
  const extract = harness(async () => { downloads++; throw new Error('Should not fetch'); });
  const result = await extract([file('pdf'), file('docx'), file('xlsx')]);
  assert.equal(downloads, 0);
  assert.equal(result.images.length, 0);
  assert.match(result.problems[0], /paste the relevant text or send screenshots/);
});

test('unsupported content disguised as an image is rejected', async () => {
  const extract = harness(async () => new Response(Buffer.from('%PDF-1.7 not a picture')));
  const result = await extract([inline()]);
  assert.equal(result.images.length, 0);
  assert.match(result.problems[0], /document format/);
});

test('timeout covers a stalled response before headers', async () => {
  const extract = harness((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), 10);
  const result = await extract([inline()]);
  assert.match(result.problems[0], /timed out/);
});

test('timeout covers stalled body reads', async () => {
  const extract = harness(async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    },
  })), 10);
  const result = await extract([inline()]);
  assert.match(result.problems[0], /timed out/);
});

test('download failures neither expose signed URLs nor prevent the next image', async () => {
  let calls = 0;
  const extract = harness(async () => {
    if (++calls === 1) throw new Error('secret https://company.sharepoint.com/?signature=private');
    return new Response(png());
  });
  const result = await extract([file(), file()]);
  assert.equal(result.images.length, 1);
  assert.doesNotMatch(result.problems.join(' '), /signature|private|https/);
});

test('untrusted inline hosts and non-HTTPS file URLs are not fetched', async () => {
  let calls = 0;
  const extract = harness(async () => { calls++; throw new Error('Should not fetch'); });
  const unsafeFile = file();
  unsafeFile.content.downloadUrl = 'http://example.com/photo';
  await extract([{ ...inline(), contentUrl: 'https://example.com/photo' }, unsafeFile]);
  assert.equal(calls, 0);
});

test('Playground explains why image download is unavailable', async () => {
  const extract = harness(async () => { throw new Error('Should not fetch'); });
  const result = await extract([inline()], 'emulator');
  assert.equal(result.images.length, 0);
  assert.match(result.problems[0], /send images in Teams/);
});

test('cross-origin redirects drop bot credentials and HTTPS downgrades are rejected', async () => {
  let calls = 0;
  const extract = harness(async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    if (++calls === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/photo' } });
    assert.equal(options.headers.get('authorization'), null);
    return new Response(png());
  });
  assert.equal((await extract([inline()])).images.length, 1);
  let insecureCalls = 0;
  const insecure = harness(async () => {
    insecureCalls++;
    return new Response(null, { status: 302, headers: { location: 'http://example.com/photo' } });
  });
  assert.equal((await insecure([file()])).images.length, 0);
  assert.equal(insecureCalls, 1);
});

test('budget removes oldest images while retaining recent ones and explanatory text', () => {
  const image = data => ({ mediaType: 'image/png', data });
  const history = [
    { role: 'user', content: 'Original A3', images: [image('a'.repeat(4_000_000)), image('b'.repeat(4_000_000))] },
    { role: 'assistant', content: 'Where does it occur?' },
    { role: 'user', content: 'New detail', images: [image('c'.repeat(4_000_000)), image('d'.repeat(4_000_000))] },
  ];
  limits.pruneOldImages(history);
  assert.equal(history[0].images.length, 1);
  assert.equal(history[0].images[0].data[0], 'b');
  assert.match(history[0].content, /Original A3.*removed from context/);
  assert.equal(history[2].images.length, 2);
  assert.equal(history.flatMap(m => m.images ?? []).reduce((sum, i) => sum + i.data.length, 0), 12_000_000);
});

test('three-turn retention still applies even to small images', () => {
  const history = Array.from({ length: 4 }, (_, i) => ({
    role: 'user', content: `Turn ${i}`, images: [{ mediaType: 'image/png', data: 'YQ==' }],
  }));
  limits.pruneOldImages(history);
  assert.equal(history[0].images, undefined);
  assert.match(history[0].content, /removed from context/);
  assert.equal(history.slice(1).flatMap(m => m.images).length, 3);
});
