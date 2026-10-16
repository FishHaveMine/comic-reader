'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-directory-live-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { SessionSource } = require('../src/main/session-source');
  const source = new SessionSource(); await source.configureProxy();
  const url = process.env.COMIC_DIRECTORY_URL || 'https://www.twmanga.com/comic/chapter/mojieshoumenren-yuewenmanhua/0_6.html';
  const entries = await source.loadDirectory(url);
  assert.ok(entries.length > 7);
  assert.ok(entries.some((entry) => new URL(entry.pageUrl).pathname === new URL(url).pathname.replace(/(\d+_\d+)(?:_\d+)?\.html$/, '$1.html')));
  assert.equal(new Set(entries.map((entry) => entry.pageUrl)).size, entries.length);
  console.log(`PASS 真实漫画目录加载 ${entries.length} 章，当前章节存在，链接无重复`);
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
app.on('quit', () => fs.rmSync(profile, { recursive: true, force: true }));
