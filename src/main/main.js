'use strict';

const { app, BrowserWindow, ipcMain, protocol, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { normalizeUrl } = require('../shared/url');
const { SessionSource, UA } = require('./session-source');
const { ImageCache } = require('./image-cache');
const { ChapterService } = require('./chapter-service');
const { ProgressStore } = require('./progress-store');
const { AdbSync } = require('./adb-sync');
const { CatalogWindow } = require('./catalog-window');

const DEFAULT_URL = 'https://www.twmanga.com/comic/chapter/mojieshoumenren-yuewenmanhua/0_6.html';
const MIN_WIDTH = 420;
const MIN_HEIGHT = 320;
const FALLBACK_BOUNDS = { width: 1000, height: 820 };

// 自定义协议必须在 ready 之前声明为特权协议，<img> 才允许加载它
protocol.registerSchemesAsPrivileged([{
  scheme: 'comicimg',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
}]);

app.userAgentFallback = UA;

let mainWindow = null;
let source = null;
let cache = null;
let chapters = null;
let progressStore = null;
let adbSync = null;
let catalog = null;
let config = { ...FALLBACK_BOUNDS, lastUrl: DEFAULT_URL, autoNext: true };
let persistTimer = null;

/* ------------------------------------------------------------------ 基础工具 */

function configFile() {
  return path.join(app.getPath('userData'), 'reader-config.json');
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') config = { ...config, ...parsed };
  } catch {
    // 首次启动没有配置文件
  }
  if (typeof config.lastUrl !== 'string' || !config.lastUrl) config.lastUrl = DEFAULT_URL;
}

function writeConfig() {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // 写入失败不影响使用
  }
}

function persistConfig() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; writeConfig(); }, 250);
}

function flushConfig() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  writeConfig();
}

function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
  const maximized = mainWindow.isMaximized();
  config.maximized = maximized;
  if (!maximized) {
    const { x, y, width, height } = mainWindow.getNormalBounds();
    Object.assign(config, { x, y, width, height });
  }
  persistConfig();
}

function clampBounds(bounds) {
  const width = Math.max(MIN_WIDTH, Math.round(bounds.width || FALLBACK_BOUNDS.width));
  const height = Math.max(MIN_HEIGHT, Math.round(bounds.height || FALLBACK_BOUNDS.height));
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : null;
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : null;
  if (x === null || y === null) return { width, height };

  const visible = screen.getAllDisplays().some(({ workArea }) => (
    x + width > workArea.x && x < workArea.x + workArea.width
    && y + height > workArea.y && y < workArea.y + workArea.height
  ));
  return visible ? { x, y, width, height } : { width, height };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * macOS 下运行中的进程实际是 Electron 自身，Dock 图标默认是 Electron 的，
 * 这里换成 scripts/make-icon.js 生成的应用图标，与桌面快捷方式保持一致。
 */
function applyDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  try {
    if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath);
  } catch {
    // 图标缺失不影响启动
  }
}

function cacheStats() {
  return { files: cache.count(), bytes: cache.sizeOnDisk(), ...cache.stats };
}

/* ---------------------------------------------------------- 自动缓存后续章节 */

/* ------------------------------------------------------------------ 主窗口 */

