'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只取文件名，日志里不必出现整条 URL */
function shortName(url) {
  try {
    return new URL(url).pathname.split('/').pop();
  } catch {
    return url;
  }
}

/**
 * 按文件头判断 MIME，避免为扩展名再维护一份索引。
 * 注意：站点 CDN 会按 Accept 头做内容协商，同一张图可能返回 JPEG 也可能返回 WebP
 * （实测同一话内两种格式混着出现），所以不能靠 URL 后缀来判断格式。
 */
const ISOBMFF_BRANDS = new Set(['avif', 'avis', 'mif1', 'msf1', 'heic', 'heix']);

function sniffMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  // AVIF / HEIC：ISOBMFF 的 ftyp 盒子
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (ISOBMFF_BRANDS.has(brand)) return brand.startsWith('hei') ? 'image/heic' : 'image/avif';
  }
  return 'application/octet-stream';
}

function extensionFor(url) {
  try {
    const name = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.(jpe?g|png|webp|gif|avif)$/.test(name) ? name : '.img';
  } catch {
    return '.img';
  }
}

/**
 * 图片磁盘缓存 + 并发受限的下载队列。
 *
 * 这里是「加载速度」的核心：
 *  - 命中磁盘直接返回，重复阅读同一话不再产生任何网络请求
 *  - 同一地址的并发请求合并成一次下载
 *  - 全局并发上限，避免同时打开几十条连接把 CDN 拖慢
 *  - 失败重试 + 退避：CDN 偶发 ERR_BLOCKED_BY_CLIENT（实测出现过）
 */
class ImageCache {
  constructor(dir, { download, concurrency = 6, retries = 3, debug = false, log = console.log } = {}) {
    this.dir = dir;
    this.download = download;
    this.concurrency = concurrency;
    this.retries = retries;
    this.debug = debug;
    this.log = log;

    this.inflight = new Map();
    this.active = 0;
    this.waiting = [];

    this.stats = { hits: 0, downloaded: 0, failed: 0, bytes: 0 };
  }

  keyFor(url) {
    return crypto.createHash('sha1').update(url).digest('hex');
  }

  pathFor(url) {
    return path.join(this.dir, this.keyFor(url) + extensionFor(url));
  }

  has(url) {
    return fs.existsSync(this.pathFor(url));
  }

  /**
   * 确保图片已落盘，返回本地绝对路径。
   * urgent 用于「用户正在看的图」：后台预取会排满整条队列，
   * 不插队的话滚动时新进入视口的图片要排在几十张预取图后面。
   */
  ensure(url, { urgent = false } = {}) {
    const cached = this.pathFor(url);
    if (fs.existsSync(cached)) {
      this.stats.hits += 1;
      return Promise.resolve(cached);
    }
    if (this.inflight.has(url)) {
      // 已排队的预取图变成首屏图时，也必须提升优先级。
      if (urgent) {
        const index = this.waiting.findIndex((task) => task.url === url);
        if (index > 0) this.waiting.unshift(this.waiting.splice(index, 1)[0]);
      }
      return this.inflight.get(url);
    }

    const task = this._run(url, urgent).finally(() => this.inflight.delete(url));
    this.inflight.set(url, task);
    return task;
  }

  async _run(url, urgent) {
    await this._acquire(url, urgent);
    try {
      const { buffer } = await this._download(url);
      const target = this.pathFor(url);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 先写 .part 再改名：避免进程中断留下半截文件被当成有效缓存
      const temp = `${target}.part`;
      fs.writeFileSync(temp, buffer);
      fs.renameSync(temp, target);
      this.stats.bytes += buffer.length;
      return target;
    } finally {
      this._release();
    }
  }

  async _download(url) {
    let lastError;
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      try {
        const result = await this.download(url);
        this.stats.downloaded += 1;
        if (this.debug) {
          const ms = Date.now() - started;
          const kb = Math.round(result.buffer.length / 1024);
          this.log(`[cache] ${ms}ms ${kb}KB ${shortName(url)}`);
        }
        return result;
      } catch (error) {
        lastError = error;
        this.log(`[cache] 第 ${attempt}/${this.retries} 次失败（${Date.now() - started}ms）${shortName(url)} :: ${error.message}`);
        if (attempt < this.retries) await delay(250 * attempt);
      }
    }
    this.stats.failed += 1;
    throw lastError;
  }

  _acquire(url, urgent = false) {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const task = { url, resolve };
      if (urgent) this.waiting.unshift(task);
      else this.waiting.push(task);
    });
  }

  _release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); // 名额直接转交，active 保持不变
    else this.active -= 1;
  }

  /**
   * 批量下载：供预取使用。
   * 失败也要计入进度，但单独统计，避免界面把「失败」显示成「已缓存」。
   */
  async prefetchAll(urls, onProgress) {
    let done = 0;
    let failed = 0;

    await Promise.all(urls.map((url) => this.ensure(url)
      .then(() => { done += 1; }, () => { done += 1; failed += 1; })
      .finally(() => { if (onProgress) onProgress(done, urls.length, failed); })));

    return { done, failed };
  }

  async readFile(url) {
    // 走自定义协议的都是渲染进程正在显示的图，属于紧急请求
    const file = await this.ensure(url, { urgent: true });
    const data = await fs.promises.readFile(file);
    return { data, mime: sniffMime(data) };
  }

  /**
   * 只保留 retainedUrls 对应的图片，其余从磁盘删除。
   *
   * 这是「缓存维持在当前章 + 后两章」的核心：不做清理的话会无限增长
   * （实测几轮阅读后涨到 419 张 / 110MB）。
   *
   * 保留集为空时**直接返回、一张都不删** —— 上游一旦拿不到章节信息，
   * 这个方法不能把整个缓存清空。
   */
  prune(retainedUrls) {
    if (!Array.isArray(retainedUrls) || retainedUrls.length === 0) {
      return { deleted: 0, freed: 0, skipped: true };
    }

    const keep = new Set(retainedUrls.map((url) => this.keyFor(url)));
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return { deleted: 0, freed: 0 };
    }

    let deleted = 0;
    let freed = 0;
    for (const name of entries) {
      if (name.endsWith('.part')) continue; // 正在写入的临时文件
      if (keep.has(name.split('.')[0])) continue;

      const file = path.join(this.dir, name);
      try {
        freed += fs.statSync(file).size;
        fs.unlinkSync(file);
        deleted += 1;
      } catch {
        // 已被别处删除，忽略
      }
    }

    return { deleted, freed, skipped: false };
  }

  count() {
    try {
      return fs.readdirSync(this.dir).filter((name) => !name.endsWith('.part')).length;
    } catch {
      return 0;
    }
  }

  sizeOnDisk() {
    let total = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.endsWith('.part')) continue;
        total += fs.statSync(path.join(this.dir, name)).size;
      }
    } catch {
      return 0;
    }
    return total;
  }
}

module.exports = { ImageCache, sniffMime };
