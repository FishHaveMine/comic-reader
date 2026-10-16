'use strict';

function bookIdFor(pageUrl) {
  const url = new URL(pageUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('进度中的章节网址无效');
  const match = url.pathname.match(/^\/comic\/chapter\/([^/]+)\//);
  return `${url.origin}${match ? `/comic/chapter/${match[1]}` : url.pathname}`;
}

function validateRecord(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('阅读进度格式无效');
  const bookId = bookIdFor(raw.pageUrl);
  if (raw.bookId !== bookId || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt <= 0
    || !Number.isInteger(raw.pageIndex) || raw.pageIndex < 0 || raw.pageIndex > 100000
    || !Number.isFinite(raw.pageOffset) || raw.pageOffset < 0 || raw.pageOffset > 1
    || typeof raw.deviceId !== 'string' || !raw.deviceId || raw.deviceId.length > 128) {
    throw new Error('阅读进度字段无效');
  }
  return Object.fromEntries(Object.entries({
    bookId, pageUrl: raw.pageUrl, pageIndex: raw.pageIndex, pageOffset: raw.pageOffset,
    updatedAt: raw.updatedAt, deviceId: raw.deviceId,
    comicName: raw.comicName || '', chapterName: raw.chapterName || '',
  }).map(([key, value]) => {
    if (typeof value === 'string' && value.length > 4096) throw new Error('阅读进度字段过长');
    if (['comicName', 'chapterName'].includes(key) && typeof value !== 'string') throw new Error('标题无效');
    return [key, value];
  }));
}

function compareRecords(a, b) {
  const text = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  return a.updatedAt - b.updatedAt || text(a.deviceId, b.deviceId) || text(a.pageUrl, b.pageUrl)
    || a.pageIndex - b.pageIndex || a.pageOffset - b.pageOffset
    || text(a.comicName, b.comicName) || text(a.chapterName, b.chapterName);
}

function mergeRecords(local, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 2000) throw new Error('进度数量无效');
  // 先完整校验，避免半批写入。
  const validated = incoming.map(validateRecord);
  const map = new Map();
  for (const record of [...local, ...validated]) {
    const existing = map.get(record.bookId);
    if (!existing || compareRecords(record, existing) > 0) map.set(record.bookId, record);
  }
  return [...map.values()].sort((a, b) => compareRecords(b, a));
}

function samePosition(a, b) {
  return Boolean(a && b && a.pageUrl === b.pageUrl && a.pageIndex === b.pageIndex && a.pageOffset === b.pageOffset);
}

module.exports = { bookIdFor, validateRecord, compareRecords, mergeRecords, samePosition };
