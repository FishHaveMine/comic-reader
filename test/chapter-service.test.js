'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChapterService } = require('../src/main/chapter-service');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const chapter = (pageUrl, nextUrl = '') => ({ pageUrl, nextUrl, images: [{ url: `${pageUrl}/1.jpg` }] });
function setup(loadChapter, prefetchAll = async (urls) => ({ done: urls.length, failed: 0 })) {
  const committed = [];
  const pruned = [];
  const progress = [];
  const phases = [];
  const service = new ChapterService({
    source: { loadChapter },
    cache: { prefetchAll, prune: (urls) => pruned.push(urls) },
    onCurrent: (url) => committed.push(url),
    onProgress: (state) => progress.push(state),
    onPhase: (phase) => phases.push(phase),
  });
  return { service, committed, pruned, progress, phases };
}

test('快速打开时旧请求不能覆盖当前章节及持久化地址', async () => {
  const old = deferred();
  const { service, committed } = setup((url) => url === 'A' ? old.promise : Promise.resolve(chapter(url)));
  const first = service.open('A');
  assert.equal((await service.open('B')).chapter.pageUrl, 'B');
  old.resolve(chapter('A'));
  assert.equal((await first).stale, true);
  assert.equal(service.currentUrl, 'B');
  assert.deepEqual(committed, ['B']);
});

test('取消加载后旧结果与验证提示不再提交', async () => {
  const pending = deferred();
  let status;
  const { service, phases, committed } = setup((_url, { onStatus }) => {
    status = onStatus;
    return pending.promise;
  });
  const opening = service.open('A');
  service.cancelLoad();
  status('warming');
  pending.resolve(chapter('A'));
  assert.equal((await opening).stale, true);
  assert.deepEqual(phases, []);
  assert.deepEqual(committed, []);
});

test('前台打开与后台预取复用章节请求，前台能收到验证阶段', async () => {
  const pending = deferred();
  let count = 0;
  let status;
  const { service, phases } = setup((_url, { onStatus }) => {
    count += 1;
    status = onStatus;
    return pending.promise;
  });
  const background = service.chapter('A');
  status('warming');
  const foreground = service.open('A');
  pending.resolve(chapter('A'));
  await Promise.all([background, foreground]);
  assert.equal(count, 1);
  assert.deepEqual(phases, ['warming']);
});

test('旧预取链结束后不再清理新章节的缓存或推送进度', async () => {
  const pending = deferred();
  const { service, pruned, progress } = setup(async (url) => chapter(url, url === 'A' ? 'B' : ''), () => pending.promise);
  await service.open('A');
  const background = service.prefetchUpcoming('B');
  await new Promise(setImmediate);
  await service.open('X');
  const reported = progress.length;
  pending.resolve({ done: 1, failed: 0 });
  await background;
  assert.deepEqual(pruned, []);
  assert.equal(progress.length, reported);
});

test('预取结束后释放任务，重访已清理的章节会重新缓存图片', async () => {
  let batches = 0;
  const { service, pruned } = setup(async (url) => chapter(url, url === 'A' ? 'B' : ''), async () => {
    batches += 1;
    return { done: 1, failed: 0 };
  });
  await service.open('A');
  await service.prefetchUpcoming('B');
  assert.equal(service.prefetching.size, 0);
  await service.open('X');
  await service.prefetchUpcoming('');
  assert.equal(service.chapters.has('B'), false);
  await service.open('A');
  await service.prefetchUpcoming('B');
  assert.equal(batches, 2);
  assert.deepEqual(pruned.at(-1), ['A/1.jpg', 'B/1.jpg']);
});

test('预取部分图片失败时跳过清理，下次请求可以重试', async () => {
  let batches = 0;
  const { service, pruned } = setup(async (url) => chapter(url), async () => ({ done: 1, failed: ++batches === 1 ? 1 : 0 }));
  await service.open('A');
  await service.prefetchUpcoming('B');
  assert.deepEqual(pruned, []);
  await service.prefetchUpcoming('B');
  assert.equal(pruned.length, 1);
});

test('末章没有后续章节时仍然收敛缓存，循环导航不会重复预取当前章', async () => {
  const { service, pruned, progress } = setup(async (url) => chapter(url, 'A'));
  await service.open('A');
  await service.prefetchUpcoming('A');
  assert.deepEqual(pruned, [['A/1.jpg']]);
  assert.deepEqual(progress, []);
});

test('预取解析失败后任务可再次执行', async () => {
  let attempts = 0;
  const { service, pruned } = setup(async (url) => {
    if (url === 'B' && ++attempts === 1) throw new Error('断网');
    return chapter(url);
  });
  await service.open('A');
  await service.prefetchUpcoming('B');
  assert.equal(service.prefetching.size, 0);
  assert.deepEqual(pruned, []);
  await service.prefetchUpcoming('B');
  assert.equal(pruned.length, 1);
});

test('返回原章节可以恢复刚提交的新章节地址，避免下次启动跳到已取消章节', async () => {
  const { service, committed } = setup(async (url) => chapter(url));
  await service.open('A');
  await service.open('B');
  service.cancelLoad('A');
  assert.equal(service.currentUrl, 'A');
  assert.equal(committed.at(-1), 'A');
});

test('章节信息持久化后重启离线直接加载，损坏缓存回退网络', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-chapters-'));
  try {
    const cache = { prefetchAll: async () => ({ done: 1, failed: 0 }), prune() {} };
    const first = new ChapterService({ directory, cache, source: { loadChapter: async (url) => chapter(url) } });
    await first.open('A');
    let calls = 0;
    const restarted = new ChapterService({ directory, cache, source: { loadChapter: async () => { calls++; throw new Error('offline'); } } });
    assert.equal((await restarted.open('A')).ok, true);
    assert.equal(calls, 0);
    fs.writeFileSync(first.fileFor('B'), '{broken');
    assert.equal((await restarted.open('B')).error, 'offline');
    assert.equal(calls, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('连续追加只接受阅读链，切换后旧追加失效，清理保留连续阅读章节', async () => {
  const pending = deferred();
  const { service, pruned } = setup(async (url) => url === 'C' ? pending.promise : chapter(url, url === 'A' ? 'B' : url === 'B' ? 'C' : ''));
  await service.open('A');
  assert.equal((await service.append('X')).ok, false);
  assert.equal((await service.append('B')).ok, true);
  await service.prefetchUpcoming('', 0);
  assert.deepEqual(pruned.at(-1), ['A/1.jpg', 'B/1.jpg']);
  const old = service.append('C');
  await service.open('X');
  pending.resolve(chapter('C'));
  assert.equal((await old).stale, true);
  assert.deepEqual([...service.retained], ['X']);
});
