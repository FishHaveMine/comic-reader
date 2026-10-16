# Android 漫画阅读器

Flutter 实现，对应桌面 Electron 阅读器。支持章节网址输入、正片解析、懒加载、图片磁盘缓存、六并发下载、失败重试、后两章预取、上一话/下一话、可取消的三秒自动翻章，以及阅读位置保存、漫画收藏。

## 构建与安装

环境：Flutter 3.35.6 / Dart 3.9.2、Android SDK、Android Studio 自带 JDK。Android applicationId 为 `com.comicreader.comic_reader`。

```bash
cd mobile
flutter pub get
flutter analyze
flutter test
flutter build apk --release
cd ..
npm run android:install
```

APK：`mobile/build/app/outputs/flutter-apk/app-release.apk`。当前 release 使用开发签名，可用于本机安装；正式分发时需要配置自己的签名。

构建依赖下载需要可用网络。如 Gradle 的 Google Maven/TLS 请求失败，可通过环境变量临时为 Java 指定本机代理，例如：

```bash
JAVA_TOOL_OPTIONS='-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7890 -Dhttp.nonProxyHosts=localhost|127.*' flutter build apk --release
```

上述代理仅用于构建，不改变阅读器的网络策略。

## 返回首页与搜索

阅读页左侧房屋图标打开指定包子漫画分类页，可使用页面搜索框查找漫画。选择漫画目录中的章节，会自动返回阅读器。首页工具栏支持网页后退、分类首页、刷新和返回阅读；返回时保留原阅读位置。

兼容站点按地区跳转到 `cn.bzmgcn.com`，以及目录中的 `/user/page_direct` 章节入口。首页使用与阅读验证共用 cookie 的 WebView，章节仍走现有解析、缓存与进度流程。

## ADB 双向同步

1. 手机上开启 USB 调试并授权电脑，`adb devices` 应显示 `device`。
2. 安装手机应用，运行桌面端 `npm start`。
3. 桌面自动检测 ADB 设备，仅建立连接和配对，通过 `adb reverse` 建立通道，并向已安装的手机应用发送配对配置。首次配对或设备重连会打开手机阅读器。
4. 只有点击桌面或手机底部同步按钮才交换进度；启动、配对、切回前台和收藏操作不触发同步。断线时继续保存本地进度，重连后再次点击按钮。
5. 两端出现新进度后点击“继续阅读”恢复位置；正在阅读的章节不会被后台同步自动切走。重启后默认恢复最近阅读记录。

同步服务仅监听电脑 `127.0.0.1:48765`，通过 ADB 转发，使用随机配对令牌。无云服务、无需手机与电脑在同一个 Wi-Fi。同步章节网址、漫画/章节名称、当前页、页内比例、时间以及收藏状态，不同步图片或站点 cookie。

多设备各自保留记录，按每本漫画最后阅读时间合并；相同时间按设备标识确定一致结果。本地保存时间保证大于已导入时间，避免时钟轻微差异使新阅读记录无法胜出。

自定义 ADB 路径：`COMIC_ADB=/绝对路径/adb npm start`。多设备安装时使用 `npm run android:install -- --serial <序列号>`。

## 测试

```bash
flutter test                    # 解析、合并、落盘、缓存调度、章节失败重试、界面错误状态
cd ..
npm test                        # 桌面测试，包含 HTTP 同步接口与 ADB 设备调度
npm run test:flows              # Electron 阅读与进度恢复
node scripts/check-adb-sync-device.js # 已安装 debug 包的手机：真实 ADB 手动双向同步与断线后手动同步
```

真机测试前须退出桌面阅读器，避免常规配对监控与测试互相覆盖。测试设备须保持连接以完成数据恢复。真机同步测试使用临时本地章节，不依赖线上站点，结束恢复手机进度文件。调试包构建安装：`flutter build apk --debug`，随后 `node scripts/install-android.js --debug`。

## 说明

阅读页操作栏在滚动时或 3 秒无操作后收起，轻触正文重新显示；隐藏时保留页码。点击链接图标输入网址、点击标题回到顶部。输入网址和浏览收藏期间不自动收起。工具栏覆盖正文，不改变漫画尺寸与已保存位置。

星标可收藏/取消收藏当前漫画，“我的收藏”可继续该漫画最近的阅读位置。收藏与取消收藏通过 ADB 双向合并，保留取消记录避免离线重连时误恢复；收藏不会改变阅读记录的时间。

当前只生成 Android 工程。站点解析规则与桌面保持一致；站点返回 403 时使用隐藏 Android WebView 完成浏览器验证，之后共享 cookie 给直接请求。手机端站点网络和验证状态独立于电脑。历史缓存只保留当前章与后两章，已缓存章节可以离线阅读。

同步仅在应用进程运行时执行；Android 被系统终止后需重新打开应用。不会安装后台常驻服务。

实现参考：[ADB 官方文档](https://developer.android.com/tools/adb)、[Headless WebView](https://inappwebview.dev/docs/webview/headless-in-app-webview/)、[Cookie Manager](https://inappwebview.dev/docs/cookie-manager/)。
