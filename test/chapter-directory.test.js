'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { directoryUrl, parseDirectory } = require('../src/shared/chapter-directory');
const { ChapterService } = require('../src/main/chapter-service');
const url = 'https://www.twmanga.com/comic/chapter/demo/0_1.html';
const html = fs.readFileSync(path.join(__dirname, 'fixtures/directory-sample.html'), 'utf8');
test('目录解析支持实体、相对链接、分卷排序，去重并排除其他漫画与外站', () => {
  assert.equal(directoryUrl(url), 'https://www.baozimh.com/comic/demo');
  const entries = parseDirectory(html, url, 'https://cn.bzmgcn.com/comic/demo');
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((entry) => entry.title), ['第 1 话', '第 2 话', '第 3 话 & 重逢', '番外 1']);
  assert.equal(entries[1].pageUrl, url);
  assert.throws(() => directoryUrl('https://evil.example/comic/chapter/demo/0_1.html'));
});
test('目录请求合并、跨章复用、重启离线恢复、刷新失败不丢缓存', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-directory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0, fail = false;
  const source = { loadDirectory: async () => { calls++; if (fail) throw new Error('offline'); return parseDirectory(html, url); } };
  const service = new ChapterService({ directory, source, cache: {} });
  await Promise.all([service.directoryFor(url), service.directoryFor(url)]);
  assert.equal(calls, 1);
  assert.equal((await service.directoryFor(url.replace('0_1', '0_2'))).cached, true);
  fail = true;
  const reopened = new ChapterService({ directory, source, cache: {} });
  assert.equal((await reopened.directoryFor(url)).entries.length, 4);
  assert.equal(calls, 1);
  await assert.rejects(reopened.directoryFor(url, true));
  assert.equal((await reopened.directoryFor(url)).entries.length, 4);
});

test('实际 dzmanga 域名与分段章节网址可以打开主章节目录', () => {
  const partial = 'https://cn.dzmanga.com/comic/chapter/demo/0_1_3.html';
  assert.equal(directoryUrl(partial), 'https://www.baozimh.com/comic/demo');
  const entries = parseDirectory(html, partial);
  assert.equal(entries[1].pageUrl, 'https://cn.dzmanga.com/comic/chapter/demo/0_1.html');
});
