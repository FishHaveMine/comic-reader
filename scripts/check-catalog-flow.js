'use strict';
// 独立配置验证分类页搜索、目录选章，不写用户阅读记录。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-catalog-'));
app.setPath('userData', profile);
const { SessionSource } = require('../src/main/session-source');
const { CatalogWindow } = require('../src/main/catalog-window');
const { HOME_URL } = require('../src/shared/catalog-navigation');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, label, timeout = 60000) {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > timeout) throw new Error(`验证超时：${label}`);
    await pause(400);
  }
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const source = new SessionSource();
  await source.configureProxy();
  let picked = '';
  const catalog = new CatalogWindow({ session: source.session, onChapter: (url) => { picked = url; } });
  catalog.open();
  const win = catalog.window;
  win.webContents.debugger.attach('1.3');
  const evaluate = async (code) => {
    try { const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true }); return result.result.value; } catch { return null; }
  };
  await until(() => evaluate("!!document.querySelector('input[placeholder*=漫畫], input[placeholder*=漫画], input[type=search]')"), '首页搜索框').catch(async (error) => {
    console.error(await evaluate("JSON.stringify({url:location.href,title:document.title,ready:document.readyState,text:document.body && document.body.innerText.slice(0,200)})"));
    throw error;
  });
  console.log('PASS 指定分类首页加载，搜索框可用');
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*=漫畫], input[placeholder*=漫画], input[type=search]');
    input.value = '万界守门人'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const form = input.closest('form');
    if (form) form.requestSubmit(); else document.querySelector('button[type=submit]').click();
  })()`);
  let detail;
  await until(async () => {
    detail = await evaluate("location.pathname.includes('search') ? [...document.querySelectorAll('a[href]')].find(a => a.href.includes('/comic/') && a.textContent.match(/[万萬]界守[门門]人/))?.href : null");
    return typeof detail === 'string';
  }, '搜索结果').catch(async (error) => { console.error(await evaluate("document.body.innerText.slice(0,500)")); throw error; });
  console.log('PASS 漫画搜索返回结果');
  win.loadURL(detail).catch(() => {});
  await until(async () => Boolean(picked) || await evaluate("!!document.querySelector('a[href*=page_direct]')"), '漫画章节目录');
  if (!picked) {
    if (process.env.COMIC_CATALOG_SCREENSHOT) fs.writeFileSync(process.env.COMIC_CATALOG_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('a[href*=page_direct]').click()");
  }
  await until(async () => Boolean(picked), '选章进入阅读器', 10000);
  assert.ok(picked.startsWith('https://www.twmanga.com/comic/chapter/'));
  assert.ok(/\/\d+_\d+\.html$/.test(picked));
  await until(async () => catalog.window === null, '首页窗口关闭', 3000);
  assert.equal(new URL(HOME_URL).pathname, '/classify');
  console.log('PASS 从目录选章返回原生阅读器');
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
app.on('quit', () => fs.rmSync(profile, { recursive: true, force: true }));
