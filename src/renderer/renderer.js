'use strict';

const api = window.reader;

const el = {
  btnChapters: document.getElementById('btn-chapters'),
  chaptersDialog: document.getElementById('chapters-dialog'),
  chaptersSearch: document.getElementById('chapters-search'),
  chaptersList: document.getElementById('chapters-list'),
  chaptersMessage: document.getElementById('chapters-message'),
  reader: document.getElementById('reader'),
  bar: document.getElementById('bar'),
  comicName: document.getElementById('comic-name'),
  chapterName: document.getElementById('chapter-name'),
  jumpForm: document.getElementById('jump-form'),
  urlInput: document.getElementById('url-input'),
  badge: document.getElementById('badge'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnTop: document.getElementById('btn-top'),
  btnAutoNext: document.getElementById('btn-autonext'),
  btnMin: document.getElementById('btn-min'),
  btnMax: document.getElementById('btn-max'),
  btnClose: document.getElementById('btn-close'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayDetail: document.getElementById('overlay-detail'),
  overlayRetry: document.getElementById('overlay-retry'),
  overlayBack: document.getElementById('overlay-back'),
  statusPages: document.getElementById('status-pages'),
  statusCache: document.getElementById('status-cache'),
  statusSync: document.getElementById('status-sync'),
  btnHome: document.getElementById('btn-home'),
  btnFavorite: document.getElementById('btn-favorite'),
  btnFavorites: document.getElementById('btn-favorites'),
  favoritesDialog: document.getElementById('favorites-dialog'),
  favoritesClose: document.getElementById('favorites-close'),
  favoritesSearch: document.getElementById('favorites-search'),
  favoritesMessage: document.getElementById('favorites-message'),
  favoritesList: document.getElementById('favorites-list'),
};

/** 首屏这几页直接加载，不等观察器 */
const EAGER_COUNT = 2;
/** 提前约一屏开始加载：滚到那里时图片通常已经就绪 */
const LOOKAHEAD = '1600px 0px';
/** 加载超过这个时间才弹提示；命中预取时压根不闪 */
const LOADING_HINT_DELAY = 400;

const state = {
  chapter: null,
  chapters: [],
  appending: false,
  appendError: '',
  loaded: 0,
  total: 0,
  observer: null,
  lastRequested: '',
  autoNext: true,
  busy: false,
  requestId: 0,
  renderId: 0,
  incomingProgress: null,
  restoringProgress: false,
  favorites: [],
  changingFavorite: false,
  failed: 0,
  readingClock: 0,
  pendingProgress: null,
  lastScrollY: 0,
};

/** 后续章节的预取进度，key 为章节地址 */
const prefetchStates = new Map();

/** 图片统一走自定义协议，由主进程负责「磁盘缓存优先、缺失才下载」 */
const cacheSrc = (url) => `comicimg://img/?u=${encodeURIComponent(url)}`;

/* ------------------------------------------------------------------ 覆盖层 */

function showOverlay(title, detail, withRetry = false) {
  el.overlayTitle.textContent = title;
  el.overlayDetail.textContent = detail || '';
  el.overlayRetry.hidden = !withRetry;
  el.overlayBack.hidden = !state.chapter;
  el.overlay.hidden = false;
}

function hideOverlay() {
  el.overlay.hidden = true;
}

/**
 * 加载提示延迟出现：命中预取的章节是瞬时的，不该闪一个全屏覆盖层。
 * 真正慢的只有两种情况 —— 首次访问要过验证网关，或网络确实慢。
 */
let loadingHintTimer = null;

function scheduleLoadingHint() {
  cancelLoadingHint();
  loadingHintTimer = setTimeout(() => {
    loadingHintTimer = null;
    showOverlay('正在加载章节…', '');
  }, LOADING_HINT_DELAY);
}

function cancelLoadingHint() {
  if (loadingHintTimer) {
    clearTimeout(loadingHintTimer);
    loadingHintTimer = null;
  }
}

/* -------------------------------------------------------------------- 渲染 */

function createObserver() {
  return new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target.querySelector('img.page__img');
      state.observer.unobserve(entry.target);
      if (img && !img.getAttribute('src')) img.src = img.dataset.src;
    }
  }, { rootMargin: LOOKAHEAD });
}

