'use strict';

/**
 * 多平台构建入口：选择平台 → 执行对应构建 → 把产物统一收拢到一个文件夹。
 *
 *   node scripts/build.js                 # 交互式选择平台
 *   node scripts/build.js -p desktop      # 只构建桌面端（macOS）
 *   node scripts/build.js -p android      # 只构建 Android APK
 *   node scripts/build.js -p all          # 构建全部可用平台
 *   node scripts/build.js -p android --aab --out release
 *
 * 产物统一输出到 dist/（可用 --out 改名）：
 *   dist/
 *   ├── desktop/漫画阅读器.app    桌面启动壳 + icon.icns
 *   ├── android/app-release.apk   Flutter release 包（含 .sha1）
 *   └── build-manifest.txt       本次构建的平台、版本与时间
 *
 * 桌面端刻意不引入 electron-builder：.app 只是启动壳，内部记录项目绝对路径，
 * 每次运行的都是项目里最新的代码（与 scripts/make-shortcut.sh 同一思路）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = path.join(ROOT, 'mobile');
const DEFAULT_OUT = path.join(ROOT, 'dist');

const APP_NAME = '漫画阅读器';
const BUNDLE_ID = 'com.comicreader.desktop';
const LOG_NAME = 'Comic Reader';

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const opts = { platform: null, out: DEFAULT_OUT, aab: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--platform') {
      opts.platform = argv[i + 1];
      i += 1;
    } else if (arg === '--out' || arg === '-o') {
      opts.out = path.resolve(ROOT, argv[i + 1]);
      i += 1;
    } else if (arg === '--aab') {
      opts.aab = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (!arg.startsWith('-') && !opts.platform) {
      opts.platform = arg;
    }
  }
  return opts;
}

const HELP = `
用法: node scripts/build.js [选项]

选项:
  -p, --platform <desktop|android|all>  选择构建平台（缺省则交互式选择）
  -o, --out <目录>                       产物统一输出目录，默认 dist/
      --aab                              Android 额外构建 release AAB
  -h, --help                            显示帮助
`.trim();

/* ---------------------------------------------------------------- 小工具 */

function log(msg) {
  console.log(`\u001b[36m[build]\u001b[0m ${msg}`);
}

function warn(msg) {
  console.warn(`\u001b[33m[build]\u001b[0m ${msg}`);
}

function run(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) {
    throw new Error(`执行失败：${command}（${result.error.message}）`);
  }
  if (result.status !== 0) {
    throw new Error(`命令退出码 ${result.status}：${command} ${args.join(' ')}`);
  }
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: false });
}

