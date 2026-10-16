'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProgressStore } = require('../src/main/progress-store');
const { mergeFavorites } = require('../src/shared/favorites');
const { AdbSync } = require('../src/main/adb-sync');
const chapter = { pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html', comicName: '测试漫画', chapterName: '第七话' };
const favorite = (updatedAt, deviceId, removed = false) => ({ ...chapter,
  bookId: 'https://www.twmanga.com/comic/chapter/demo', updatedAt, deviceId, removed });
function storeFor(t, ...callbacks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-favorites-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ProgressStore(path.join(dir, 'progress.json'), ...callbacks);
}
test('同一本漫画收藏去重、继续阅读使用最新章节，重启后保留收藏', (t) => {
  const store = storeFor(t);
  store.setFavorite(chapter, false);
  store.setFavorite({ ...chapter, pageUrl: chapter.pageUrl.replace('0_6', '0_7') }, false);
  store.save({ ...chapter, pageUrl: chapter.pageUrl.replace('0_6', '0_8'), pageIndex: 4, pageOffset: 0.2 });
  assert.equal(store.listFavorites().length, 1);
  assert.ok(store.listFavorites()[0].progress.pageUrl.endsWith('0_8.html'));
  const reopened = new ProgressStore(store.file);
  assert.equal(reopened.listFavorites()[0].progress.pageIndex, 4);
  assert.equal(reopened.deviceId, store.deviceId);
});
test('取消收藏在离线重连后不会复活，之后仍可重新收藏', (t) => {
  const store = storeFor(t);
  store.merge([], true, [favorite(10, 'android-1')]);
  const old = store.favorites[0];
  store.setFavorite(chapter, true);
  store.merge([], true, [old]);
  assert.equal(store.listFavorites().length, 0);
  assert.equal(store.favorites[0].removed, true);
  store.setFavorite(chapter, false);
  assert.equal(store.listFavorites().length, 1);
});
test('仅同步收藏不弹阅读进度通知，且老格式进度文件可迁移', (t) => {
  let progressEvents = 0, favoriteEvents = 0;
  const store = storeFor(t, () => progressEvents++, () => favoriteEvents++);
  fs.writeFileSync(store.file, JSON.stringify({ records: [], deviceId: store.deviceId }));
  const reopened = new ProgressStore(store.file, () => progressEvents++, () => favoriteEvents++);
  reopened.merge([], true, [favorite(10, 'android-1')]);
  assert.equal(progressEvents, 0);
  assert.equal(favoriteEvents, 1);
});
test('收藏冲突确定性收敛、非法收藏不能部分写入进度', (t) => {
  const a = favorite(20, 'android-a'), b = favorite(20, 'desktop-z', true);
  assert.deepEqual(mergeFavorites([a], [b]), mergeFavorites([b], [a]));
  const store = storeFor(t);
  const record = { ...chapter, bookId: a.bookId, updatedAt: 30, deviceId: 'android-a', pageIndex: 1, pageOffset: 0 };
  assert.throws(() => store.merge([record], true, [{ ...a, removed: 'yes' }]));
  assert.equal(store.records.length, 0);
  assert.equal(store.favorites.length, 0);
});
test('ADB 同步接口支持收藏和删除，同时兼容旧客户端', async (t) => {
  const store = storeFor(t);
  const sync = new AdbSync({ store, dir: path.dirname(store.file), port: 0 });
  await sync.start({ monitor: false });
  t.after(() => sync.stop());
  const exchange = async (favorites) => {
    const response = await fetch(`http://127.0.0.1:${sync.port}/v1/sync`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Comic-Sync-Trigger': 'manual', Authorization: `Bearer ${sync.token}` },
      body: JSON.stringify({ version: 1, records: [], ...(favorites ? { favorites } : {}) }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await exchange([favorite(10, 'android-1')])).favorites.length, 1);
  assert.equal((await exchange([favorite(20, 'android-1', true)])).favorites[0].removed, true);
  assert.equal((await exchange()).favorites[0].removed, true);
});