function showPageError(wrap, img) {
  if (wrap.querySelector('.page__error')) return;

  const box = document.createElement('div');
  box.className = 'page__error';

  const text = document.createElement('span');
  text.textContent = '这一页没加载成功';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试';
  retry.addEventListener('click', () => {
    box.remove();
    wrap.classList.remove('is-loaded');
    // 带上时间戳，绕开上一次失败留下的缓存
    img.src = `${img.dataset.src}&r=${Date.now()}`;
  });

  box.append(text, retry);
  wrap.appendChild(box);
}

function createPage(image, index, chapter = state.chapter) {
  const wrap = document.createElement('figure');
  wrap.className = 'page';
  wrap.dataset.chapter = chapter.pageUrl;
  wrap.dataset.index = String(index);
  // 用真实宽高比例预留位置，图片到达时不会把下面内容顶开
  if (image.width > 0 && image.height > 0) {
    wrap.style.aspectRatio = `${image.width} / ${image.height}`;
  } else {
    wrap.style.aspectRatio = '2 / 3';
  }

  const img = document.createElement('img');
  img.className = 'page__img';
  img.alt = image.alt || `第 ${index + 1} 页`;
  img.decoding = 'async';
  img.dataset.src = cacheSrc(image.url);
  if (index === 0) img.fetchPriority = 'high';

  const renderId = state.renderId;
  let loaded = false;
  let failed = false;
  img.addEventListener('load', () => {
    if (renderId !== state.renderId || loaded) return;
    loaded = true;
    if (!(image.width > 0 && image.height > 0) && img.naturalWidth && img.naturalHeight) {
      wrap.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
    }
    if (failed) { state.failed -= 1; failed = false; }
    wrap.querySelector('.page__error')?.remove();
    wrap.classList.add('is-loaded');
    state.loaded += 1;
    updatePageStatus();
    if (state.loaded === state.total) {
      refreshCacheStats();
      if (shouldAutoAdvanceNow()) appendNextChapter();
    }
  });

  img.addEventListener('error', () => {
    if (renderId !== state.renderId || loaded) return;
    if (!failed) { state.failed += 1; failed = true; }
    updatePageStatus();
    wrap.classList.add('is-loaded');
    showPageError(wrap, img);
  });

  wrap.appendChild(img);

  if (index < EAGER_COUNT) img.src = img.dataset.src;
  else state.observer.observe(wrap);

  return wrap;
}

function render(chapter) {
  state.renderId += 1;
  state.chapter = chapter;
  state.chapters = [chapter];
  state.appending = false;
  state.appendError = '';
  state.loaded = 0;
  state.failed = 0;
  state.total = chapter.images.length;

  el.comicName.textContent = chapter.comicName || '漫画';
  el.chapterName.textContent = chapter.chapterName || '';
  el.urlInput.value = chapter.pageUrl;
  document.title = chapter.title || '漫画阅读器';
  updateNavigation();

  if (state.observer) state.observer.disconnect();
  state.observer = createObserver();
  el.reader.replaceChildren(...chapter.images.map((image, index) => createPage(image, index, chapter)));

  window.scrollTo({ top: 0 });
  updatePageStatus();
}

function updateNavigation() {
  el.btnChapters.disabled = state.busy || !state.chapter;
  el.btnPrev.disabled = state.busy || !state.chapter?.prevUrl;
  el.btnNext.disabled = state.busy || !state.chapter?.nextUrl;
  el.reader.setAttribute('aria-busy', String(state.busy));
  renderFavoriteButton();
}

function updatePageStatus() {
  if (!state.chapter) {
    el.statusPages.textContent = '—';
    return;
  }
  el.statusPages.textContent = `连续 ${state.chapters.length} 话 · 共 ${state.total} 页 · 已显示 ${state.loaded}/${state.total}${state.failed ? ` · ${state.failed} 页失败，可重试` : ''}`;
}

/* ------------------------------------------------------------------ 状态区 */

const LABEL_RANK = { 下一章: 1, 下二章: 2, 下三章: 3 };

function resetPrefetch() {
  prefetchStates.clear();
  renderPrefetch();
}

