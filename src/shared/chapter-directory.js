'use strict';
const { isCatalogUrl, chapterFromCatalog } = require('./catalog-navigation');
function comicId(pageUrl) {
  if (!isCatalogUrl(pageUrl)) throw new Error('此网址不支持章节目录');
  const id = new URL(pageUrl).pathname.match(/^\/comic\/chapter\/([a-zA-Z0-9_-]+)\/\d+_\d+(?:_\d+)?\.html$/)?.[1];
  if (!id) throw new Error('请先打开漫画章节');
  return id;
}
function directoryUrl(pageUrl) { return `https://www.baozimh.com/comic/${comicId(pageUrl)}`; }
function decode(text) {
  const names = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, key) => {
    if (key[0] !== '#') return names[key.toLowerCase()] || raw;
    const value = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : raw;
  });
}
function parseDirectory(html, pageUrl, baseUrl = directoryUrl(pageUrl)) {
  const id = comicId(pageUrl), origin = new URL(pageUrl).origin;
  const found = new Map();
  const clean = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  for (const match of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!href) continue;
    let url;
    try { url = chapterFromCatalog(new URL(decode(href[1] ?? href[2]), baseUrl).href); } catch { continue; }
    if (!url) continue;
    const parts = new URL(url).pathname.match(/^\/comic\/chapter\/([^/]+)\/(\d+)_(\d+)(?:_\d+)?\.html$/);
    if (!parts || parts[1] !== id) continue;
    const path = new URL(url).pathname;
    const title = decode(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!found.has(path) || !found.get(path).title) found.set(path, { pageUrl: `${origin}${path}`, title: title || `第 ${Number(parts[3]) + 1} 话`, section: Number(parts[2]), index: Number(parts[3]) });
  }
  return [...found.values()].sort((a, b) => a.section - b.section || a.index - b.index);
}
module.exports = { comicId, directoryUrl, parseDirectory };
