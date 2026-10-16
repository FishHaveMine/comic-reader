'use strict';

const { BrowserWindow, session } = require('electron');

const { parseChapter } = require('../shared/parse-chapter');
const { directoryUrl, parseDirectory } = require('../shared/chapter-directory');
const { isCatalogUrl } = require('../shared/catalog-navigation');

const PARTITION = 'persist:comic';
const SITE = 'https://www.twmanga.com/';
const REFERER = SITE;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 站点在 __gatekeeper_challenge 后面：普通 HTTP 请求一律 403，
 * 必须先由真实 Chromium 执行一次挑战、拿到放行 cookie。
 *
 * 关键实测结论：
 *  1. 放行状态绑定在出口 IP 上，切换代理会立刻失效 —— 所以绝不能动代理设置。
 *  2. cookie 会持久化到 partition，跨启动复用，正常情况下不必再开浏览器。
 */
const AD_HOSTS = [
  'outbrain.com', '91app.io', '91app.com', 'impactify.media', 'servenobid.com',
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'scorecardresearch.com', 'adnxs.com',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'smartadserver.com', 'bing.com',
  'facebook.net', 'amazon-adsystem.com', 'casalemedia.com', 'sharethrough.com',
];

/** 单次请求超时。实测 CDN 偶发挂起：不设上限会一直占着并发名额，把整个下载队列拖死 */
const REQUEST_TIMEOUT = Number(process.env.COMIC_TIMEOUT || 15000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SessionSource {
  constructor({ onStatus } = {}) {
    this.session = session.fromPartition(PARTITION);
    this.warming = null;
    this.warmed = false;
    this.proxyMode = 'unset';
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.blockAds();
  }

  /** 阶段上报：渲染进程据此决定要不要提示「正在过验证」，而不是每次都吓人一跳 */
  notify(phase) {
    try {
      this.onStatus(phase);
    } catch {
      // 状态回调不应影响抓取主流程
    }
  }

  /**
   * 代理策略：默认直连，必须在发出任何请求之前调用。
   *
   * 本机系统代理为 127.0.0.1:7890，实测（每组 6 张 CDN 图片）：
   *   走系统代理 —— 成功 2/6，其余全部挂起直到超时，总耗时 18s+
   *   直连      —— 成功 6/6，总耗时 2.2s（每张 1.4~2.2s）
   * 代理会挂死 CDN 的大部分请求，是这套阅读器能不能用起来的关键，
   * 所以默认绕过。换到必须走代理的网络时设 COMIC_USE_SYSTEM_PROXY=1 恢复。
   */
  async configureProxy() {
    const mode = process.env.COMIC_USE_SYSTEM_PROXY ? 'system' : 'direct';
    await this.session.setProxy({ mode });
    this.proxyMode = mode;
    return mode;
  }

  /** 广告与统计域名直接掐掉：过验证的隐藏窗口本来会被这些请求拖成几十条失败连接 */
  blockAds() {
    const filter = { urls: ['*://*/*'] };
    this.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      try {
        const host = new URL(details.url).hostname;
        const blocked = AD_HOSTS.some((ad) => host === ad || host.endsWith(`.${ad}`));
        callback({ cancel: blocked });
      } catch {
        callback({ cancel: false });
      }
    });
  }

  /**
   * 带超时的请求。signal 负责真正取消连接，
   * 外层 race 是保险：即便 signal 没被遵守，也要把等待者放出来。
   */
  async request(url, accept = '*/*', timeout = REQUEST_TIMEOUT) {
    let timer = null;
    const guard = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`请求超时（${timeout}ms）`)), timeout);
    });

    try {
      return await Promise.race([
        this.session.fetch(url, {
          headers: { Referer: REFERER, Accept: accept },
          signal: AbortSignal.timeout(timeout),
        }),
        guard,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 开一个隐藏窗口把验证挑战跑过去。
   * 挑战是异步的，所以轮询「直连是否已经 200」而不是只等页面 load 事件
   * —— 实测该页挂着大量广告 iframe，load 事件可能长时间不触发。
   */
  warmUp(url) {
    if (this.warming) return this.warming;

    this.warming = (async () => {
      const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 720,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
      });

      try {
        win.loadURL(url).catch(() => { /* 挑战期间报错属正常，用轮询判定结果 */ });

        for (let attempt = 0; attempt < 25; attempt += 1) {
          await delay(1000);
          try {
            const res = await this.request(url, 'text/html');
            if (res.status === 200) {
              this.warmed = true;
              return true;
            }
          } catch {
            // 挑战未完成时连接可能被重置，继续等
          }
        }
        return false;
      } finally {
        win.destroy();
        this.warming = null;
      }
    })();

    return this.warming;
  }

  async loadChapter(url, { onStatus = (phase) => this.notify(phase) } = {}) {
    onStatus('fetching');

    let res;
    try {
      res = await this.request(url, 'text/html,application/xhtml+xml');
    } catch (error) {
      throw new Error(`无法访问章节页：${error.message}`);
    }

    // 403 = 放行已失效（例如换了出口 IP），补一次验证。
    // 只有走到这里才需要告诉用户「要过验证」—— 平时翻章是秒开的，不该弹这个。
    if (res.status === 403) {
      onStatus('warming');
      await this.warmUp(url);
      res = await this.request(url, 'text/html,application/xhtml+xml');
    }

    if (!res.ok) throw new Error(`抓取章节失败：HTTP ${res.status}`);

    const chapter = parseChapter(await res.text(), url);
    if (chapter.images.length === 0) throw new Error('这一话没有解析到图片，站点版式可能变了');
    return chapter;
  }

  async loadDirectory(pageUrl) {
    const url = directoryUrl(pageUrl);
    let win;
    try {
      let response = await this.request(url, 'text/html');
      if (response.ok) {
        const entries = parseDirectory(await response.text(), pageUrl, response.url || url);
        if (entries.length) return entries;
      }
      win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      win.loadURL(url).catch(() => {});
      const challenges = new Set();
      for (let tick = 0; tick < 35; tick++) {
        await delay(1000);
        const current = win.webContents.getURL();
        if (!isCatalogUrl(current)) continue;
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
        const entries = parseDirectory(html, pageUrl, current);
        if (entries.length) return entries;
        const challenge = await win.webContents.executeJavaScript("(() => { try { return JSON.parse(document.body.innerText).challenge_url || null; } catch { return null; } })()").catch(() => null);
        if (challenge) {
          const target = new URL(challenge, current).href;
          if (isCatalogUrl(target) && !challenges.has(target)) { challenges.add(target); win.loadURL(target).catch(() => {}); }
        }
      }
      throw new Error('章节目录加载失败，请稍后重试');
    } finally { if (win && !win.isDestroyed()) win.destroy(); }
  }

  async fetchImage(url) {
    const res = await this.request(url, 'image/avif,image/webp,image/*,*/*;q=0.8');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 64) throw new Error('返回内容过短，疑似被拦截');
    return { buffer, contentType: res.headers.get('content-type') || '' };
  }
}

module.exports = { SessionSource, PARTITION, UA };