/** 后续多章的预取进度汇总成一个徽标，避免工具栏被塞满 */
function renderPrefetch() {
  const tasks = [...prefetchStates.values()]
    .sort((a, b) => (LABEL_RANK[a.label] || 9) - (LABEL_RANK[b.label] || 9));

  if (!tasks.length) {
    el.badge.hidden = true;
    return;
  }

  const total = tasks.reduce((sum, t) => sum + (t.total || 0), 0);
  const done = tasks.reduce((sum, t) => sum + (t.done || 0), 0);
  const failed = tasks.reduce((sum, t) => sum + (t.failed || 0), 0);
  const loading = tasks.some((t) => t.status === 'loading');
  const allFailed = tasks.every((t) => t.status === 'failed');
  const prefix = tasks.length >= 2 ? `后 ${tasks.length} 章` : tasks[0].label;

  el.badge.hidden = false;
  el.badge.classList.toggle('is-busy', loading || failed > 0);
  el.badge.classList.toggle('is-failed', allFailed);

  if (allFailed) {
    el.badge.textContent = '后续章节预取失败';
  } else if (loading) {
    el.badge.textContent = total ? `缓存${prefix} ${done}/${total}` : `缓存${prefix}…`;
  } else if (failed > 0) {
    el.badge.textContent = `${prefix}已缓存 ${total - failed}/${total} 页`;
  } else {
    const unavailable = tasks.some((t) => t.status === 'failed');
    el.badge.textContent = unavailable
      ? `${prefix}部分预取失败`
      : `${prefix}已缓存 · ${total} 页`;
  }
}

function renderCacheStats(stats) {
  const mb = (stats.bytes / 1024 / 1024).toFixed(1);
  el.statusCache.textContent = `缓存 ${stats.files} 张 · ${mb} MB · 保留本次阅读及后续章节`;
}

async function refreshCacheStats() {
  try { renderCacheStats(await api.cacheStats()); } catch { /* 状态查询失败不打断阅读 */ }
}

/* -------------------------------------------------------------------- 打开 */

async function openChapter(rawUrl, resume = null, userInitiated = true) {
  if (userInitiated && state.chapter && !state.busy && !state.restoringProgress) await saveReadingProgress();
  el.chaptersDialog.close();
  directoryRequest += 1;
  const openedAt = userInitiated ? readingTimestamp() : null;
  const requestId = ++state.requestId;
  state.appending = false;
  state.lastRequested = rawUrl;
  state.busy = true;
  updateNavigation();
  hideOverlay();
  scheduleLoadingHint();

  try {
    const result = await api.loadChapter(rawUrl);
    if (requestId !== state.requestId) return;
    cancelLoadingHint();
    if (!result.ok) {
      if (!result.stale) showOverlay('打开失败', result.error, true);
      return;
    }
    render(result.chapter);
    state.restoringProgress = true;
    const progress = resume || result.progress;
    state.readingClock = Math.max(state.readingClock, progress?.updatedAt || 0);
    requestAnimationFrame(() => {
      if (requestId !== state.requestId) return;
      if (progress?.pageUrl === result.chapter.pageUrl) {
        const pages = el.reader.querySelectorAll('.page');
        const page = pages[Math.min(progress.pageIndex, pages.length - 1)];
        if (page) window.scrollTo(0, Math.max(0, page.offsetTop + page.offsetHeight * progress.pageOffset - 54));
      }
      requestAnimationFrame(() => {
        if (requestId !== state.requestId) return;
        state.restoringProgress = false;
        state.lastScrollY = window.scrollY;
        if (userInitiated) { captureReadingProgress(openedAt); saveReadingProgress(); }
      });
    });
    hideOverlay();
    refreshCacheStats();
    resetPrefetch();

  } catch (error) {
    if (requestId !== state.requestId) return;
    cancelLoadingHint();
    showOverlay('打开失败', String(error?.message || error), true);
  } finally {
    if (requestId === state.requestId) {
      state.busy = false;
      updateNavigation();
    }
  }
}

let progressTimer = null;

function readingTimestamp() {
  state.readingClock = Math.max(Date.now(), state.readingClock + 1);
  return state.readingClock;
}

