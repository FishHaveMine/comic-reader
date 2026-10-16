'use strict';
const { validateRecord, compareRecords } = require('./reading-progress');

function validateFavorite(raw) {
  if (!raw || typeof raw.removed !== 'boolean') throw new Error('收藏状态无效');
  const { pageIndex, pageOffset, ...favorite } = validateRecord({ ...raw, pageIndex: 0, pageOffset: 0 });
  return { ...favorite, removed: raw.removed };
}

function mergeFavorites(local, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 2000) throw new Error('收藏数量无效');
  const validated = incoming.map(validateFavorite);
  const map = new Map(local.map((favorite) => [favorite.bookId, favorite]));
  for (const favorite of validated) {
    const old = map.get(favorite.bookId);
    if (!old || compareRecords(favorite, old) > 0) map.set(favorite.bookId, favorite);
  }
  // 保留取消收藏记录，避免离线设备重连后将已删除收藏重新加回来。
  return [...map.values()].sort((a, b) => compareRecords(b, a));
}
module.exports = { validateFavorite, mergeFavorites };
