'use strict';
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComicAutoNext = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function build() {
  function shouldAppend({ enabled, busy, hasNext, scrollY, viewportHeight, chapterStart, chapterHeight }) {
    if (!enabled || busy || !hasNext || !(chapterHeight > 0) || !(viewportHeight > 0) || !Number.isFinite(chapterStart)) return false;
    return scrollY + viewportHeight >= chapterStart + chapterHeight / 2;
  }
  return { shouldAppend };
}));
