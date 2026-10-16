'use strict';
const HOME_URL = 'https://www.baozimh.com/classify?type=all&region=all&state=all&filter=%2a';
function isCatalogUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['baozimh.com', 'bzmgcn.com', 'twmanga.com', 'dzmanga.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
function chapterFromCatalog(raw) {
  if (!isCatalogUrl(raw)) return '';
  const url = new URL(raw);
  if (/^\/comic\/chapter\/[^/]+\/\d+_\d+(?:_\d+)?\.html$/.test(url.pathname)) {
    url.hash = '';
    return url.href;
  }
  if (url.pathname !== '/user/page_direct') return '';
  const comic = url.searchParams.get('comic_id') || '';
  const section = url.searchParams.get('section_slot') || '';
  const chapter = url.searchParams.get('chapter_slot') || '';
  if (!/^[a-zA-Z0-9_-]+$/.test(comic) || !/^\d+$/.test(section) || !/^\d+$/.test(chapter)) return '';
  return `https://www.twmanga.com/comic/chapter/${comic}/${section}_${chapter}.html`;
}
module.exports = { HOME_URL, isCatalogUrl, chapterFromCatalog };
