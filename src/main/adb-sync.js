'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const PORT = 48765;
const PACKAGE = 'com.comicreader.comic_reader';

function findAdb() {
  const paths = [process.env.COMIC_ADB, process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'), path.join(os.homedir(), 'Android/Sdk/platform-tools/adb')];
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || 'adb';
}

function parseDevices(output) {
  return output.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device').map(([serial]) => serial);
}

class AdbSync {
  constructor({ store, dir, port = PORT, command = run, onStatus = () => {} }) {
    Object.assign(this, { store, dir, port, command, onStatus });
    this.paired = new Set();
    this.scanning = false;
    this.stopped = false;
    this.status = { state: 'starting', devices: 0, detail: '正在检查 ADB' };
    const tokenFile = path.join(dir, 'sync-token');
    fs.mkdirSync(dir, { recursive: true });
    try { this.token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* 创建配对令牌 */ }
    if (!/^[a-f0-9]{64}$/.test(this.token || '')) {
      this.token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenFile, this.token, { mode: 0o600 });
    }
  }

  setStatus(state, detail, devices = 0) {
    this.status = { state, detail, devices };
    this.onStatus(this.status);
  }

  async handle(req, res) {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    // 只接受经 ADB 配对的客户端；浏览器页面无 CORS 授权。
    if (req.headers.origin || req.headers.authorization !== `Bearer ${this.token}`) return reply(401, { error: '配对无效' });
    if (req.url !== '/v1/sync' || req.method !== 'POST') return reply(404, { error: '未知接口' });
    if (req.headers['x-comic-sync-trigger'] !== 'manual') return reply(409, { error: '请点击同步按钮进行手动同步' });
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { reply(413, { error: '进度数据过大' }); return; }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.version !== 1) throw new Error('不支持的同步版本');
      this.store.merge(payload.records, true, payload.favorites || []);
      reply(200, this.store.snapshot());
      if (this.pendingSync?.id === payload.requestId) this.pendingSync.resolve({ ok: true });
      this.setStatus('synced', `已比对两端 · 保留最新进度 · ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`, this.paired.size);
    } catch (error) {
      if (!res.headersSent) reply(400, { error: error.message });
    }
  }

  async start({ monitor = true } = {}) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    if (monitor) {
      await this.scan();
      this.timer = setInterval(() => this.scan(), 5000);
      this.timer.unref();
    }
    return this.port;
  }

  async adb(args) { return this.command(findAdb(), args, { timeout: 7000, maxBuffer: 1024 * 1024 }); }

  requestSync() {
    if (this.syncTask) return this.syncTask;
    const task = (async () => {
      await this.scan();
      if (!this.paired.size) return { ok: false, error: this.status.detail };
      const id = crypto.randomBytes(16).toString('hex');
      let timer;
      const completed = new Promise((resolve) => {
        this.pendingSync = { id, resolve };
        timer = setTimeout(() => resolve({ ok: false, error: '手机未完成同步，请确认手机已安装最新版并保持连接' }), 12000);
      });
      this.setStatus('syncing', '正在手动同步…', this.paired.size);
      try {
        for (const serial of this.paired) {
          await this.adb(['-s', serial, 'shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`,
            '--es', 'sync_token', this.token, '--ei', 'sync_port', String(this.port), '--es', 'sync_request', id]);
        }
        const result = await completed;
        if (!result.ok) this.setStatus('error', result.error);
        return result;
      } catch (error) {
        this.setStatus('error', '手动同步失败，请检查 ADB 连接');
        return { ok: false, error: this.status.detail };
      } finally { clearTimeout(timer); this.pendingSync = null; }
    })().finally(() => { this.syncTask = null; });
    this.syncTask = task;
    return task;
  }

  scan() {
    if (this.scanTask) return this.scanTask;
    const task = this.scanDevices().finally(() => { this.scanTask = null; });
    this.scanTask = task; return task;
  }

  async scanDevices() {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const { stdout } = await this.adb(['devices']);
      const devices = parseDevices(stdout);
      for (const serial of this.paired) if (!devices.includes(serial)) this.paired.delete(serial);
      if (!devices.length) { this.setStatus('disconnected', 'ADB 未连接 · 连接手机后点击同步'); return; }
      let missing = 0;
      for (const serial of devices) {
        if (this.stopped) return;
        await this.adb(['-s', serial, 'reverse', `tcp:${this.port}`, `tcp:${this.port}`]);
        if (this.paired.has(serial)) continue;
        const installed = await this.adb(['-s', serial, 'shell', 'pm', 'list', 'packages', PACKAGE]);
        if (!installed.stdout.split(/\r?\n/).some((line) => line.trim() === `package:${PACKAGE}`)) { missing += 1; continue; }
        // token 仅含十六进制字符，参数以 execFile 传递，避免 shell 插值。
        const launch = await this.adb(['-s', serial, 'shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`,
          '--es', 'sync_token', this.token, '--ei', 'sync_port', String(this.port)]);
        if (/Error:/i.test(launch.stdout + launch.stderr)) throw new Error('无法启动手机阅读器');
        this.paired.add(serial);
      }
      if (!this.paired.size) this.setStatus('install', `${missing} 台手机待安装 Flutter 阅读器`, devices.length);
      else if (!['synced', 'syncing'].includes(this.status.state)) this.setStatus('connected', `ADB 已连接 ${this.paired.size} 台 · 手动同步待命`, this.paired.size);
    } catch (error) {
      this.setStatus('error', error.code === 'ENOENT' ? '未找到 ADB，请设置 COMIC_ADB' : `ADB 同步暂不可用：${error.message.split('\n')[0]}`);
    } finally { this.scanning = false; }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.server?.listening) {
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

module.exports = { AdbSync, parseDevices, findAdb, PORT, PACKAGE };
