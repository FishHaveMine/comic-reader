'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const { ImageCache } = require('../src/main/image-cache');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comic-prune-'));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600)]);

function seed(cache, urls) {
  fs.mkdirSync(cache.dir, { recursive: true });
  for (const url of urls) fs.writeFileSync(cache.pathFor(url), JPEG);
}

const names = (cache) => fs.readdirSync(cache.dir).sort();

describe('ImageCache.prune 保留窗口清理', () => {
  test('只保留保留集里的图片，其余删除', () => {
    const cache = new ImageCache(tempDir(), { log: () => {} });
    const keep = ['https://cdn/ch1/1.jpg', 'https://cdn/ch1/2.jpg'];
    const drop = ['https://cdn/ch0/1.jpg', 'https://cdn/ch9/1.jpg'];
    seed(cache, [...keep, ...drop]);
    assert.equal(names(cache).length, 4);

    const result = cache.prune(keep);

    assert.equal(result.deleted, 2);
    assert.equal(result.freed, JPEG.length * 2);
    assert.deepEqual(names(cache), keep.map((u) => path.basename(cache.pathFor(u))).sort());
  });

  test('保留集为空时一张都不删（防止上游异常清空整个缓存）', () => {
    const cache = new ImageCache(tempDir(), { log: () => {} });
    seed(cache, ['https://cdn/a/1.jpg', 'https://cdn/a/2.jpg']);

    const result = cache.prune([]);

    assert.equal(result.deleted, 0);
    assert.equal(result.skipped, true);
    assert.equal(names(cache).length, 2);
  });

  test('传入非数组同样不删任何东西', () => {
    const cache = new ImageCache(tempDir(), { log: () => {} });
    seed(cache, ['https://cdn/a/1.jpg']);

    assert.equal(cache.prune(null).deleted, 0);
    assert.equal(cache.prune(undefined).deleted, 0);
    assert.equal(names(cache).length, 1);
  });

  test('正在写入的 .part 不会被误删', () => {
    const cache = new ImageCache(tempDir(), { log: () => {} });
    seed(cache, ['https://cdn/old/1.jpg']);
    const pending = `${cache.pathFor('https://cdn/new/1.jpg')}.part`;
    fs.writeFileSync(pending, Buffer.alloc(10));

    const result = cache.prune(['https://cdn/new/1.jpg']);

    assert.equal(result.deleted, 1);
    assert.deepEqual(names(cache), [path.basename(pending)]);
  });

  test('目录为空时不报错', () => {
    const cache = new ImageCache(path.join(tempDir(), 'not-created'), { log: () => {} });
    const result = cache.prune(['https://cdn/a/1.jpg']);
    assert.equal(result.deleted, 0);
    assert.equal(result.freed, 0);
  });

  test('重复清理是幂等的', () => {
    const cache = new ImageCache(tempDir(), { log: () => {} });
    seed(cache, ['https://cdn/a/1.jpg', 'https://cdn/b/1.jpg']);

    assert.equal(cache.prune(['https://cdn/a/1.jpg']).deleted, 1);
    assert.equal(cache.prune(['https://cdn/a/1.jpg']).deleted, 0);
    assert.equal(names(cache).length, 1);
  });
});
