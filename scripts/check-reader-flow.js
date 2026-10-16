'use strict';

// 用真实 Electron/DOM 与模拟站点响应验证阅读交互，不访问用户配置或线上站点。
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-flow-'));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'comicimg', privileges: { standard: true, secure: true } }]);
const pending = new Map();
const loads = [];
let brokenAttempts = 0;
const savedProgress = [];
let homeOpened = 0;
let syncLatest = null;
let syncClicks = 0;
const { ProgressStore } = require('../src/main/progress-store');
const favoriteStore = new ProgressStore(path.join(profile, 'progress.json'));
let win;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (url) => ({
  pageUrl: url, title: `测试 · ${url}`, comicName: '流程测试漫画名称', chapterName: url,
  prevUrl: 'previous', nextUrl: 'next',
  images: Array.from({ length: 3 }, (_, i) => ({ url: `https://fixture/${url}/${i === 0 && url === 'retry' ? 'broken' : i}.svg`, width: 800, height: 1000 })),
});
async function evaluate(code) { return win.webContents.executeJavaScript(code); }
async function until(code, timeout = 5000) {
  const start = Date.now();
  while (!await evaluate(code)) {
    if (Date.now() - start > timeout) throw new Error(`等待失败：${code}`);
    await pause(30);
  }
}
async function open(url) {
  await evaluate(`document.getElementById('url-input').value = ${JSON.stringify(url)}; document.getElementById('jump-form').requestSubmit();`);
}