function fileSize(p) {
  const bytes = fs.statSync(p).size;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/* ------------------------------------------------------------- 桌面端构建 */

function buildDesktop(outDir) {
  if (os.platform() !== 'darwin') {
    throw new Error('桌面端启动壳仅面向 macOS（依赖 sips / iconutil）。');
  }
  for (const bin of ['sips', 'iconutil']) {
    if (!which(bin)) throw new Error(`缺少系统命令 ${bin}，无法生成桌面图标。`);
  }

  const electron = path.join(
    ROOT,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
  if (!fs.existsSync(electron)) {
    throw new Error('找不到 Electron 运行时，请先执行 npm install。');
  }

  log('生成图标（scripts/make-icon.js）...');
  run(process.execPath, [path.join(ROOT, 'scripts/make-icon.js')], ROOT);

  const iconPng = path.join(ROOT, 'build/icon.png');
  const iconset = path.join(ROOT, 'build/icon.iconset');
  const icns = path.join(ROOT, 'build/icon.icns');

  log('合成 icon.icns ...');
  rmrf(iconset);
  fs.mkdirSync(iconset, { recursive: true });
  const specs = ['16 16', '16 32', '32 32', '32 64', '128 128', '128 256', '256 256', '256 512', '512 512', '512 1024'];
  for (const spec of specs) {
    const [base, px] = spec.split(' ');
    const suffix = Number(px) === Number(base) ? '' : '@2x';
    run('sips', ['-z', px, px, iconPng, '--out', path.join(iconset, `icon_${base}x${base}${suffix}.png`)], ROOT);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', icns], ROOT);

  log('组装 .app 启动壳 ...');
  const bundle = path.join(outDir, `${APP_NAME}.app`);
  rmrf(bundle);
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents/Resources'), { recursive: true });
  copyFile(icns, path.join(bundle, 'Contents/Resources/appicon.icns'));

  const version = readVersion();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleIconFile</key><string>appicon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), plist);

  // Finder 双击不会带上登录 shell 的 PATH，用绝对路径直接执行；stderr 落日志。
  const launch = `#!/bin/bash
PROJECT="${ROOT}"
ELECTRON="$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="$HOME/Library/Logs/${LOG_NAME}.log"

if [ ! -x "$ELECTRON" ]; then
  osascript -e 'display alert "缺少 Electron 运行时" message "请在项目目录执行 npm install 后重试。"'
  exit 1
fi

mkdir -p "$HOME/Library/Logs" 2>/dev/null || true
: > "$LOG" 2>/dev/null || LOG=/dev/null

cd "$PROJECT" || exit 1
exec "$ELECTRON" "$PROJECT" >> "$LOG" 2>&1
`;
  const launchPath = path.join(bundle, 'Contents/MacOS/launch');
  fs.writeFileSync(launchPath, launch);
  fs.chmodSync(launchPath, 0o755);

  if (which('xattr')) {
    spawnSync('xattr', ['-cr', bundle], { stdio: 'ignore' });
  }

  return [`${APP_NAME}.app（${fileSize(icns)} 图标）`];
}

/* ------------------------------------------------------------ Android 构建 */

function buildAndroid(outDir, alsoAab) {
  if (!which('flutter')) {
    throw new Error('未找到 flutter 命令，请确认 Flutter SDK 已加入 PATH。');
  }

  log('构建 Android release APK ...');
  run('flutter', ['build', 'apk', '--release'], MOBILE_DIR);

  const apkDir = path.join(MOBILE_DIR, 'build/app/outputs/flutter-apk');
  const apk = path.join(apkDir, 'app-release.apk');
  if (!fs.existsSync(apk)) {
    throw new Error(`构建完成但未找到 APK：${apk}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  copyFile(apk, path.join(outDir, 'app-release.apk'));
  const apkSha1 = `${apk}.sha1`;
  if (fs.existsSync(apkSha1)) copyFile(apkSha1, path.join(outDir, 'app-release.apk.sha1'));

  const produced = [`app-release.apk（${fileSize(apk)}）`];

  if (alsoAab) {
    log('构建 Android release AAB ...');
    run('flutter', ['build', 'appbundle', '--release'], MOBILE_DIR);
    const aab = path.join(MOBILE_DIR, 'build/app/outputs/bundle/release/app-release.aab');
    if (fs.existsSync(aab)) {
      copyFile(aab, path.join(outDir, 'app-release.aab'));
      produced.push(`app-release.aab（${fileSize(aab)}）`);
    } else {
      warn(`未找到 AAB：${aab}`);
    }
  }

  return produced;
}

/* --------------------------------------------------------------- 交互选择 */

const PLATFORMS = [
  { key: 'desktop', label: '桌面端（macOS .app 启动壳）' },
  { key: 'android', label: 'Android（Flutter release APK）' },
  { key: 'all', label: '全部平台' },
];

function promptPlatform() {
  const available = os.platform() === 'darwin' ? PLATFORMS : PLATFORMS.filter((p) => p.key === 'android');
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('请选择要构建的平台：');
    available.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}`));
    rl.question(`输入序号（1-${available.length}，默认 1）: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') return resolve(available[0].key);
      const index = Number(trimmed) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= available.length) {
        return reject(new Error(`无效的序号：${answer}`));
      }
      return resolve(available[index].key);
    });
  });
}

/* ------------------------------------------------------------------- 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  let platform = opts.platform;
  if (platform && !['desktop', 'android', 'all'].includes(platform)) {
    throw new Error(`未知平台：${platform}（可选 desktop / android / all）`);
  }
  if (!platform) {
    platform = await promptPlatform();
  }

  const targets = platform === 'all' ? ['desktop', 'android'] : [platform];
  fs.mkdirSync(opts.out, { recursive: true });

  const manifest = [
    `构建时间: ${new Date().toISOString()}`,
    `项目版本: ${readVersion()}`,
    `平台选择: ${platform}`,
    '',
  ];
  const failures = [];

  for (const target of targets) {
    const outDir = path.join(opts.out, target);
    rmrf(outDir);
    console.log('');
    log(`===== 开始构建 ${target} =====`);
    try {
      const produced = target === 'desktop'
        ? buildDesktop(outDir)
        : buildAndroid(outDir, opts.aab);
      manifest.push(`[${target}]`, ...produced.map((p) => `  - ${p}`), '');
      log(`${target} 构建完成 → ${outDir}`);
    } catch (err) {
      failures.push(`${target}: ${err.message}`);
      warn(`${target} 构建失败：${err.message}`);
    }
  }

  if (failures.length) {
    manifest.push('失败:', ...failures.map((f) => `  - ${f}`), '');
  }
  manifest.push('产物目录内容:');
  for (const entry of fs.readdirSync(opts.out, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'build-manifest.txt') continue;
    manifest.push(`  ${entry.isDirectory() ? `${entry.name}/` : entry.name}`);
  }
  fs.writeFileSync(path.join(opts.out, 'build-manifest.txt'), manifest.join('\n'));

  console.log('');
  log(`产物统一目录：${opts.out}`);
  if (failures.length) {
    warn(`有 ${failures.length} 个平台构建失败，详见 build-manifest.txt。`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\u001b[31m[build] ${err.message}\u001b[0m`);
  process.exitCode = 1;
});
