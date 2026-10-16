import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/models/reading_progress.dart';
import 'package:comic_reader/services/progress_repository.dart';
import 'package:comic_reader/services/adb_sync_client.dart';

const chapter = Chapter(
  pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
  comicName: '漫画',
  chapterName: '章节',
  prevUrl: '',
  nextUrl: '',
  images: [],
);
void main() {
  test('同步期间继续阅读，旧响应不会覆盖，并立即补发最新进度到桌面', () async {
    final dir = await Directory.systemTemp.createTemp('comic-sync-client-');
    final progress = ProgressRepository(dir);
    await progress.init();
    await progress.save(chapter, 1, 0.2);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    progress.settings['syncToken'] = 'a' * 64;
    progress.settings['syncPort'] = server.port;
    final client = AdbSyncClient(progress);
    final received = Completer<void>();
    final release = Completer<void>();
    var desktop = <ReadingProgress>[];
    var requests = 0;
    final listener = server.listen((request) async {
      expect(request.headers.value('x-comic-sync-trigger'), 'manual');
      final payload =
          jsonDecode(await utf8.decoder.bind(request).join())
              as Map<String, dynamic>;
      desktop = mergeProgress(
        desktop,
        (payload['records'] as List)
            .map(
              (json) =>
                  ReadingProgress.fromJson(Map<String, dynamic>.from(json)),
            )
            .toList(),
      );
      requests++;
      if (requests == 1) {
        received.complete();
        await release.future;
      }
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'version': 1,
          'records': desktop.map((record) => record.toJson()).toList(),
          'favorites': [],
        }),
      );
      await request.response.close();
    });
    addTearDown(() async {
      client.dispose();
      await listener.cancel();
      await server.close(force: true);
      await dir.delete(recursive: true);
    });
    final syncing = client.sync();
    await received.future.timeout(const Duration(seconds: 3));
    await progress.save(chapter, 6, 0.8);
    final actualTime = progress.latest!.updatedAt;
    expect(identical(client.sync(), syncing), true);
    release.complete();
    await syncing.timeout(const Duration(seconds: 3));
    expect(requests, 2);
    expect(progress.latest!.pageIndex, 6);
    expect(desktop.single.pageIndex, 6);
    expect(progress.latest!.updatedAt, actualTime);
    expect(desktop.single.updatedAt, actualTime);
  });

  test('桌面较新的回看进度覆盖手机较大页码，再同步不更新时间', () async {
    final dir = await Directory.systemTemp.createTemp('comic-sync-newest-');
    final progress = ProgressRepository(dir);
    await progress.init();
    await progress.save(chapter, 9, 0.9);
    final remote = ReadingProgress.fromJson({
      ...progress.latest!.toJson(),
      'deviceId': 'desktop-test',
      'updatedAt': progress.latest!.updatedAt + 10000,
      'pageIndex': 1,
      'pageOffset': 0.1,
    });
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    progress.settings['syncToken'] = 'a' * 64;
    progress.settings['syncPort'] = server.port;
    final client = AdbSyncClient(progress);
    var requests = 0;
    final listener = server.listen((request) async {
      expect(request.headers.value('x-comic-sync-trigger'), 'manual');
      await request.drain<void>();
      requests++;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'version': 1,
          'records': [remote.toJson()],
          'favorites': [],
        }),
      );
      await request.response.close();
    });
    addTearDown(() async {
      client.dispose();
      await listener.cancel();
      await server.close(force: true);
      await dir.delete(recursive: true);
    });
    await client.sync();
    await client.sync();
    expect(requests, 2);
    expect(progress.latest!.toJson(), remote.toJson());
    final reopened = ProgressRepository(dir);
    await reopened.init();
    expect(reopened.latest!.toJson(), remote.toJson());
  });
}