app.whenReady().then(async () => {
  protocol.handle('comicimg', (request) => {
    const url = new URL(request.url).searchParams.get('u');
    if (url.includes('broken') && ++brokenAttempts <= 2) return new Response('模拟断网', { status: 502 });
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#253046"/><text x="60" y="200" fill="white" font-size="36">Reader flow fixture</text></svg>`, { headers: { 'Content-Type': 'image/svg+xml' } });
  });
  ipcMain.handle('app:context', () => ({ platform: process.platform, autoNext: true, defaultUrl: 'initial' }));
  ipcMain.handle('catalog:open', () => { homeOpened++; return true; });
  ipcMain.handle('app:set-auto-next', (_e, flag) => flag);
  ipcMain.handle('chapter:cancel', () => {});
  const appended = [];
  ipcMain.handle('chapter:append', (_e, url) => { appended.push(url); return { ok: true, chapter: { ...fixture(url), nextUrl: '' } }; });
  ipcMain.handle('progress:save', (_e, record) => { savedProgress.push(record); if (record.pageUrl.startsWith('https://')) favoriteStore.save(record); return { ok: true, record }; });
  ipcMain.handle('favorites:list', () => favoriteStore.listFavorites());
  ipcMain.handle('favorites:set', (_e, favorite, removed) => ({ ok: true, favorites: favoriteStore.setFavorite(favorite, removed) }));
  ipcMain.handle('progress:latest', () => syncLatest || favoriteStore.latest());
  ipcMain.handle('sync:now', () => { syncClicks++; return { ok: true }; });
  ipcMain.handle('sync:status', () => ({ detail: 'ADB 测试' }));
  ipcMain.handle('cache:stats', () => ({ files: 3, bytes: 1024 }));
  ipcMain.handle('chapter:directory', (_e, url) => ({ ok: true, cached: true, entries: [
    { pageUrl: url.replace(/(\d+_\d+)(?:_\d+)?\.html$/, '$1.html'), title: '正在看的章节', section: 0, index: 0 },
    { pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_9.html', title: '第 9 话 跳转测试', section: 0, index: 8 },
  ] }));
  ipcMain.handle('chapter:prefetch', () => ({ ok: true }));
  ipcMain.handle('chapter:load', (_e, url) => {
    loads.push(url);
    if (url === 'slow' || url === 'cancel') return new Promise((resolve) => pending.set(url, resolve));
    if (url === 'failure') throw new Error('模拟网络故障');
    return { ok: true, chapter: fixture(url), progress: url === 'initial' ? { pageUrl: url, pageIndex: 1, pageOffset: 0.35 } : null };
  });
  win = new BrowserWindow({ width: 1000, height: 820, show: true,
    webPreferences: { preload: path.join(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !message.includes('502')) errors.push(message);
  });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await until("document.getElementById('chapter-name').textContent === 'initial'");

  await pause(100);
  const restored = await evaluate(`(() => {
    const page = document.querySelectorAll('.page')[1];
    return Math.abs(window.scrollY + 54 - (page.offsetTop + page.offsetHeight * 0.35)) < 2;
  })()`);
  assert.equal(restored, true);
  assert.equal(savedProgress.length, 0);
  console.log('PASS 启动恢复页内位置，不将恢复动作误记成新进度');

  await open('slow');
  await until("document.getElementById('btn-next').disabled");
  await open('latest');
  await until("document.getElementById('chapter-name').textContent === 'latest'");
  pending.get('slow')({ ok: true, chapter: fixture('slow') });
  await pause(80);
  assert.equal(await evaluate("document.getElementById('chapter-name').textContent"), 'latest');
  console.log('PASS 快速切换忽略旧响应并恢复导航');

  await open('failure');
  await until("!document.getElementById('overlay-retry').hidden");
  assert.equal(await evaluate("document.getElementById('overlay-back').hidden"), false);
  await evaluate("document.getElementById('overlay-back').click()");
  assert.equal(await evaluate("document.getElementById('overlay').hidden"), true);
  console.log('PASS IPC 异常可重试或返回当前阅读');

  await open('cancel');
  await until("!document.getElementById('overlay').hidden");
  await evaluate("document.getElementById('overlay-back').click()");
  pending.get('cancel')({ ok: true, chapter: fixture('cancel') });
  await pause(80);
  assert.equal(await evaluate("document.getElementById('chapter-name').textContent"), 'latest');
  console.log('PASS 返回阅读使未完成请求失效');

  await open('retry');
  await until("document.querySelector('.page__error button') !== null");
  await evaluate("document.querySelector('.page__error button').click()");
  await until("document.querySelector('.page__error button') !== null");
  await evaluate("document.querySelector('.page__error button').click()");
  await until("document.querySelector('.page__error') === null");
  assert.equal(brokenAttempts, 3);
  await open('continuous');
  await until("document.getElementById('chapter-name').textContent === 'continuous'");
  await evaluate("window.scrollTo(0, 0)");
  await pause(80);
  const beforeAppend = appended.length;
  await evaluate("window.scrollTo(0, document.querySelectorAll('.page')[1].offsetTop)");
  const offset = await evaluate('window.scrollY');
  await until("document.querySelectorAll('.page').length === 6");
  assert.equal(await evaluate('window.scrollY'), offset);
  assert.equal(appended.length, beforeAppend + 1);
  assert.equal(await evaluate("document.getElementById('autonext') === null"), true);
  await evaluate("window.scrollTo(0, document.querySelectorAll('.page')[4].offsetTop)");
  await until("document.getElementById('chapter-name').textContent === 'next'");
  await pause(650);
  assert.equal(savedProgress.at(-1).pageUrl, 'next');
  assert.equal(savedProgress.at(-1).pageIndex, 1);
  await evaluate("document.getElementById('url-input').focus(); document.getElementById('url-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  await pause(80);
  assert.equal(appended.length, beforeAppend + 1);
  console.log('PASS 中段追加下一章不改变滚动位置，跨章进度按章节保存，不重复追加');

  await open('https://cn.dzmanga.com/comic/chapter/demo/0_6_3.html');
  await until("document.getElementById('chapter-name').textContent.endsWith('0_6_3.html')");
  await evaluate("document.getElementById('btn-chapters').click()");
  await until("document.querySelectorAll('#chapters-list button').length === 2");
  assert.equal(await evaluate("document.querySelector('#chapters-list [aria-current=true]').textContent.includes('正在阅读')"), true);
  if (process.env.COMIC_DIRECTORY_SCREENSHOT) {
    await evaluate(`(() => {
      const list = document.getElementById('chapters-list');
      for (let i = 10; i < 40; i++) {
        const row = list.lastElementChild.cloneNode(true);
        row.querySelector('.chapter-row__title').textContent = '第 ' + i + ' 话 新的冒险';
        row.querySelector('.chapter-row__number').textContent = String(i).padStart(3, '0');
        list.append(row);
      }
    })()`);
    fs.writeFileSync(process.env.COMIC_DIRECTORY_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    const before = await evaluate("document.getElementById('chapters-close').getBoundingClientRect().top");
    await evaluate("document.getElementById('chapters-list').scrollTop = 10000");
    assert.equal(await evaluate("document.getElementById('chapters-close').getBoundingClientRect().top"), before);
    await evaluate("document.getElementById('chapters-search').dispatchEvent(new Event('input'))");
  }
  await evaluate("document.getElementById('chapters-order').click()");
  assert.equal(await evaluate("document.querySelector('#chapters-list .chapter-row__title').textContent"), '第 9 话 跳转测试');
  await evaluate("document.getElementById('chapters-search').value='第 9'; document.getElementById('chapters-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('#chapters-list button').length"), 1);
  await evaluate("document.querySelector('#chapters-list button').click()");
  await until("document.getElementById('chapter-name').textContent.endsWith('0_9.html')");
  assert.equal(await evaluate("document.getElementById('chapters-dialog').open"), false);
  console.log('PASS 原生章节目录、当前章标记、排序、搜索与跳转阅读');

  const badge = await evaluate("document.getElementById('badge').textContent");
  win.webContents.send('prefetch:progress', { ownerUrl: 'old', url: 'next', label: '下一章', status: 'done', total: 10 });
  win.webContents.send('loading:phase', { phase: 'warming' });
  await pause(80);
  assert.equal(await evaluate("document.getElementById('badge').textContent"), badge);
  assert.equal(await evaluate("document.getElementById('overlay').hidden"), true);
  console.log('PASS 旧预取及后台验证不会打断当前阅读');

  const savedCount = savedProgress.length;
  win.webContents.send('progress:changed', { pageUrl: 'remote', pageIndex: 1, pageOffset: 0.6,
    deviceId: 'android-test', updatedAt: Date.now(), chapterName: '手机章节' });
  await until("document.getElementById('status-sync').textContent.includes('手机章节')");
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await pause(80);
  assert.equal(savedProgress.length, savedCount);
  syncLatest = { pageUrl: 'remote-latest', pageIndex: 1, pageOffset: 0.6,
    deviceId: 'android-test', updatedAt: Date.now() + 10000, chapterName: '再次更新的手机章节' };
  assert.equal(syncClicks, 0);
  await evaluate("document.getElementById('status-sync').click()");
  await until("!document.getElementById('status-sync').disabled");
  assert.equal(syncClicks, 1);
  await until("document.getElementById('chapter-name').textContent === 'remote-latest'");
  await pause(100);
  assert.equal(await evaluate(`(() => {
    const page = document.querySelectorAll('.page')[1];
    return Math.abs(window.scrollY + 54 - (page.offsetTop + page.offsetHeight * 0.6)) < 2;
  })()`), true);
  assert.equal(savedProgress.length, savedCount);
  console.log('PASS 退出保存不反写旧位置，点击继续重新读取两端合并后的最新记录');
  syncLatest = null;

  win.setSize(420, 800);
  await pause(150);
  const bounds = await evaluate(`(() => {
    const input = document.getElementById('url-input').getBoundingClientRect();
    const next = document.getElementById('btn-next').getBoundingClientRect();
    return { inputWidth: input.width, nextRight: next.right, width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.ok(bounds.inputWidth > 80, JSON.stringify(bounds));
  assert.ok(bounds.nextRight <= bounds.width, JSON.stringify(bounds));
  assert.equal(bounds.overflow, false);
  if (process.env.COMIC_FLOW_SCREENSHOT) {
    fs.writeFileSync(process.env.COMIC_FLOW_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  console.log('PASS 420px 窄窗口地址输入与翻章按钮可用');
  await evaluate("document.getElementById('btn-home').click()");
  await pause(100);
  assert.equal(homeOpened, 1);
  const pickedChapter = 'https://www.twmanga.com/comic/chapter/picked/0_1.html';
  win.webContents.send('catalog:chapter', pickedChapter);
  await until("document.getElementById('chapter-name').textContent.includes('/picked/')");
  console.log('PASS 返回首页入口和选章后进入阅读器');

  const favoriteUrl = 'https://www.twmanga.com/comic/chapter/demo/0_1.html';
  await open(favoriteUrl);
  await until("!document.getElementById('btn-favorite').disabled");
  await until(`window.reader.latestProgress().then(record => record?.pageUrl === ${JSON.stringify(favoriteUrl)})`);
  await evaluate("document.getElementById('btn-favorite').click()");
  await until("document.getElementById('btn-favorite').getAttribute('aria-pressed') === 'true'");
  await open(favoriteUrl.replace('0_1', '0_2'));
  await until("document.getElementById('chapter-name').textContent.endsWith('0_2.html')");
  assert.equal(await evaluate("document.getElementById('btn-favorite').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.getElementById('btn-favorites').click()");
  await until("document.querySelectorAll('.favorites__row').length === 1");
  assert.ok(await evaluate("document.querySelector('.favorites__open').textContent.includes('继续阅读')"));
  if (process.env.COMIC_FAVORITES_SCREENSHOT) fs.writeFileSync(process.env.COMIC_FAVORITES_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await evaluate("document.getElementById('favorites-search').value = '不存在'; document.getElementById('favorites-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.favorites__row').length"), 0);
  await evaluate("document.getElementById('favorites-search').value = ''; document.getElementById('favorites-search').dispatchEvent(new Event('input')); document.querySelector('.favorites__remove').click()");
  await until("document.querySelectorAll('.favorites__row').length === 0");
  assert.equal(favoriteStore.favorites[0].removed, true);
  assert.equal(await evaluate("document.getElementById('btn-favorite').getAttribute('aria-pressed')"), 'false');
  await evaluate("document.getElementById('favorites-close').click()");
  assert.equal(await evaluate("document.getElementById('favorites-dialog').open"), false);
  console.log('PASS 收藏去重、跨章节星标、收藏列表搜索和取消收藏');
  assert.deepEqual(errors, []);

  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
app.on('quit', () => fs.rmSync(profile, { recursive: true, force: true }));