function captureReadingProgress(observedAt = readingTimestamp()) {
  if (!state.chapter || state.restoringProgress || state.busy) return;
  const pages = [...el.reader.querySelectorAll('.page')];
  const line = window.scrollY + 54;
  const visible = pages.findIndex((page) => page.offsetTop + page.offsetHeight > line);
  const page = pages[visible < 0 ? pages.length - 1 : visible];
  if (!page) return;
  const chapter = state.chapters.find((item) => item.pageUrl === page.dataset.chapter);
  state.pendingProgress = { pageUrl: chapter.pageUrl, comicName: chapter.comicName || '',
    chapterName: chapter.chapterName || '', pageIndex: Number(page.dataset.index), observedAt,
    pageOffset: Math.min(1, Math.max(0, (line - page.offsetTop) / page.offsetHeight)) };
}

async function saveReadingProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  const record = state.pendingProgress;
  if (!record) return;
  state.pendingProgress = null;
  try {
    const result = await api.saveProgress(record);
    if (result?.error) throw new Error(result.error);
    state.readingClock = Math.max(state.readingClock, result?.record?.updatedAt || 0);
    if (result?.record?.deviceId?.startsWith('desktop-') && state.incomingProgress?.bookId === result.record.bookId) {
      state.incomingProgress = null; renderSyncStatus();
    }
  } catch {
    if (!state.pendingProgress) state.pendingProgress = record;
  }
}

