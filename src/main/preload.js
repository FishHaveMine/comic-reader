'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('reader', {
  getContext: () => ipcRenderer.invoke('app:context'),
  rememberUrl: (url) => ipcRenderer.invoke('app:remember-url', url),
  setAutoNext: (flag) => ipcRenderer.invoke('app:set-auto-next', flag),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  openHome: () => ipcRenderer.invoke('catalog:open'),
  onCatalogChapter: (handler) => subscribe('catalog:chapter', handler),
  cancelLoad: (url) => ipcRenderer.invoke('chapter:cancel', url),
  appendChapter: (url) => ipcRenderer.invoke('chapter:append', url),
  chapterDirectory: (url, refresh = false) => ipcRenderer.invoke('chapter:directory', url, refresh),
  loadChapter: (url) => ipcRenderer.invoke('chapter:load', url),
  prefetchUpcoming: (url) => ipcRenderer.invoke('chapter:prefetch', url),
  listFavorites: () => ipcRenderer.invoke('favorites:list'),
  setFavorite: (favorite, removed) => ipcRenderer.invoke('favorites:set', favorite, removed),
  onFavoritesChanged: (handler) => subscribe('favorites:changed', handler),
  saveProgress: (record) => ipcRenderer.invoke('progress:save', record),
  latestProgress: () => ipcRenderer.invoke('progress:latest'),
  onProgressChanged: (handler) => subscribe('progress:changed', handler),
  onSyncStatus: (handler) => subscribe('sync:status', handler),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  onPrefetchProgress: (handler) => subscribe('prefetch:progress', handler),
  onLoadingPhase: (handler) => subscribe('loading:phase', handler),
  onCacheChanged: (handler) => subscribe('cache:changed', handler),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (handler) => subscribe('window:maximized-changed', handler),
  },
});
