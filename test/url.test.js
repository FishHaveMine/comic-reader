'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');

const { normalizeUrl } = require('../src/shared/url');

describe('normalizeUrl', () => {
  test('保留完整章节地址', () => {
    const url = 'https://www.twmanga.com/comic/chapter/demo/0_6.html';
    assert.equal(normalizeUrl(url), url);
  });

  test('缺协议时补 https', () => {
    assert.equal(normalizeUrl('www.twmanga.com/a.html'), 'https://www.twmanga.com/a.html');
  });

  test('去掉首尾空白', () => {
    assert.equal(normalizeUrl('  https://a.com/b  '), 'https://a.com/b');
  });

  test('拒绝空输入与非法协议', () => {
    assert.throws(() => normalizeUrl(''), /请输入章节网址/);
    assert.throws(() => normalizeUrl('file:///etc/passwd'), /只支持 http \/ https/);
    assert.throws(() => normalizeUrl(null), TypeError);
  });
});
