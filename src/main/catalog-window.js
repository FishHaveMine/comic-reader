'use strict';
const { BrowserWindow } = require('electron');
const { HOME_URL, isCatalogUrl, chapterFromCatalog } = require('../shared/catalog-navigation');
const { UA } = require('./session-source');

class CatalogWindow {
  constructor({ session, onChapter }) { Object.assign(this, { session, onChapter }); this.window = null; }
  open(parent) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.loadURL(HOME_URL).catch(() => {});
      this.window.focus();
      return;
    }
    const win = new BrowserWindow({ width: 1100, height: 860, minWidth: 420, minHeight: 400,
      parent, title: '首页与搜索 · 包子漫画', backgroundColor: '#111318',
      webPreferences: { session: this.session, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.window = win;
    win.webContents.setUserAgent(UA);
    const navigate = (event, url) => {
      const chapter = chapterFromCatalog(url);
      if (chapter) {
        event.preventDefault();
        this.onChapter(chapter);
        win.close();
      } else if (!isCatalogUrl(url)) event.preventDefault();
    };
    win.webContents.on('will-navigate', navigate);
    win.webContents.on('will-redirect', navigate);
    win.webContents.setWindowOpenHandler(({ url }) => {
      const chapter = chapterFromCatalog(url);
      if (chapter) { this.onChapter(chapter); win.close(); }
      else if (isCatalogUrl(url)) win.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const challenges = new Set();
    win.webContents.on('did-finish-load', async () => {
      if (win.isDestroyed()) return;
      try {
        const challenge = await win.webContents.executeJavaScript("(() => { try { const value = JSON.parse(document.querySelector('pre')?.textContent || document.body.innerText); return value.error === 'challenge_required' ? value.challenge_url : null; } catch { return null; } })()");
        if (!challenge || win.isDestroyed()) return;
        const url = new URL(challenge, win.webContents.getURL()).href;
        if (!isCatalogUrl(url) || challenges.has(url)) return;
        challenges.add(url); await win.loadURL(url);
      } catch { /* 页面跳转时不影响正常导航 */ }
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') { event.preventDefault(); win.close(); }
      if ((input.control || input.meta) && input.key.toLowerCase() === 'r') { event.preventDefault(); if (isCatalogUrl(win.webContents.getURL())) win.webContents.reload(); else win.loadURL(HOME_URL).catch(() => {}); }
      if (input.alt && input.key === 'ArrowLeft' && win.webContents.navigationHistory.canGoBack()) { event.preventDefault(); win.webContents.navigationHistory.goBack(); }
    });
    win.on('closed', () => { if (this.window === win) this.window = null; });
    win.loadURL(HOME_URL).catch((error) => {
      if (error.errno === -3 || error.code === 'ERR_ABORTED') return;
      if (!win.isDestroyed()) win.setTitle('首页加载失败 · 按 Ctrl/Cmd+R 重试');
    });
  }
}
module.exports = { CatalogWindow };
