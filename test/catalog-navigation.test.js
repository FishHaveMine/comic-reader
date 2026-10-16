'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_URL, isCatalogUrl, chapterFromCatalog } = require('../src/shared/catalog-navigation');
test('返回首页指向指定分类地址', () => {
  const url = new URL(HOME_URL);
  assert.equal(url.origin + url.pathname, 'https://www.baozimh.com/classify');
  assert.equal(url.searchParams.get('filter'), '*');
  for (const field of ['type', 'region', 'state']) assert.equal(url.searchParams.get(field), 'all');
});
test('目录链接正确转换为现有阅读器章节地址', () => {
  assert.equal(chapterFromCatalog('https://www.baozimh.com/user/page_direct?chapter_slot=0&comic_id=wuliandianfeng-pikapi_lav8od&section_slot=0'),
    'https://www.twmanga.com/comic/chapter/wuliandianfeng-pikapi_lav8od/0_0.html');
  assert.equal(chapterFromCatalog('https://www.baozimh.com/user/page_direct?comic_id=demo&section_slot=1&chapter_slot=20'),
    'https://www.twmanga.com/comic/chapter/demo/1_20.html');
});
test('章节重定向支持两端域名，搜索和详情仍留在首页浏览界面', () => {
  assert.equal(isCatalogUrl('https://cn.bzmgcn.com/classify'), true);
  const chapter = 'https://www.twmanga.com/comic/chapter/demo/0_6.html';
  assert.equal(chapterFromCatalog(`${chapter}#top`), chapter);
  assert.equal(chapterFromCatalog('https://www.baozimh.com/comic/chapter/demo/0_6.html'), 'https://www.baozimh.com/comic/chapter/demo/0_6.html');
  assert.equal(chapterFromCatalog(HOME_URL), '');
  assert.equal(chapterFromCatalog('https://www.baozimh.com/comic/demo'), '');
});
test('不拦截外站伪装链接，拒绝无效章节参数', () => {
  for (const url of ['javascript:alert(1)', 'https://baozimh.com.evil.com/comic/chapter/demo/0_1.html', 'https://user@www.baozimh.com/comic/chapter/demo/0_1.html']) {
    assert.equal(isCatalogUrl(url), false); assert.equal(chapterFromCatalog(url), '');
  }
  assert.equal(chapterFromCatalog('https://www.baozimh.com/user/page_direct?comic_id=../bad&section_slot=0&chapter_slot=1'), '');
  assert.equal(chapterFromCatalog('https://www.baozimh.com/user/page_direct?comic_id=demo&chapter_slot=1'), '');
});
