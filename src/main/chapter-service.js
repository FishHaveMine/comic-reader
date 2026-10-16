'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 章节请求与预取共享解析任务，只有最新阅读流程能提交结果或清理缓存。 */
class ChapterService {
  constructor({ source, cache, directory = null, onCurrent = () => {}, onProgress = () => {}, onPhase = () => {}, onCacheChanged = () => {} }) {
    Object.assign(this, { source, cache, directory, onCurrent, onProgress, onPhase, onCacheChanged });
    this.chapters = new Map();
    this.loading = new Map();
    this.prefetching = new Map();
    this.currentUrl = '';
    this.retained = new Set();
    this.directories = new Map();
    this.directoryLoading = new Map();
    this.requestId = 0;
    this.revision = 0;
  }

  fileFor(url) {
    return this.directory && path.join(this.directory, `${createHash('sha1').update(url).digest('hex')}.json`);
  }

  async directoryFor(pageUrl, refresh = false) {
    const { comicId } = require('../shared/chapter-directory');
    const key = `${new URL(pageUrl).origin}/${comicId(pageUrl)}`;
    if (!refresh && this.directories.has(key)) return { entries: this.directories.get(key), cached: true };
    const file = this.fileFor(`directory:${key}`);
    if (!refresh && file) {
      try {
        const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(entries) && entries.length && entries.every((entry) => comicId(entry.pageUrl) === comicId(pageUrl))) {
          this.directories.set(key, entries); return { entries, cached: true };
        }
      } catch { /* 无可用缓存 */ }
    }
    if (!this.directoryLoading.has(key)) {
      const task = this.source.loadDirectory(pageUrl).then((entries) => {
        if (!entries.length) throw new Error('未找到章节目录');
        this.directories.set(key, entries);
        if (file) {
          try { fs.mkdirSync(this.directory, { recursive: true }); fs.writeFileSync(`${file}.part`, JSON.stringify(entries)); fs.renameSync(`${file}.part`, file); } catch { /* 存储失败仍可选章 */ }
        }
        return { entries, cached: false };
      }).finally(() => this.directoryLoading.delete(key));
      this.directoryLoading.set(key, task);
    }
    return this.directoryLoading.get(key);
  }

  hasCached(url) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.fileFor(url), 'utf8'));
      return saved.pageUrl === url && Boolean(saved.images?.length);
    } catch { return false; }
  }

  async append(url) {
    const owner = this.currentUrl;
    const revision = this.requestId;
    const expected = [...this.retained].some((key) => this.chapters.get(key)?.nextUrl === url);
    if (!expected) return { ok: false, stale: true };
    const chapter = await this.chapter(url);
    if (owner !== this.currentUrl || revision !== this.requestId) return { ok: false, stale: true };
    this.retained.add(url);
    this.cache.prefetchAll(chapter.images.map((image) => image.url), () => {}).catch(() => {});
    return { ok: true, chapter };
  }

  async chapter(url, onStatus) {
    if (this.chapters.has(url)) return this.chapters.get(url);
    const file = this.fileFor(url);
    if (file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.pageUrl === url && saved.images?.length) {
          this.chapters.set(url, saved);
          return saved;
        }
      } catch { /* 无有效缓存时请求站点 */ }
    }
    let task = this.loading.get(url);
    if (!task) {
      task = { listeners: new Set(), phase: '' };
      task.promise = this.source.loadChapter(url, {
        onStatus: (phase) => {
          task.phase = phase;
          for (const listener of task.listeners) listener(phase);
        },
      }).then((chapter) => {
        this.chapters.set(url, chapter);
        if (file) {
          try {
            fs.mkdirSync(this.directory, { recursive: true });
            fs.writeFileSync(`${file}.part`, JSON.stringify(chapter));
            fs.renameSync(`${file}.part`, file);
          } catch { /* 存储失败仍允许阅读 */ }
        }
        return chapter;
      }).finally(() => this.loading.delete(url));
      this.loading.set(url, task);
    }
    if (onStatus) {
      task.listeners.add(onStatus);
      if (task.phase) onStatus(task.phase);
    }
    try {
      return await task.promise;
    } finally {
      if (onStatus) task.listeners.delete(onStatus);
    }
  }

  cancelLoad(restoreUrl) {
    this.requestId += 1;
    this.revision += 1;
    if (restoreUrl && this.chapters.has(restoreUrl)) {
      this.currentUrl = restoreUrl;
      this.onCurrent(restoreUrl);
    }
  }

  async open(url) {
    const id = ++this.requestId;
    this.revision += 1;
    const instant = this.chapters.has(url) || this.hasCached(url);
    try {
      const chapter = await this.chapter(url, (phase) => {
        if (id === this.requestId) this.onPhase(phase);
      });
      if (id !== this.requestId) return { ok: false, stale: true };
      this.retained = new Set([url]);
      this.currentUrl = url;
      this.onCurrent(url);
      return { ok: true, chapter, instant };
    } catch (error) {
      if (id !== this.requestId) return { ok: false, stale: true };
      return { ok: false, error: error.message };
    }
  }

  async prefetch(url, label, report) {
    let task = this.prefetching.get(url);
    if (!task) {
      const state = { url, status: 'loading', done: 0, total: 0, failed: 0, nextUrl: '', error: '' };
      task = { state, listeners: new Set() };
      const publish = () => {
        for (const listener of task.listeners) listener({ ...state });
      };
      task.promise = (async () => {
        try {
          const chapter = await this.chapter(url);
          state.total = chapter.images.length;
          state.nextUrl = chapter.nextUrl;
          publish();
          const result = await this.cache.prefetchAll(chapter.images.map((img) => img.url), (done, total, failed) => {
            Object.assign(state, { done, total, failed });
            if (done === total || done % Math.max(1, Math.ceil(total / 10)) === 0) publish();
          });
          Object.assign(state, result, { status: result.failed ? 'partial' : 'done' });
        } catch (error) {
          Object.assign(state, { status: 'failed', error: error.message });
        }
        publish();
        return { ...state };
      })().finally(() => this.prefetching.delete(url));
      this.prefetching.set(url, task);
    }
    const listener = (state) => report({ ...state, label });
    task.listeners.add(listener);
    listener(task.state);
    try {
      return await task.promise;
    } finally {
      task.listeners.delete(listener);
    }
  }

  async prefetchUpcoming(startUrl, depth = 2) {
    const ownerUrl = this.currentUrl;
    const revision = ++this.revision;
    const active = () => revision === this.revision && ownerUrl === this.currentUrl;
    const upcoming = [];
    const visited = new Set([ownerUrl]);
    let url = startUrl;
    for (let level = 0; level < depth && url && !visited.has(url); level += 1) {
      if (!active()) return;
      visited.add(url);
      const result = await this.prefetch(url, ['下一章', '下二章'][level] || `后第 ${level + 1} 章`, (state) => {
        if (active()) this.onProgress({ ...state, ownerUrl });
      });
      if (!active() || result.status !== 'done') return;
      upcoming.push(url);
      url = result.nextUrl;
    }
    if (!active()) return;
    const keep = new Set([ownerUrl, ...this.retained, ...upcoming]);
    // 当前章节信息不完整时绝不进行清理。
    if (!ownerUrl || [...keep].some((key) => !this.chapters.get(key)?.images.length)) return;
    const retained = [...keep].flatMap((key) => this.chapters.get(key).images.map((img) => img.url));
    this.cache.prune(retained);
    for (const key of this.chapters.keys()) {
      if (!keep.has(key) && !this.loading.has(key) && !this.prefetching.has(key)) this.chapters.delete(key);
    }
    this.onCacheChanged();
  }
}

module.exports = { ChapterService };
