'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { bookIdFor, mergeRecords, validateRecord, samePosition } = require('../shared/reading-progress');
const { mergeFavorites, validateFavorite } = require('../shared/favorites');

class ProgressStore {
  constructor(file, onChanged = () => {}, onFavoritesChanged = () => {}) {
    Object.assign(this, { file, onChanged, onFavoritesChanged });
    this.deviceId = `desktop-${crypto.randomUUID()}`;
    this.records = [];
    this.favorites = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.records = mergeRecords([], saved.records);
      this.favorites = mergeFavorites([], saved.favorites || []);
      if (typeof saved.deviceId === 'string') this.deviceId = saved.deviceId;
    } catch { /* 首次启动或不可读文件 */ }
  }

  latest() { return this.records[0] || null; }
  snapshot() { return { version: 1, deviceId: this.deviceId, records: this.records, favorites: this.favorites }; }
  listFavorites() {
    return this.favorites.filter((favorite) => !favorite.removed).map((favorite) => ({
      ...favorite, progress: this.records.find((record) => record.bookId === favorite.bookId) || null,
    }));
  }
  timestamp() {
    return Math.max(Date.now(), (this.latest()?.updatedAt || 0) + 1, (this.favorites[0]?.updatedAt || 0) + 1);
  }

  save(raw, { observedAt } = {}) {
    const record = validateRecord({ ...raw, bookId: bookIdFor(raw.pageUrl), deviceId: this.deviceId,
      updatedAt: observedAt ?? this.timestamp() });
    const existing = this.records.find((item) => item.bookId === record.bookId);
    if (samePosition(existing, record)) return existing;
    this.merge([record], false);
    return this.records.find((item) => item.bookId === record.bookId);
  }

  setFavorite(raw, removed) {
    const favorite = validateFavorite({ ...raw, bookId: bookIdFor(raw.pageUrl), removed,
      deviceId: this.deviceId, updatedAt: this.timestamp() });
    this.merge([], false, [favorite]);
    return this.listFavorites();
  }

  merge(records, remote = true, favorites = []) {
    const merged = mergeRecords(this.records, records);
    const mergedFavorites = mergeFavorites(this.favorites, favorites);
    const progressChanged = JSON.stringify(merged) !== JSON.stringify(this.records);
    const favoritesChanged = JSON.stringify(mergedFavorites) !== JSON.stringify(this.favorites);
    if (!progressChanged && !favoritesChanged) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, deviceId: this.deviceId,
      records: merged, favorites: mergedFavorites }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.records = merged;
    this.favorites = mergedFavorites;
    if (remote && progressChanged) this.onChanged(this.latest());
    if (favoritesChanged) this.onFavoritesChanged(this.listFavorites());
    return true;
  }
}

module.exports = { ProgressStore };
