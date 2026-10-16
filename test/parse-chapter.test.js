'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const { parseChapter } = require('../src/shared/parse-chapter');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'chapter-sample.html'), 'utf8');
const PAGE_URL = 'https://www.twmanga.com/comic/chapter/demo/0_6.html';

const order = (result) => result.images.map((img) => Number(img.url.split('/').pop().replace(/\D/g, '')));

describe('parseChapter 顺序（核心回归）', () => {
  const result = parseChapter(FIXTURE, PAGE_URL);

  test('按内容顺序排列：1,2,3,4,5,6', () => {
    assert.deepEqual(order(result), [1, 2, 3, 4, 5, 6]);
  });

  test('不得按 id 的「段内序号」排序', () => {
    // 段内序号排序的结果是 1,4,2,5,3,6，这正是曾经的真实 bug
    assert.notDeepEqual(order(result), [1, 4, 2, 5, 3, 6]);
  });

  test('不得使用 alt 末尾数字排序（它是段内序号，不是全局页码）', () => {
    // 第 4 张图的 alt 结尾是 1，若按其排序会跑到最前面
    assert.equal(result.images[3].url.endsWith('4.jpg'), true);
    assert.match(result.images[3].alt, /- 1$/);
  });

  test('index 是最终位置，从 0 起连续', () => {
    assert.deepEqual(result.images.map((img) => img.index), [0, 1, 2, 3, 4, 5]);
  });

  test('图片地址互不重复，且顺序严格递增', () => {
    const numbers = order(result);
    assert.equal(new Set(numbers).size, numbers.length);
    for (let i = 1; i < numbers.length; i += 1) {
      assert.ok(numbers[i] > numbers[i - 1], `第 ${i} 张编号 ${numbers[i]} 小于前一张 ${numbers[i - 1]}`);
    }
  });
});

describe('parseChapter 排序策略的边界', () => {
  test('文件名不是数字时，保持 DOM 顺序', () => {
    const html = `
      <amp-img id="chapter-img-0-0" src="https://s1.bzcdn.net/scomic/demo/b.jpg"></amp-img>
      <amp-img id="chapter-img-0-1" src="https://s1.bzcdn.net/scomic/demo/a.jpg"></amp-img>
      <amp-img id="chapter-img-0-2" src="https://s1.bzcdn.net/scomic/demo/c.jpg"></amp-img>`;
    assert.deepEqual(
      parseChapter(html, PAGE_URL).images.map((img) => img.url.split('/').pop()),
      ['b.jpg', 'a.jpg', 'c.jpg'],
    );
  });

  test('文件名是数字但 DOM 顺序被打乱时，按数字排', () => {
    const html = `
      <amp-img id="chapter-img-0-0" src="https://s1.bzcdn.net/scomic/demo/3.jpg"></amp-img>
      <amp-img id="chapter-img-0-1" src="https://s1.bzcdn.net/scomic/demo/1.jpg"></amp-img>
      <amp-img id="chapter-img-0-2" src="https://s1.bzcdn.net/scomic/demo/2.jpg"></amp-img>`;
    assert.deepEqual(order(parseChapter(html, PAGE_URL)), [1, 2, 3]);
  });

  test('文件名数字重复时不敢排序，退回 DOM 顺序', () => {
    const html = `
      <amp-img id="chapter-img-0-0" src="https://s1.bzcdn.net/a/1.jpg"></amp-img>
      <amp-img id="chapter-img-0-1" src="https://s1.bzcdn.net/b/1.jpg"></amp-img>
      <amp-img id="chapter-img-0-2" src="https://s1.bzcdn.net/a/2.jpg"></amp-img>`;
    assert.deepEqual(
      parseChapter(html, PAGE_URL).images.map((img) => img.url.split('/').pop()),
      ['1.jpg', '1.jpg', '2.jpg'],
    );
  });
});

describe('parseChapter 图片提取', () => {
  const result = parseChapter(FIXTURE, PAGE_URL);

  test('不会把 [src] / data-src 这类绑定属性误当成图片地址', () => {
    for (const img of result.images) {
      assert.match(img.url, /^https:\/\/s1\.bzcdn\.net\/scomic\//);
      assert.doesNotMatch(img.url, /chapter\d+Src/);
    }
  });

  test('同一地址重复出现时去重', () => {
    assert.equal(result.images.length, 6);
  });

  test('保留 width/height 以便预留版面、避免加载抖动', () => {
    assert.equal(result.images[0].width, 1200);
    assert.equal(result.images[0].height, 2340);
    assert.equal(result.images[1].height, 2198);
  });

  test('剔除站内 logo 等非正片图片', () => {
    assert.equal(result.images.some((img) => /baozimh\.com/.test(img.url)), false);
  });
});

describe('parseChapter 元数据与导航', () => {
  const result = parseChapter(FIXTURE, PAGE_URL);

  test('章节名取正片标题，而不是「更多推薦：」', () => {
    assert.equal(result.chapterName, '7 坑爹呢這是！');
  });

  test('漫画名从 description 的《》里取', () => {
    assert.equal(result.comicName, '萬界守門人');
  });

  test('组合出可显示的标题', () => {
    assert.equal(result.title, '萬界守門人 · 7 坑爹呢這是！');
  });

  test('取到上一话与下一话链接', () => {
    assert.equal(result.prevUrl, 'https://www.twmanga.com/comic/chapter/demo/0_5.html');
    assert.equal(result.nextUrl, 'https://www.twmanga.com/comic/chapter/demo/0_7.html');
  });

  test('相对链接会补全为绝对地址', () => {
    const html = '<a id="next-chapter" href="/comic/chapter/demo/0_8.html">下一話</a>';
    assert.equal(parseChapter(html, PAGE_URL).nextUrl, 'https://www.twmanga.com/comic/chapter/demo/0_8.html');
  });
});

describe('parseChapter 容错', () => {
  test('空内容抛错', () => {
    assert.throws(() => parseChapter(''), /章节内容为空/);
    assert.throws(() => parseChapter('   '), /章节内容为空/);
    assert.throws(() => parseChapter(null), /章节内容为空/);
  });

  test('没有约定 id 时，退化为按文档顺序收 CDN 图片', () => {
    const html = `
      <amp-img src="https://static-tw.baozimh.com/logo.png"></amp-img>
      <amp-img src="https://s1.bzcdn.net/scomic/demo/1.jpg"></amp-img>
      <amp-img src="https://s2.bzcdn.net/scomic/demo/2.jpg"></amp-img>`;
    assert.deepEqual(order(parseChapter(html, PAGE_URL)), [1, 2]);
  });

  test('没有下一话时返回空字符串而不是 undefined', () => {
    const result = parseChapter('<html><body>没有图</body></html>', PAGE_URL);
    assert.equal(result.nextUrl, '');
    assert.equal(result.prevUrl, '');
    assert.deepEqual(result.images, []);
  });

  test('缺少 width/height 时退化为 0', () => {
    const html = '<amp-img id="chapter-img-0-0" src="https://s1.bzcdn.net/scomic/demo/1.jpg"></amp-img>';
    const result = parseChapter(html, PAGE_URL);
    assert.equal(result.images[0].width, 0);
    assert.equal(result.images[0].height, 0);
  });
});
