import 'dart:io';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/main.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/models/chapter_directory.dart';
import 'package:comic_reader/models/reading_progress.dart';
import 'package:comic_reader/services/adb_sync_client.dart';
import 'package:comic_reader/services/chapter_repository.dart';
import 'package:comic_reader/services/chapter_source.dart';
import 'package:comic_reader/services/image_cache.dart';
import 'package:comic_reader/services/progress_repository.dart';

const url = 'https://www.twmanga.com/comic/chapter/demo/0_6.html';

class MockSync extends AdbSyncClient {
  MockSync(super.progress);
  @override
  Future<void> start() async {}
  int requests = 0;
  @override
  Future<void> sync() async {
    requests++;
  }
}

class DelayedSync extends MockSync {
  final pending = Completer<void>();
  DelayedSync(super.progress);
  @override
  Future<void> start() => pending.future;
}

class MockImages extends ImageCacheService {
  MockImages(super.directory, super.download);
  @override
  Future<File> ensure(String url, {bool urgent = false}) =>
      Future.error(const HttpException('模拟未加载图片'));
}

class MockChapters extends ChapterRepository {
  MockChapters(super.source, super.directory, super.cache);
  bool continuous = false;
  final loads = <String>[];
  @override
  Future<Chapter> load(String url, {void Function(String)? onPhase}) async {
    loads.add(url);
    return Chapter(
      pageUrl: url,
      comicName: '测试漫画',
      chapterName: '第七话',
      prevUrl: '',
      nextUrl: continuous && !url.endsWith('next.html')
          ? '${url.substring(0, url.lastIndexOf('/') + 1)}next.html'
          : '',
      images: List.generate(
        6,
        (i) => ComicImage('https://cdn/$i.jpg', 800, 1000, ''),
      ),
    );
  }

  @override
  Future<List<ChapterEntry>> loadDirectory(
    String pageUrl, {
    bool refresh = false,
  }) async => [
    ChapterEntry(
      pageUrl.replaceFirstMapped(
        RegExp(r'(\d+_\d+)(?:_\d+)?\.html$'),
        (match) => '${match[1]}.html',
      ),
      '第 7 话 当前章',
      0,
      6,
    ),
    ChapterEntry(
      pageUrl.replaceFirst(RegExp(r'\d+_\d+(?:_\d+)?\.html$'), '0_9.html'),
      '第 9 话 跳转测试',
      0,
      9,
    ),
  ];
  @override
  Future<void> prefetch(
    Chapter current,
    void Function(String) onProgress, {
    List<Chapter> retained = const [],
  }) async {}
}

