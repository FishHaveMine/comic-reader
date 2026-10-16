'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldAppend } = require('../src/renderer/auto-next');
const input = { enabled: true, busy: false, hasNext: true, scrollY: 100, viewportHeight: 800, chapterStart: 0, chapterHeight: 1800 };
test('视口到达本章中段时接续，前半章不提前追加', () => {
  assert.equal(shouldAppend(input), true);
  assert.equal(shouldAppend({ ...input, scrollY: 99 }), false);
});
test('追加后按新章起点判定，不按整个文档中点重复追加', () => {
  assert.equal(shouldAppend({ ...input, chapterStart: 1800 }), false);
  assert.equal(shouldAppend({ ...input, chapterStart: 1800, scrollY: 1900 }), true);
});
test('关闭、正在追加、末章或缺失尺寸均不追加', () => {
  for (const patch of [{ enabled: false }, { busy: true }, { hasNext: false }, { chapterHeight: 0 }, { viewportHeight: 0 }, { chapterStart: undefined }]) {
    assert.equal(shouldAppend({ ...input, ...patch }), false);
  }
});
