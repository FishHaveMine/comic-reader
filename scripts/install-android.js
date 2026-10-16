'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { parseDevices, findAdb, PACKAGE } = require('../src/main/adb-sync');
const run = promisify(execFile);
const adb = findAdb();
async function main() {
  const debug = process.argv.includes('--debug');
  const apk = path.join(__dirname, '../mobile/build/app/outputs/flutter-apk', debug ? 'app-debug.apk' : 'app-release.apk');
  if (!fs.existsSync(apk)) throw new Error('请先运行 npm run android:build（或在 mobile 中 flutter build apk --debug）');
  const devices = parseDevices((await run(adb, ['devices'])).stdout);
  const serialIndex = process.argv.indexOf('--serial');
  const serial = serialIndex >= 0 ? process.argv[serialIndex + 1] : devices.length === 1 ? devices[0] : '';
  if (!serial || !devices.includes(serial)) throw new Error('请连接并授权一台手机；多设备时添加 --serial <设备序列号>');
  const installed = await run(adb, ['-s', serial, 'install', '-r', apk], { timeout: 120000 });
  if (!installed.stdout.includes('Success')) throw new Error(installed.stdout || installed.stderr);
  await run(adb, ['-s', serial, 'shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`], { timeout: 10000 });
  console.log(`漫画阅读器已安装并启动（${debug ? 'debug' : 'release'}）。运行桌面阅读器后 ADB 自动配对，点击同步按钮进行手动同步。`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