void main() {
  Future<ProgressRepository> setup(
    WidgetTester tester, {
    bool continuous = false,
    bool delayedSync = false,
    String? initialUrl,
  }) async {
    final dir = Directory.systemTemp.createTempSync('comic-controls-');
    final repository = ProgressRepository(dir)..deviceId = 'android-test';
    if (delayedSync) repository.settings['lastUrl'] = url;
    if (initialUrl != null) repository.settings['lastUrl'] = initialUrl;
    final source = ChapterSource();
    final chapters = MockChapters(
      source,
      dir,
      MockImages(Directory('${dir.path}/images'), source.image),
    )..continuous = continuous;
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      dir.deleteSync(recursive: true);
    });
    await tester.pumpWidget(
      ReaderApp(
        progress: repository,
        chapters: chapters,
        sync: delayedSync ? DelayedSync(repository) : MockSync(repository),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    return repository;
  }

  double opacity(WidgetTester tester) => tester
      .widget<AnimatedOpacity>(
        find.byKey(const ValueKey('reader-top-controls')),
      )
      .opacity;
  testWidgets('章节中段追加无倒计时或跳顶，跨章保存相对页码', (tester) async {
    final progress = await setup(tester, continuous: true);
    var list = tester.widget<ListView>(find.byType(ListView));
    expect(list.childrenDelegate.estimatedChildCount, 6);
    await tester.drag(find.byType(ListView), const Offset(0, -100));
    await tester.pump();
    list.controller!.jumpTo(700);
    await tester.pump();
    await tester.pump();
    list = tester.widget<ListView>(find.byType(ListView));
    expect(list.childrenDelegate.estimatedChildCount, 12);
    expect(list.controller!.offset, 700);
    expect(find.textContaining('秒后进入下一话'), findsNothing);
    list.controller!.jumpTo(12 + 7 * 456 + 100);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    expect(progress.latest!.pageUrl.endsWith('next.html'), true);
    expect(progress.latest!.pageIndex, 1);
    expect(
      tester
          .widget<ListView>(find.byType(ListView))
          .childrenDelegate
          .estimatedChildCount,
      12,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });

  testWidgets('收到桌面新进度后，延迟保存和切后台不会反写旧页面', (tester) async {
    final progress = await setup(tester);
    final app = tester.widget<ReaderApp>(find.byType(ReaderApp));
    final currentUrl = (app.chapters as MockChapters).loads.first;
    await tester.drag(find.byType(ListView), const Offset(0, -100));
    await tester.pump();
    final remote = ReadingProgress(
      bookId: bookIdFor(currentUrl),
      pageUrl: currentUrl,
      comicName: '测试漫画',
      chapterName: '桌面最新位置',
      pageIndex: 4,
      pageOffset: 0.4,
      updatedAt: DateTime.now().millisecondsSinceEpoch + 10000,
      deviceId: 'desktop-test',
    );
    unawaited(progress.merge([remote]));
    await tester.pump(const Duration(milliseconds: 600));
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    expect(progress.latest!.toJson(), remote.toJson());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    expect(progress.latest!.toJson(), remote.toJson());
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });

  testWidgets('章节目录标记当前章、搜索、排序、选章后恢复阅读', (tester) async {
    await setup(
      tester,
      initialUrl: 'https://cn.dzmanga.com/comic/chapter/demo/0_6_3.html',
    );
    await tester.tap(find.textContaining('页 · 目录'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
    expect(find.text('正在阅读'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    expect(opacity(tester), 1);
    await tester.tap(find.text('倒序'));
    await tester.pump();
    final titles = tester.widgetList<ListTile>(find.byType(ListTile)).toList();
    expect((titles.first.title as Text).data, '第 9 话 跳转测试');
    await tester.enterText(find.byType(TextField), '第 9');
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.getBottomRight(find.byTooltip('关闭章节目录')).dy, lessThan(500));
    expect(find.byType(ListTile), findsOneWidget);
    await tester.tap(find.text('第 9 话 跳转测试'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    final app = tester.widget<ReaderApp>(find.byType(ReaderApp));
    expect((app.chapters as MockChapters).loads.last, endsWith('0_9.html'));
    await tester.pumpAndSettle();
    expect(find.text('章节目录'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });
  testWidgets('ADB 尚未完成时直接恢复本地最后打开章节', (tester) async {
    await setup(tester, delayedSync: true);
    final app = tester.widget<ReaderApp>(find.byType(ReaderApp));
    final chapters = app.chapters as MockChapters;
    expect(chapters.loads, [url]);
    expect(find.byType(ListView), findsOneWidget);
    expect((app.sync as DelayedSync).pending.isCompleted, false);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });

  testWidgets('三秒自动收起，轻触唤出，滚动收起，正文尺寸与位置不变', (tester) async {
    await setup(tester);
    expect(opacity(tester), 1);
    final list = tester.widget<ListView>(find.byType(ListView));
    final size = tester.getSize(find.byType(ListView));
    final offset = list.controller!.offset;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 200));
    expect(opacity(tester), 0);
    expect(tester.getSize(find.byType(ListView)), size);
    expect(list.controller!.offset, offset);
    await tester.tapAt(const Offset(40, 400));
    await tester.pump(const Duration(milliseconds: 200));
    expect(opacity(tester), 1);
    await tester.drag(find.byType(ListView), const Offset(0, -250));
    await tester.pump(const Duration(milliseconds: 200));
    expect(opacity(tester), 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });
  testWidgets('输入网址、收藏列表打开时不自动隐藏；收藏添加取消可继续阅读', (tester) async {
    final progress = await setup(tester);
    await tester.tap(find.byTooltip('输入章节网址'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 4));
    expect(opacity(tester), 1);
    expect(find.byTooltip('打开章节'), findsOneWidget);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byTooltip('收藏漫画'));
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    expect(progress.activeFavorites.length, 1);
    await tester.tap(find.byTooltip('我的收藏'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(seconds: 4));
    expect(opacity(tester), 1);
    expect(find.text('我的收藏 · 1'), findsOneWidget);
    await tester.tap(find.widgetWithText(ListTile, '测试漫画'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('我的收藏 · 1'), findsNothing);
    await tester.tap(find.byTooltip('取消收藏'));
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    expect(progress.activeFavorites, isEmpty);
    final app = tester.widget<ReaderApp>(find.byType(ReaderApp));
    expect((app.sync as MockSync).requests, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
  });
}