function favoriteBookId(pageUrl) {
  const url = new URL(pageUrl);
  const match = url.pathname.match(/^\/comic\/chapter\/([^/]+)\//);
  return `${url.origin}${match ? `/comic/chapter/${match[1]}` : url.pathname}`;
}

function currentFavorite() {
  if (!state.chapter) return null;
  try { return state.favorites.find((favorite) => favorite.bookId === favoriteBookId(state.chapter.pageUrl)); }
  catch { return null; }
}

function renderFavoriteButton() {
  const saved = Boolean(currentFavorite());
  el.btnFavorite.disabled = !state.chapter || state.busy || state.changingFavorite;
  el.btnFavorite.classList.toggle('is-favorite', saved);
  el.btnFavorite.setAttribute('aria-pressed', String(saved));
  el.btnFavorite.setAttribute('aria-label', saved ? '取消收藏' : '收藏漫画');
  el.btnFavorite.title = saved ? '取消收藏' : '收藏漫画';
}

function renderFavorites(favorites = state.favorites) {
  state.favorites = favorites;
  renderFavoriteButton();
  const query = el.favoritesSearch.value.trim().toLocaleLowerCase();
  const visible = favorites.filter((favorite) => `${favorite.comicName} ${favorite.progress?.chapterName || favorite.chapterName}`.toLocaleLowerCase().includes(query));
  el.favoritesMessage.textContent = !favorites.length ? '还没有收藏，点击工具栏星标添加漫画' : !visible.length ? '没有匹配的收藏' : `共 ${favorites.length} 部漫画`;
  const rows = visible.map((favorite) => {
    const row = document.createElement('div'); row.className = 'favorites__row';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'favorites__open';
    const title = document.createElement('strong'); title.textContent = favorite.comicName || '未命名漫画';
    const detail = document.createElement('span');
    detail.textContent = favorite.progress ? `${favorite.progress.chapterName} · 第 ${favorite.progress.pageIndex + 1} 页 · 继续阅读` : `${favorite.chapterName || '章节'} · 打开阅读`;
    open.append(title, detail);
    open.addEventListener('click', () => {
      el.favoritesDialog.close();
      openChapter(favorite.progress?.pageUrl || favorite.pageUrl, favorite.progress || null);
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'favorites__remove';
    remove.textContent = '取消收藏'; remove.setAttribute('aria-label', `取消收藏 ${favorite.comicName || '漫画'}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        const result = await api.setFavorite(favorite, true);
        if (!result.ok) throw new Error(result.error);
        renderFavorites(result.favorites);
      } catch (error) { el.favoritesMessage.textContent = `取消收藏失败：${error.message}`; remove.disabled = false; }
    });
    row.append(open, remove); return row;
  });
  el.favoritesList.replaceChildren(...rows);
}

async function toggleFavorite() {
  if (!state.chapter || state.busy || state.changingFavorite) return;
  state.changingFavorite = true; renderFavoriteButton();
  try {
    const result = await api.setFavorite(state.chapter, Boolean(currentFavorite()));
    if (!result.ok) throw new Error(result.error);
    renderFavorites(result.favorites);
  } catch (error) {
    el.favoritesMessage.textContent = `收藏保存失败：${error.message}`;
    if (!el.favoritesDialog.open) el.favoritesDialog.showModal();
  } finally { state.changingFavorite = false; renderFavoriteButton(); }
}

async function showFavorites() {
  el.favoritesMessage.textContent = '正在读取收藏…';
  if (!el.favoritesDialog.open) el.favoritesDialog.showModal();
  try { renderFavorites(await api.listFavorites()); }
  catch (error) { el.favoritesMessage.textContent = `读取收藏失败：${error.message}`; }
}

let directoryEntries = [];
let directoryRequest = 0;
let directoryDescending = false;
function renderDirectory() {
  const query = el.chaptersSearch.value.trim().toLocaleLowerCase();
  let entries = directoryEntries.filter((entry) => entry.title.toLocaleLowerCase().includes(query));
  if (directoryDescending) entries = [...entries].reverse();
  el.chaptersList.replaceChildren(...entries.map((entry) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'favorites__open chapter-row';
    const current = new URL(entry.pageUrl).pathname.replace(/(\d+_\d+)(?:_\d+)?\.html$/, '$1.html') === new URL(state.chapter.pageUrl).pathname.replace(/(\d+_\d+)(?:_\d+)?\.html$/, '$1.html');
    const number = document.createElement('span'); number.className = 'chapter-row__number'; number.textContent = String(entry.index + 1).padStart(3, '0'); number.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.className = 'chapter-row__title'; title.textContent = entry.title;
    button.append(number, title);
    if (current) { const badge = document.createElement('span'); badge.className = 'chapter-row__badge'; badge.textContent = '正在阅读'; button.append(badge); }
    button.title = entry.title;
    button.setAttribute('aria-current', String(current));
    button.addEventListener('click', () => { el.chaptersDialog.close(); if (!current) openChapter(entry.pageUrl); });
    return button;
  }));
  if (directoryEntries.length) el.chaptersMessage.textContent = `共 ${directoryEntries.length} 章 · 匹配 ${entries.length} 章`;
}
async function showDirectory(refresh = false) {
  if (!state.chapter || state.busy) return;
  await saveReadingProgress();
  const token = ++directoryRequest;
  const url = state.chapter.pageUrl;
  if (!el.chaptersDialog.open) {
    document.getElementById('chapters-comic').textContent = state.chapter.comicName || '选择章节开始阅读';
    directoryEntries = []; el.chaptersSearch.value = ''; el.chaptersList.replaceChildren(); el.chaptersDialog.showModal();
  }
  el.chaptersMessage.textContent = '正在加载章节目录…';
  try {
    const result = await api.chapterDirectory(url, refresh);
    if (token !== directoryRequest || !el.chaptersDialog.open) return;
    if (!result.ok) throw new Error(result.error);
    directoryEntries = result.entries; renderDirectory();
    if (result.cached) el.chaptersMessage.textContent += ' · 本地目录';
    el.chaptersList.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    if (token === directoryRequest && el.chaptersDialog.open) el.chaptersMessage.textContent = `${error.message} · 点击刷新重试`;
  }
}

function renderSyncStatus(status) {
  if (status?.state === 'error') {
    el.statusSync.textContent = `${status.detail} · 点击同步重试`;
  } else if (state.incomingProgress) {
    const record = state.incomingProgress;
    el.statusSync.textContent = `手机进度：${record.chapterName || '章节'} 第 ${record.pageIndex + 1} 页 · 点击同步`;
  } else {
    el.statusSync.textContent = `${status?.detail || 'ADB 未连接'} · 点击同步`;
  }
  el.statusSync.classList.toggle('has-progress', Boolean(state.incomingProgress));
}

function returnToReading() {
  if (!state.chapter) return;
  state.requestId += 1;
  state.appending = false;
  state.busy = false;
  state.restoringProgress = false;
  cancelLoadingHint();
  hideOverlay();
  updateNavigation();
  el.urlInput.value = state.chapter.pageUrl;
  api.cancelLoad(state.chapter.pageUrl).then(() => api.prefetchUpcoming(state.chapter.nextUrl || '')).catch(() => {});
}

function goPrev() {
  if (!state.busy && state.chapter && state.chapter.prevUrl) openChapter(state.chapter.prevUrl);
}

function goNext() {
  if (!state.busy && state.chapter && state.chapter.nextUrl) openChapter(state.chapter.nextUrl);
}

/* ---------------------------------------------------------- 滚动到底自动翻章 */

async function appendNextChapter() {
  const tail = state.chapters.at(-1);
  if (!tail?.nextUrl || state.appending || !state.autoNext || state.busy) return;
  if (state.chapters.some((item) => item.pageUrl === tail.nextUrl)) return;
  const token = state.requestId;
  state.appending = true;
  try {
    const result = await api.appendChapter(tail.nextUrl);
    if (token !== state.requestId || !state.autoNext || result.stale) return;
    if (!result.ok) throw new Error(result.error || '网络暂时不可用');
    const chapter = result.chapter;
    state.chapters.push(chapter);
    state.total += chapter.images.length;
    el.reader.append(...chapter.images.map((image, index) => createPage(image, index, chapter)));
    state.appendError = '';
    updatePageStatus();
    // 图片缓存与正文追加同步开始，不阻塞当前滚动。

  } catch (error) {
    state.appendError = `下一话加载失败，继续滚动重试：${error.message}`;
    el.badge.hidden = false; el.badge.textContent = state.appendError;
  } finally {
    if (token === state.requestId) state.appending = false;
  }
}

function onScroll() {
  if (state.restoringProgress || state.busy) return;
  if (state.chapter && Math.abs(window.scrollY - state.lastScrollY) > 0.5 && !document.hidden) {
    captureReadingProgress();
    if (!progressTimer) progressTimer = setTimeout(saveReadingProgress, 500);
  }
  state.lastScrollY = window.scrollY;
  const pages = [...el.reader.querySelectorAll('.page')];
  const visible = pages.find((page) => page.offsetTop + page.offsetHeight > window.scrollY + 54);
  const active = state.chapters.find((item) => item.pageUrl === visible?.dataset.chapter);
  if (active && active !== state.chapter) {
    state.chapter = active;
    el.comicName.textContent = active.comicName;
    el.chapterName.textContent = active.chapterName;
    el.urlInput.value = active.pageUrl;
    document.title = active.title || active.chapterName;
    updateNavigation();
  }
  if (shouldAutoAdvanceNow()) appendNextChapter();
}

function shouldAutoAdvanceNow() {
  const tail = state.chapters.at(-1);
  if (!tail || !state.autoNext || state.busy || document.hidden || el.favoritesDialog.open || el.chaptersDialog.open || !el.overlay.hidden) return false;
  const pages = [...el.reader.querySelectorAll('.page')].filter((page) => page.dataset.chapter === tail.pageUrl);
  const first = pages[0], last = pages.at(-1);
  return window.ComicAutoNext.shouldAppend({ enabled: state.autoNext, busy: state.appending,
    hasNext: Boolean(tail.nextUrl), scrollY: window.scrollY, viewportHeight: window.innerHeight,
    chapterStart: first?.offsetTop, chapterHeight: first && last ? last.offsetTop + last.offsetHeight - first.offsetTop : 0 });
}

function renderAutoNextButton() {
  el.btnAutoNext.classList.toggle('is-active', state.autoNext);
  el.btnAutoNext.setAttribute('aria-pressed', String(state.autoNext));
  el.btnAutoNext.title = state.autoNext
    ? '连续阅读下一话：已开启，点击关闭'
    : '连续阅读下一话：已关闭，点击开启';
}

async function toggleAutoNext() {
  state.autoNext = await api.setAutoNext(!state.autoNext);
  renderAutoNextButton();
  if (state.autoNext && shouldAutoAdvanceNow()) appendNextChapter();
}

/* ------------------------------------------------------------------ 事件绑定 */

function bindEvents() {
  el.btnChapters.addEventListener('click', () => showDirectory());
  document.getElementById('chapters-close').addEventListener('click', () => el.chaptersDialog.close());
  document.getElementById('chapters-refresh').addEventListener('click', () => showDirectory(true));
  document.getElementById('chapters-order').addEventListener('click', (event) => { directoryDescending = !directoryDescending; event.target.textContent = directoryDescending ? '正序' : '倒序'; renderDirectory(); });
  el.chaptersSearch.addEventListener('input', renderDirectory);
  el.chaptersDialog.addEventListener('close', () => { directoryRequest += 1; });
  el.btnHome.addEventListener('click', async () => {
      await saveReadingProgress();
    try { await api.openHome(); } catch (error) { showOverlay('首页打开失败', error.message, false); }
  });
  api.onCatalogChapter((url) => { openChapter(url); });
  el.btnFavorite.addEventListener('click', toggleFavorite);
  el.btnFavorites.addEventListener('click', showFavorites);
  el.favoritesClose.addEventListener('click', () => el.favoritesDialog.close());
  el.favoritesSearch.addEventListener('input', () => renderFavorites());
  el.favoritesDialog.addEventListener('click', (event) => {
    if (event.target !== el.favoritesDialog) return;
    const bounds = el.favoritesDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) el.favoritesDialog.close();
  });
  api.onFavoritesChanged(renderFavorites);
  el.jumpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openChapter(el.urlInput.value);
  });

  el.btnPrev.addEventListener('click', goPrev);
  el.btnNext.addEventListener('click', goNext);
  el.btnTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  el.btnAutoNext.addEventListener('click', toggleAutoNext);

  // passive：滚动监听不能拖慢滚动
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  el.overlayRetry.addEventListener('click', () => openChapter(state.lastRequested));
  el.overlayBack.addEventListener('click', returnToReading);

  el.btnMin.addEventListener('click', () => api.window.minimize());
  el.btnMax.addEventListener('click', () => api.window.toggleMaximize());
  el.btnClose.addEventListener('click', async () => { await saveReadingProgress(); api.window.close(); });
  window.addEventListener('pagehide', saveReadingProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveReadingProgress(); });

  if (document.body.dataset.platform !== 'darwin') {
    el.bar.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, input, form')) return;
      api.window.toggleMaximize();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (el.favoritesDialog.open || el.chaptersDialog.open) return;
    if (event.target.closest?.('input, textarea, [contenteditable]') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') goPrev();
    else if (event.key === 'ArrowRight') goNext();
  });

  el.statusSync.addEventListener('click', async () => {
    await saveReadingProgress();
    el.statusSync.disabled = true;
    let result;
    try { result = await api.syncNow(); }
    catch (error) { result = { ok: false, error: error.message }; }
    finally { el.statusSync.disabled = false; }
    if (!result?.ok) { renderSyncStatus({ state: 'error', detail: result?.error || '同步失败，请重试' }); return; }
    const record = await api.latestProgress() || state.incomingProgress;
    if (!record) return;
    state.incomingProgress = null;
    renderSyncStatus(await api.syncStatus());
    openChapter(record.pageUrl, record, false);
  });
  api.onSyncStatus(renderSyncStatus);
  api.onProgressChanged((record) => {
    state.readingClock = Math.max(state.readingClock, record?.updatedAt || 0);
    state.incomingProgress = record?.deviceId?.startsWith('android-') ? record : null;
    renderSyncStatus();
  });

  api.onPrefetchProgress((progress) => {
    if (state.busy || progress.ownerUrl !== state.chapter?.pageUrl) return;
    prefetchStates.set(progress.url, progress);
    renderPrefetch();
  });

  // 清理掉历史章节后，磁盘占用会下降，这里同步刷新
  api.onCacheChanged((stats) => renderCacheStats(stats));

  // 只有真的要走站点验证网关时才提示「首次加载」。
  // 平时翻章命中预取是秒开的，不会弹任何覆盖层。
  api.onLoadingPhase(({ phase }) => {
    if (phase !== 'warming' || !state.busy) return;
    cancelLoadingHint();
    showOverlay(
      '正在通过站点验证',
      '站点有浏览器验证网关，首次通常需要十几秒；验证状态会保留，之后打开是秒开的',
    );
  });

  api.window.onMaximizedChange((maximized) => {
    el.btnMax.title = maximized ? '还原' : '最大化';
  });
}

/* -------------------------------------------------------------------- 启动 */

async function init() {
  const context = await api.getContext();
  document.body.dataset.platform = context.platform;
  state.readingClock = context.readingClock || 0;
  state.autoNext = Boolean(context.autoNext);
  renderAutoNextButton();
  bindEvents();
  updateNavigation();
  try { renderFavorites(await api.listFavorites()); } catch { /* 收藏读取失败仍可阅读 */ }
  renderSyncStatus(context.syncStatus);
  await openChapter(context.lastUrl || context.defaultUrl, null, false);
}

init().catch((error) => {
  showOverlay('阅读器启动失败', String(error && error.message ? error.message : error));
});
