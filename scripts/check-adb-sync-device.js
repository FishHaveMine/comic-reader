'use strict';

// 在已授权手机上验证真实 Flutter 客户端。临时站点/同步目录隔离，结束恢复应用进度文件。
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { ProgressStore } = require('../src/main/progress-store');
const { AdbSync, parseDevices, findAdb, PACKAGE, PORT } = require('../src/main/adb-sync');
const run = promisify(execFile);
const adb = findAdb();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const desktopRunning = await new Promise((resolve) => {
    const socket = require('node:net').createConnection({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
  if (desktopRunning) throw new Error('请先退出桌面阅读器再运行真机测试，避免正常同步进程与测试配对互相覆盖');
  const devices = parseDevices((await run(adb, ['devices'])).stdout);
  const serial = process.env.COMIC_DEVICE || (devices.length === 1 ? devices[0] : '');
  if (!serial) throw new Error('需要一台已授权的手机；多设备时设置 COMIC_DEVICE');
  const cmd = (...args) => run(adb, ['-s', serial, ...args], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const appFile = 'files/reading-progress.json';
  let original = null;
  try { original = (await cmd('shell', 'run-as', PACKAGE, 'cat', appFile)).stdout; } catch { /* 尚未保存进度 */ }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-device-sync-'));
  if (original !== null) fs.writeFileSync(path.join(temp, 'phone-backup.json'), original, { mode: 0o600 });
  const store = new ProgressStore(path.join(temp, 'progress.json'));
  const sync = new AdbSync({ store, dir: temp, port: 0 });
  const fixture = http.createServer((req, res) => {
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(path.join(__dirname, '../build/icon.png')));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<title>同步测试 - 测试漫画 - 包子漫畫</title><meta name="description" content="《测试漫画》"><span class="title">ADB 同步测试</span>${Array.from({ length: 6 }, (_, i) => `<amp-img id="chapter-img-0-${i}" src="/${i + 1}.png" width="800" height="1000"></amp-img>`).join('')}`);
    }
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = fixture.address().port;
  const url = `http://127.0.0.1:${fixturePort}/comic/chapter/sync-fixture/0_1.html`;
  if (original) {
    const previous = JSON.parse(original);
    store.merge(previous.records || [], false, previous.favorites || []);
  }
  const desktop = store.save({ pageUrl: url, comicName: '测试漫画', chapterName: 'ADB 同步测试', pageIndex: 1, pageOffset: 0.3 });
  store.setFavorite({ pageUrl: url, comicName: '测试漫画', chapterName: 'ADB 同步测试' }, false);
  const uiFile = '/sdcard/comic-reader-test-ui.xml';
  const ui = async () => {
    await cmd('shell', 'uiautomator', 'dump', uiFile);
    return (await cmd('shell', 'cat', uiFile)).stdout;
  };
  const tapDescription = async (description) => {
    let xml = await ui();
    if (!xml.includes(`content-desc="${description}"`) && !xml.includes(`text="${description}"`)) {
      await cmd('shell', 'input', 'tap', '600', '1000');
      await pause(250);
      xml = await ui();
    }
    const node = [...xml.matchAll(/<node\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes(`content-desc="${description}"`) || tag.includes(`text="${description}"`));
    const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) throw new Error(`未找到手机操作：${description}`);
    // XML 快照可能耗时超过自动收起时间，点击标题先恢复/延长工具栏显示。
    if (description === '我的收藏' || description === '取消收藏') {
      await cmd('shell', 'input', 'tap', '100', '170');
      await pause(100);
    }
    await cmd('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
  };
  const waitFor = async (condition, label, timeout = 20000) => {
    const start = Date.now();
    while (!await condition()) {
      if (Date.now() - start > timeout) {
        await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }).then(({ stdout }) => fs.writeFileSync('/tmp/comic-device-sync-failure.png', stdout));
        const mobile = await readMobile();
        console.log('fixture progress', mobile?.records.filter((record) => record.bookId === desktop.bookId).map(({ pageIndex, pageOffset, updatedAt, deviceId }) => ({ pageIndex, pageOffset, updatedAt, deviceId })));
        throw new Error(`验证超时：${label}`);
      }
      await pause(300);
    }
  };
  const readMobile = async () => {
    try { return JSON.parse((await cmd('shell', 'run-as', PACKAGE, 'cat', appFile)).stdout); } catch { return null; }
  };
  try {
    await cmd('shell', 'am', 'force-stop', PACKAGE);
    await cmd('reverse', `tcp:${fixturePort}`, `tcp:${fixturePort}`);
    await sync.start();
    assert.equal((await sync.requestSync()).ok, true);
    await waitFor(async () => (await readMobile())?.records.some((record) => record.bookId === desktop.bookId && record.pageIndex === 1 && record.pageOffset === 0.3), '桌面进度下发');
    console.log('PASS 真机 ADB 配对与手动桌面→Android 进度同步');
    await tapDescription('继续阅读');
    await waitFor(async () => (await readMobile())?.favorites?.some((favorite) => favorite.bookId === desktop.bookId && !favorite.removed), '桌面收藏同步到手机');
    const chapterFile = require('node:crypto').createHash('sha1').update(url).digest('hex') + '.json';
    await waitFor(async () => (await cmd('shell', 'run-as', PACKAGE, 'ls', 'files/chapters')).stdout.includes(chapterFile), '手机独立解析章节');
    await pause(1200);
    await cmd('shell', 'input', 'swipe', '600', '1800', '600', '700', '500');
    await pause(700);
    assert.equal((await sync.requestSync()).ok, true);
    await waitFor(async () => {
      const latest = store.records.find((record) => record.bookId === desktop.bookId);
      return latest?.deviceId.startsWith('android-') && latest.updatedAt > desktop.updatedAt;
    }, '手机滚动进度上传');
    const phone = store.records.find((record) => record.bookId === desktop.bookId);
    assert.ok(phone.pageIndex > desktop.pageIndex || phone.pageOffset > desktop.pageOffset);
    console.log('PASS 真机滚动自动保存与 Android→桌面同步');
    await cmd('reverse', '--remove', `tcp:${sync.port}`);
    clearInterval(sync.timer);
    const before = phone.updatedAt;
    await cmd('shell', 'input', 'swipe', '600', '1800', '600', '1100', '400');
    await waitFor(async () => (await readMobile())?.records.some((record) => record.bookId === desktop.bookId && record.updatedAt > before), '离线本地保存');
    assert.equal(store.records.find((record) => record.bookId === desktop.bookId).updatedAt, before);
    sync.paired.clear();
    await sync.scan();
    assert.equal(store.records.find((record) => record.bookId === desktop.bookId).updatedAt, before);
    assert.equal((await sync.requestSync()).ok, true);
    await waitFor(async () => store.records.find((record) => record.bookId === desktop.bookId).updatedAt > before, '重连补同步');
    console.log('PASS 断开 ADB 后保留本地进度，重新连接补同步');
    await pause(3500);
    assert.ok(!(await ui()).includes('content-desc="我的收藏"'));
    console.log('PASS 真机阅读时自动隐藏操作栏');
    await tapDescription('我的收藏');
    await pause(350);
    await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }).then(({ stdout }) => fs.writeFileSync('/tmp/comic-mobile-favorites.png', stdout));
    assert.ok((await ui()).includes('我的收藏 ·'));
    await cmd('shell', 'input', 'keyevent', '4');
    await pause(350);
    await tapDescription('取消收藏');
    await pause(700);
    assert.equal((await sync.requestSync()).ok, true);
    await waitFor(async () => store.favorites.some((favorite) => favorite.bookId === desktop.bookId && favorite.removed), '手机取消收藏同步回桌面');
    console.log('PASS 真机收藏列表、取消收藏与双向同步');
  } finally {
    try {
    for (let retry = 0; ; retry++) {
      try { await cmd('shell', 'am', 'force-stop', PACKAGE); break; }
      catch (error) { if (retry >= 5) throw error; await pause(1000); }
    }
    await cmd('shell', 'rm', '-f', uiFile).catch(() => {});
    if (original !== null) {
      await new Promise((resolve, reject) => {
        const writer = spawn(adb, ['-s', serial, 'shell', 'run-as', PACKAGE, 'sh', '-c', `'cat > ${appFile}'`], { stdio: ['pipe', 'ignore', 'pipe'] });
        writer.on('error', reject); writer.on('close', (code) => code ? reject(new Error('恢复手机进度失败')) : resolve());
        writer.stdin.end(original);
      });
    } else {
      await cmd('shell', 'run-as', PACKAGE, 'rm', '-f', appFile);
    }
    } finally {
      await sync.stop();
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
    }
    await cmd('reverse', '--remove', `tcp:${fixturePort}`).catch(() => {});
    await cmd('reverse', '--remove', `tcp:${sync.port}`).catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
    await cmd('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
