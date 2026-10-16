import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/main.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/services/adb_sync_client.dart';
import 'package:comic_reader/services/chapter_repository.dart';
import 'package:comic_reader/services/chapter_source.dart';
import 'package:comic_reader/services/image_cache.dart';
import 'package:comic_reader/services/progress_repository.dart';

class OfflineSource extends ChapterSource {
  @override
  Future<Chapter> loadChapter(
    String url, {
    void Function(String)? onPhase,
  }) async {
    throw const HttpException('模拟网络故障');
  }
}

class OfflineSync extends AdbSyncClient {
  OfflineSync(super.progress);
  @override
  Future<void> start() async {}
}

class OfflineChapters extends ChapterRepository {
  OfflineChapters(super.source, super.directory, super.cache);
  @override
  Future<Chapter> load(String url, {void Function(String)? onPhase}) async =>
      throw const HttpException('模拟网络故障');
}

void main() {
  testWidgets('离线时显示错误和重试，窄屏操作无溢出', (tester) async {
    final directory = Directory.systemTemp.createTempSync('comic-widget-');
    final progress = ProgressRepository(directory)..deviceId = 'android-test';
    final source = OfflineSource();
    final chapters = OfflineChapters(
      source,
      Directory('${directory.path}/chapters'),
      ImageCacheService(Directory('${directory.path}/images'), source.image),
    );
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      directory.deleteSync(recursive: true);
    });
    await tester.pumpWidget(
      ReaderApp(
        progress: progress,
        chapters: chapters,
        sync: OfflineSync(progress),
      ),
    );
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(find.text('重试'), findsOneWidget);
    expect(find.textContaining('模拟网络故障'), findsOneWidget);
    await tester.tap(find.byTooltip('输入章节网址'));
    await tester.pump();
    expect(find.byTooltip('打开章节'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