function createWindow() {
  const isMac = process.platform === 'darwin';
  const bounds = clampBounds(config);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#111318',
    resizable: true,
    title: '漫画阅读器',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (config.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  mainWindow.on('maximize', () => send('window:maximized-changed', true));
  mainWindow.on('unmaximize', () => send('window:maximized-changed', false));
  mainWindow.on('close', () => { rememberBounds(); flushConfig(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* -------------------------------------------------------------- 协议与 IPC */

function registerImageProtocol() {
  protocol.handle('comicimg', async (request) => {
    let target = '';
    try {
      target = new URL(request.url).searchParams.get('u') || '';
    } catch {
      target = '';
    }
    if (!target) return new Response('缺少图片地址', { status: 400 });

    try {
      const { data, mime } = await cache.readFile(target);
      return new Response(data, {
        headers: {
          'Content-Type': mime,
          // 图片按 URL 寻址且内容不变，可以长期缓存到渲染进程
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (error) {
      return new Response(`图片获取失败：${error.message}`, { status: 502 });
    }
  });
}

function registerIpc() {
  ipcMain.handle('app:context', () => ({
    platform: process.platform,
    defaultUrl: DEFAULT_URL,
    lastUrl: chapters.hasCached(progressStore.latest()?.pageUrl) ? progressStore.latest().pageUrl
      : chapters.hasCached(config.lastUrl) ? config.lastUrl : progressStore.latest()?.pageUrl || config.lastUrl,
    readingClock: Math.max(progressStore.latest()?.updatedAt || 0, progressStore.favorites[0]?.updatedAt || 0),
    syncStatus: adbSync?.status,
    autoNext: config.autoNext !== false,
    version: app.getVersion(),
  }));

  ipcMain.handle('catalog:open', () => { catalog.open(mainWindow); return true; });

  ipcMain.handle('app:set-auto-next', (_event, flag) => {
    config.autoNext = Boolean(flag);
    persistConfig();
    return config.autoNext;
  });

  ipcMain.handle('app:remember-url', (_event, url) => {
    try {
      config.lastUrl = normalizeUrl(url);
      persistConfig();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('chapter:load', async (_event, rawUrl) => {
    let url;
    try {
      url = normalizeUrl(rawUrl);
    } catch (error) {
      chapters.cancelLoad();
      return { ok: false, error: error.message };
    }

    const result = await chapters.open(url);
    if (result.ok) result.progress = progressStore.records.find((record) => record.pageUrl === url) || null;
    return result;
  });

  ipcMain.handle('chapter:append', async (_event, rawUrl) => {
    try { return await chapters.append(normalizeUrl(rawUrl)); }
    catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle('chapter:directory', async (_event, rawUrl, refresh) => {
    try { return { ok: true, ...await chapters.directoryFor(normalizeUrl(rawUrl), Boolean(refresh)) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  ipcMain.handle('chapter:cancel', (_event, rawUrl) => {
    let url = '';
    try { url = normalizeUrl(rawUrl); } catch { /* 首次加载可能没有旧章节 */ }
    chapters.cancelLoad(url);
  });

  ipcMain.handle('chapter:prefetch', (_event, rawUrl) => {
    try {
      const url = rawUrl ? normalizeUrl(rawUrl) : '';
      const expected = chapters.chapters.get(chapters.currentUrl)?.nextUrl || '';
      if (url !== expected) return { ok: false, error: '章节已切换' };
      chapters.prefetchUpcoming(url).catch((error) => console.error('[prefetch]', error));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('progress:save', (_event, record) => {
    if (!chapters.retained.has(record?.pageUrl)) return { ok: false };
    try {
      const winner = progressStore.save(record, { observedAt: record.observedAt });
      config.lastUrl = winner.pageUrl; persistConfig();
      return { ok: true, record: winner };
    }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('progress:latest', () => progressStore.latest());
  ipcMain.handle('favorites:list', () => progressStore.listFavorites());
  ipcMain.handle('favorites:set', (_event, favorite, removed) => {
    try { return { ok: true, favorites: progressStore.setFavorite(favorite, removed) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('sync:now', () => adbSync.requestSync());
  ipcMain.handle('sync:status', () => adbSync?.status);

  ipcMain.handle('cache:stats', () => cacheStats());

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
}

/* ------------------------------------------------------------------- 生命周期 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    loadConfig();
    progressStore = new ProgressStore(path.join(app.getPath('userData'), 'reading-progress.json'),
      (record) => send('progress:changed', record),
      (favorites) => send('favorites:changed', favorites));
    source = new SessionSource();
    // 必须早于任何网络请求
    console.log(`[net] 代理模式：${await source.configureProxy()}`);
    cache = new ImageCache(path.join(app.getPath('userData'), 'image-cache'), {
      download: (url) => source.fetchImage(url),
      concurrency: 6,
      retries: 3,
      debug: Boolean(process.env.COMIC_DEBUG),
    });

    chapters = new ChapterService({
      source, cache, directory: path.join(app.getPath('userData'), 'chapter-cache'),
      onCurrent: (url) => { config.lastUrl = url; persistConfig(); },
      onProgress: (progress) => send('prefetch:progress', progress),
      onPhase: (phase) => send('loading:phase', { phase }),
      onCacheChanged: () => send('cache:changed', cacheStats()),
    });

    catalog = new CatalogWindow({ session: source.session, onChapter: (url) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show(); mainWindow.focus(); send('catalog:chapter', url);
    } });

    registerImageProtocol();
    registerIpc();
    applyDockIcon();
    adbSync = new AdbSync({ store: progressStore, dir: app.getPath('userData'),
      onStatus: (status) => send('sync:status', status) });
    createWindow();
    adbSync.start().catch((error) => adbSync.setStatus('error', `ADB 同步启动失败：${error.message}`));
    app.on('before-quit', () => { adbSync.stop(); flushConfig(); });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
