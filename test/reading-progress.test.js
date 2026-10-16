'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bookIdFor, mergeRecords } = require('../src/shared/reading-progress');
const { ProgressStore } = require('../src/main/progress-store');
const { AdbSync, parseDevices } = require('../src/main/adb-sync');
const record = (updatedAt = 10, deviceId = 'desktop-1', pageIndex = 1) => ({
  bookId: 'https://www.twmanga.com/comic/chapter/demo', pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
  comicName: '漫画', chapterName: '第七话', pageIndex, pageOffset: 0.4, updatedAt, deviceId,
});

test('同一本书的不同章节共用进度标识', () => {
  assert.equal(bookIdFor(record().pageUrl), bookIdFor(record().pageUrl.replace('0_6', '0_7')));
});
test('最新阅读时间优先，相同时间按设备标识确定一致结果', () => {
  assert.deepEqual(mergeRecords([record()], [record(20, 'android-1', 4)]), [record(20, 'android-1', 4)]);
  const a = record(20, 'android-a', 2), b = record(20, 'desktop-z', 1);
  assert.deepEqual(mergeRecords([a], [b]), mergeRecords([b], [a]));
  assert.deepEqual(mergeRecords([b], [a, b]), [b]);
});
test('非法进度不会部分合并', () => {
  const input = [record()];
  assert.throws(() => mergeRecords(input, [record(20), { ...record(30), pageOffset: 2 }]));
  assert.deepEqual(input, [record()]);
  assert.throws(() => mergeRecords([], [{ ...record(), pageUrl: 'file:///etc/passwd' }]));
});
test('进度原子落盘、重启保留设备标识、导入后本地时间单调递增', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProgressStore(path.join(dir, 'progress.json'));
  store.save(record());
  const reopened = new ProgressStore(store.file);
  assert.equal(reopened.deviceId, store.deviceId);
  assert.equal(reopened.latest().pageIndex, 1);
  const future = Date.now() + 10000;
  reopened.merge([record(future, 'android-1', 4)]);
  assert.ok(reopened.save(record()).updatedAt > future);
});
test('同步接口双向合并并阻止未配对、网页来源及非法数据', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-sync-'));
  const store = new ProgressStore(path.join(dir, 'progress.json'));
  store.merge([record()]);
  const sync = new AdbSync({ store, dir, port: 0 });
  await sync.start({ monitor: false });
  t.after(async () => { await sync.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (data, headers = {}) => fetch(`http://127.0.0.1:${sync.port}/v1/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Comic-Sync-Trigger': 'manual', Authorization: `Bearer ${sync.token}`, ...headers },
    body: JSON.stringify(data),
  });
  const response = await request({ version: 1, records: [record(30, 'android-1', 5)] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).records[0].pageIndex, 5);
  assert.equal(store.latest().deviceId, 'android-1');
  assert.equal((await request({ version: 1, records: [] }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request({ version: 1, records: [] }, { Origin: 'http://example.com' })).status, 401);
  assert.equal((await request({ version: 9, records: [] })).status, 400);
  assert.equal((await request({ version: 1, records: [{ ...record(), pageIndex: -1 }] })).status, 400);
  assert.equal(store.latest().pageIndex, 5);
  assert.equal((await request({ version: 1, records: [record(999, 'android-test', 99)] }, { 'X-Comic-Sync-Trigger': '' })).status, 409);
  assert.equal(store.latest().pageIndex, 5);
  const pull = await request({ version: 1, records: [record()] });
  assert.equal((await pull.json()).records[0].pageIndex, 5);
});
test('ADB 只配对已授权设备，重连重新配对、已连接设备不反复启动', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-adb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let devices = 'List of devices attached\nphone\tdevice\nlocked\tunauthorized\noff\toffline\n';
  const sync = new AdbSync({ store: new ProgressStore(path.join(dir, 'progress.json')), dir,
    command: async (_exe, args) => {
      calls.push(args);
      return { stdout: args[0] === 'devices' ? devices : args.includes('pm') ? 'package:com.comicreader.comic_reader' : 'Starting: Intent', stderr: '' };
    } });
  assert.deepEqual(parseDevices(devices), ['phone']);
  await sync.scan(); await sync.scan();
  assert.equal(calls.filter((args) => args.includes('am')).length, 1);
  assert.ok(calls.some((args) => args.includes('reverse')));
  devices = 'List of devices attached\n'; await sync.scan();
  assert.equal(sync.status.state, 'disconnected');
  devices = 'phone\tdevice\n'; await sync.scan();
  assert.equal(calls.filter((args) => args.includes('am')).length, 2);
});

test('按最新阅读时间处理回看，而不是选择章号或页码较大的一端', () => {
  const older = { ...record(10, 'desktop-1', 99), pageUrl: record().pageUrl.replace('0_6', '0_9') };
  const newer = record(20, 'android-1', 0);
  assert.deepEqual(mergeRecords([older], [newer]), [newer]);
  assert.deepEqual(mergeRecords([newer], [older]), [newer]);
  assert.deepEqual(mergeRecords([newer, older], []), [newer]);
});
test('相同设备及时间的冲突也确定性收敛，重复合并不改时间', () => {
  const a = record(20, 'desktop-1', 1), b = record(20, 'desktop-1', 4);
  assert.deepEqual(mergeRecords([a], [b]), mergeRecords([b], [a]));
  assert.equal(mergeRecords([b], [a, b])[0].updatedAt, 20);
});
test('延迟落盘使用实际阅读时间，远端新进度不能被旧页面反写', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-observed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ProgressStore(path.join(dir, 'progress.json'));
  store.save(record(10), { observedAt: 10 });
  const remote = record(20, 'android-1', 5);
  store.merge([remote]);
  assert.deepEqual(store.save(record(10, 'desktop-1', 2), { observedAt: 15 }), remote);
  assert.deepEqual(new ProgressStore(store.file).latest(), remote);
  const newer = store.save(record(10, 'desktop-1', 1), { observedAt: 30 });
  assert.equal(newer.pageIndex, 1);
  assert.equal(newer.updatedAt, 30);
  store.merge([remote]);
  assert.deepEqual(store.latest(), newer);
  assert.equal(store.save(newer).updatedAt, 30);
});

test('设备配对不触发同步，只有手动操作向手机发送同步请求', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-manual-sync-'));
  const store = new ProgressStore(path.join(dir, 'progress.json'));
  let requests = 0;
  const sync = new AdbSync({ store, dir, port: 0, command: async (_exe, args) => {
    if (args[0] === 'devices') return { stdout: 'phone\tdevice\n', stderr: '' };
    if (args.includes('pm')) return { stdout: 'package:com.comicreader.comic_reader', stderr: '' };
    if (args.includes('sync_request')) {
      requests++;
      const requestId = args[args.indexOf('sync_request') + 1];
      const response = await fetch(`http://127.0.0.1:${sync.port}/v1/sync`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Comic-Sync-Trigger': 'manual', Authorization: `Bearer ${sync.token}` },
        body: JSON.stringify({ version: 1, records: [record(20, 'android-test', 4)], requestId }) });
      assert.equal(response.status, 200);
    }
    return { stdout: 'Starting: Intent', stderr: '' };
  } });
  await sync.start({ monitor: false });
  t.after(async () => { await sync.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await sync.scan(); await sync.scan();
  assert.equal(requests, 0); assert.equal(store.records.length, 0);
  const task = sync.requestSync();
  assert.equal(sync.requestSync(), task);
  assert.equal((await task).ok, true);
  assert.equal(requests, 1); assert.equal(store.latest().pageIndex, 4);
  await sync.scan(); assert.equal(requests, 1);
});
