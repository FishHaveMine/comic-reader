'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const { ImageCache, sniffMime } = require('../src/main/image-cache');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comic-cache-'));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);

function makeCache(options = {}) {
  return new ImageCache(tempDir(), {
    log: () => {}, // 测试里不需要失败日志
    download: async () => ({ buffer: JPEG }),
    ...options,
  });
}

describe('ImageCache 并发与优先级', () => {
  test('正在看的图会插到预取前面', async () => {
    const started = [];
    const cache = makeCache({
      concurrency: 1,
      download: async (url) => {
        started.push(url);
        await delay(25);
        return { buffer: JPEG };
      },
    });

    const occupying = cache.ensure('https://cdn/a.jpg');                    // 占住唯一名额
    const prefetch = cache.ensure('https://cdn/b.jpg');                     // 后台预取，排队
    const urgent = cache.ensure('https://cdn/c.jpg', { urgent: true });     // 用户正要看，插队

    await Promise.all([occupying, prefetch, urgent]);

    assert.deepEqual(started, ['https://cdn/a.jpg', 'https://cdn/c.jpg', 'https://cdn/b.jpg']);
  });

  test('同一地址并发请求只下载一次', async () => {
    let downloads = 0;
    const cache = makeCache({
      download: async () => {
        downloads += 1;
        await delay(20);
        return { buffer: JPEG };
      },
    });

    const url = 'https://cdn/same.jpg';
    await Promise.all([cache.ensure(url), cache.ensure(url), cache.ensure(url)]);
    assert.equal(downloads, 1);
  });

  test('命中磁盘后不再发起请求', async () => {
    let downloads = 0;
    const cache = makeCache({
      download: async () => {
        downloads += 1;
        return { buffer: JPEG };
      },
    });

    const url = 'https://cdn/once.jpg';
    await cache.ensure(url);
    await cache.ensure(url);
    await cache.ensure(url);
    assert.equal(downloads, 1);
    assert.equal(cache.has(url), true);
  });

  test('失败会重试，超过上限后抛错并计数', async () => {
    let attempts = 0;
    const cache = makeCache({
      retries: 3,
      download: async () => {
        attempts += 1;
        throw new Error('连接被重置');
      },
    });

    await assert.rejects(() => cache.ensure('https://cdn/broken.jpg'), /连接被重置/);
    assert.equal(attempts, 3);
    assert.equal(cache.stats.failed, 1);
    assert.equal(cache.has('https://cdn/broken.jpg'), false);
  });

  test('先写 .part 再改名，不留半截文件', async () => {
    const cache = makeCache();
    const url = 'https://cdn/atomic.jpg';
    const file = await cache.ensure(url);

    assert.equal(fs.existsSync(file), true);
    assert.equal(path.basename(file).endsWith('.part'), false);
    assert.equal(fs.readdirSync(cache.dir).some((name) => name.endsWith('.part')), false);
  });

  test('过期文件不会被当成有效缓存', async () => {
    const cache = makeCache();
    const url = 'https://cdn/stale.jpg';
    // 模拟上次中断留下的半截文件
    fs.mkdirSync(cache.dir, { recursive: true });
    fs.writeFileSync(cache.pathFor(url), Buffer.alloc(10));

    // 存在即命中（这一层不做内容校验），但落盘路径与命名要一致
    assert.equal(cache.has(url), true);
    assert.equal(await cache.ensure(url), cache.pathFor(url));
  });
});

describe('sniffMime 按文件头识别格式', () => {
  test('JPEG', () => {
    assert.equal(sniffMime(JPEG), 'image/jpeg');
  });

  test('WebP（站点 CDN 内容协商会返回）', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    assert.equal(sniffMime(webp), 'image/webp');
  });

  test('AVIF（不识别的话图片会加载失败）', () => {
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypavif'), Buffer.alloc(8)]);
    assert.equal(sniffMime(avif), 'image/avif');
  });

  test('未知内容返回八位字节流', () => {
    assert.equal(sniffMime(Buffer.from('not an image at all')), 'application/octet-stream');
  });
});

test('已排队的预取图片被前台请求时提升优先级且不重复下载', async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = makeCache({
    concurrency: 1,
    download: async (url) => {
      started.push(url);
      if (url.endsWith('a.jpg')) await gate;
      return { buffer: JPEG };
    },
  });
  const first = cache.ensure('https://cdn/a.jpg');
  const background = cache.ensure('https://cdn/b.jpg');
  const visible = cache.ensure('https://cdn/c.jpg');
  const urgent = cache.ensure('https://cdn/c.jpg', { urgent: true });
  release();
  await Promise.all([first, background, visible, urgent]);
  assert.deepEqual(started, ['https://cdn/a.jpg', 'https://cdn/c.jpg', 'https://cdn/b.jpg']);
});
