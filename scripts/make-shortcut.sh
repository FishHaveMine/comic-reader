#!/bin/bash
#
# 在桌面生成「漫画阅读器.app」快捷方式（仅 macOS）。
#
# 刻意不引入 electron-builder：这个 .app 只是个启动壳，内部记录项目路径，
# 每次都运行项目里最新的代码，改完源码不需要重新生成快捷方式。

set -euo pipefail

APP_NAME="漫画阅读器"
BUNDLE_ID="com.comicreader.desktop"
LOG_NAME="Comic Reader"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$HOME/Desktop/$APP_NAME.app"
ELECTRON="$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "该脚本只面向 macOS。" >&2
  exit 1
fi

if [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron 运行时：$ELECTRON" >&2
  echo "请先在项目目录执行 npm install。" >&2
  exit 1
fi

# ---------------------------------------------------------------- 1. 图标

node "$PROJECT/scripts/make-icon.js"

ICON_PNG="$PROJECT/build/icon.png"
ICONSET="$PROJECT/build/icon.iconset"
ICNS="$PROJECT/build/icon.icns"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
# 名称必须是 iconutil 认可的规范名
for spec in "16 16" "16 32" "32 32" "32 64" "128 128" "128 256" "256 256" "256 512" "512 512" "512 1024"; do
  base="${spec% *}"
  px="${spec#* }"
  suffix=""
  [ "$px" -ne "$base" ] && suffix="@2x"
  sips -z "$px" "$px" "$ICON_PNG" --out "$ICONSET/icon_${base}x${base}${suffix}.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ICNS"

# ------------------------------------------------------------ 2. 组装 .app

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$ICNS" "$BUNDLE/Contents/Resources/appicon.icns"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>appicon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Finder 双击时不会带上登录 shell 的 PATH，所以用绝对路径直接执行。
# 双击启动看不到 stderr，把输出落到日志方便排查。
cat > "$BUNDLE/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
PROJECT="$PROJECT"
ELECTRON="\$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="\$HOME/Library/Logs/$LOG_NAME.log"

if [ ! -x "\$ELECTRON" ]; then
  osascript -e 'display alert "缺少 Electron 运行时" message "请在项目目录执行 npm install 后重试。"'
  exit 1
fi

mkdir -p "\$HOME/Library/Logs" 2>/dev/null || true
: > "\$LOG" 2>/dev/null || LOG=/dev/null

cd "\$PROJECT" || exit 1
exec "\$ELECTRON" "\$PROJECT" >> "\$LOG" 2>&1
LAUNCH

chmod +x "$BUNDLE/Contents/MacOS/launch"

/usr/bin/touch "$BUNDLE"
/usr/bin/xattr -cr "$BUNDLE" 2>/dev/null || true

echo "桌面快捷方式已生成：$BUNDLE"
echo "直接双击即可启动；如果图标没刷新，执行 killall Finder 即可。"
