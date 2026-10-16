'use strict';

/**
 * 章节页解析：纯函数，不依赖 Electron 与网络，便于单测。
 *
 * 目标站点（twmanga / 包子漫畫）的章节页是 AMP 静态页，正片图片形如：
 *
 *   <amp-img id="chapter-img-1-3" width="1200" height="2340"
 *            src="https://s1.bzcdn.net/scomic/xxx/10.jpg"
 *            [src]="chapter10Src" data-src="https://s1.bzcdn.net/scomic/xxx/10.jpg"
 *            alt="萬界守門人 - 7 坑爹呢這是！ - 4">
 *
 * 排序是这个文件里最容易踩坑的地方，实测结论（4 话 163 页逐页核对）：
 *
 *  1. id 是 `chapter-img-<段>-<段内序号>` 两段结构，站点把图片每 6 张切成一段，
 *     真实页码 = 段 * 6 + 段内序号 + 1。**段内序号不是全局页码**，
 *     按它排序会把第 1、7、13… 页排到最前面（曾经的真实 bug）。
 *  2. alt 末尾的数字同样是「段内序号」，也不能当作全局页码。
 *  3. 站点的 DOM 顺序就是阅读顺序，且与 CDN 文件名 1.jpg、2.jpg… 完全一致。
 *
 * 因此默认保持 DOM 顺序；当所有文件名都是纯数字序列时，认为这个序列更权威，
 * 按它排序（可抵御 DOM 被重排的情况）。
 *
 * 另外 `[src]="..."` 是前端绑定占位属性，属性名里含 src，
 * 匹配时必须要求 src 前面是空白，否则会误抓成图片地址。
 */

const AMP_IMG_TAG = /<amp-img\b[^>]*>/gi;
const COMIC_IMG_ID = /^chapter-img-\d+-\d+$/;
const COMIC_CDN_PATH = /\/scomic\//i;
const SITE_SUFFIX = /\s*-\s*包子漫畫\s*$/;
const NUMERIC_FILE = /^(\d+)\.\w+$/;

function readAttr(tag, name) {
  const matched = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return matched ? matched[1] : '';
}

/** 取 CDN 文件名里的页码（1.jpg → 1）；不是纯数字文件名则返回 null */
function fileNameNumber(url) {
  const name = decodeURIComponent(String(url).split('/').pop() || '');
  const matched = name.match(NUMERIC_FILE);
  return matched ? Number(matched[1]) : null;
}

function absolute(url, base) {
  if (!url) return '';
  try {
    return base ? new URL(url, base).href : new URL(url).href;
  } catch {
    return url;
  }
}

function pickNav(html, id, pageUrl) {
  const tag = html.match(new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>`, 'i'));
  if (!tag) return '';
  return absolute(readAttr(tag[0], 'href'), pageUrl);
}

function pickChapterName(html) {
  const labels = [...html.matchAll(/<span[^>]*\bclass="title"[^>]*>([^<]{1,60})<\/span>/gi)].map((m) => m[1].trim());
  // 「更多推薦：」这类栏目名也用了 .title，需要排除
  const chapter = labels.find((text) => text && !/推薦|更多|热门|標籤/.test(text));
  if (chapter) return chapter;

  const title = (html.match(/<title[^>]*>([\s\S]{0,160}?)<\/title>/i) || [])[1] || '';
  return title.replace(SITE_SUFFIX, '').trim();
}

function pickComicName(html) {
  const description = (html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i) || [])[1] || '';
  const fromDescription = description.match(/《([^》]+)》/);
  if (fromDescription) return fromDescription[1].trim();

  const title = (html.match(/<title[^>]*>([\s\S]{0,160}?)<\/title>/i) || [])[1] || '';
  const parts = title.replace(SITE_SUFFIX, '').split(' - ');
  return parts.length >= 2 ? parts[parts.length - 1].trim() : '';
}

/**
 * @param {string} html 章节页 HTML
 * @param {string} [pageUrl] 页面地址，用于把相对链接补全为绝对地址
 * @returns {{pageUrl:string,comicName:string,chapterName:string,title:string,images:Array,prevUrl:string,nextUrl:string}}
 */
function parseChapter(html, pageUrl = '') {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('章节内容为空');
  }

  const collect = (filter) => {
    const picked = [];
    const seen = new Set();
    for (const tag of html.match(AMP_IMG_TAG) || []) {
      if (!filter(tag)) continue;
      const url = readAttr(tag, 'src');
      if (!url || seen.has(url)) continue; // 同一地址在页面里会重复出现
      seen.add(url);
      picked.push({
        url: absolute(url, pageUrl),
        width: Number(readAttr(tag, 'width')) || 0,
        height: Number(readAttr(tag, 'height')) || 0,
        alt: readAttr(tag, 'alt'),
      });
    }
    return picked;
  };

  // 主路径：靠 id 约定只收正片（顺带排除站内 logo 等）
  let images = collect((tag) => COMIC_IMG_ID.test(readAttr(tag, 'id')));

  // 兜底：站点改版式认不出 id 时，退化为收 CDN 上的图片
  if (images.length === 0) {
    images = collect((tag) => COMIC_CDN_PATH.test(readAttr(tag, 'src')));
  }

  // 排序：文件名是互不重复的纯数字序列时按它排（CDN 的权威页码），
  // 否则保持 DOM 顺序（站点就是按阅读顺序输出的）
  const numbers = images.map((img) => fileNameNumber(img.url));
  const usable = numbers.every((n) => n !== null) && new Set(numbers).size === numbers.length;
  if (usable) images.sort((a, b) => fileNameNumber(a.url) - fileNameNumber(b.url));

  images.forEach((img, position) => { img.index = position; });

  const comicName = pickComicName(html);
  const chapterName = pickChapterName(html);

  return {
    pageUrl,
    comicName,
    chapterName,
    title: [comicName, chapterName].filter(Boolean).join(' · '),
    images,
    prevUrl: pickNav(html, 'prev-chapter', pageUrl),
    nextUrl: pickNav(html, 'next-chapter', pageUrl),
  };
}

module.exports = { parseChapter };
