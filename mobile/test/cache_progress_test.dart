import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/models/reading_progress.dart';
import 'package:comic_reader/services/image_cache.dart';
import 'package:comic_reader/services/progress_repository.dart';

void main() {
  test('缓存合并并发请求、已有预取队列中的当前图片可提升优先级', () async {
    final dir = await Directory.systemTemp.createTemp('comic-cache-');
    addTearDown(() => dir.delete(recursive: true));
    final gate = Completer<void>();
    final started = <String>[];
    final occupying = Completer<void>();
    final cache = ImageCacheService(dir, (url) async {
      started.add(url);
      if (url == 'a') {
        occupying.complete();
        await gate.future;
      }
      return Uint8List.fromList([1, 2, 3]);
    }, concurrency: 1);
    final a = cache.ensure('a');
    await occupying.future;
    final b = cache.ensure('b');
    final c = cache.ensure('c');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final urgent = cache.ensure('c', urgent: true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    gate.complete();
    await Future.wait([a, b, c, urgent]);
    expect(started, ['a', 'c', 'b']);
    await cache.ensure('a');
    expect(started.length, 3);
    await cache.prune({'a'}, stillCurrent: () => false);
    expect((await cache.stats()).files, 3);
    await cache.prune({'a'}, stillCurrent: () => true);
    expect((await cache.stats()).files, 1);
  });
  test('失败后释放任务，可再次重试，批量失败正确计数', () async {
    final dir = await Directory.systemTemp.createTemp('comic-fail-');
    addTearDown(() => dir.delete(recursive: true));
    var fail = true;
    final cache = ImageCacheService(dir, (url) async {
      if (fail) throw const HttpException('断网');
      return Uint8List.fromList([1, 2, 3]);
    }, retries: 1);
    expect(await cache.prefetch(['a', 'b'], (_, _, _) {}), 2);
    fail = false;
    expect(await cache.prefetch(['a', 'b'], (_, _, _) {}), 0);
  });
  test('延迟保存不能覆盖远端新进度，相同位置重复保存不刷新时间', () async {
    final dir = await Directory.systemTemp.createTemp('comic-observed-');
    addTearDown(() => dir.delete(recursive: true));
    final repository = ProgressRepository(dir);
    await repository.init();
    const chapter = Chapter(
      pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
      comicName: '漫画',
      chapterName: '章节',
      prevUrl: '',
      nextUrl: '',
      images: [],
    );
    await repository.save(chapter, 1, 0.2, observedAt: 10);
    final remote = ReadingProgress.fromJson({
      ...repository.latest!.toJson(),
      'deviceId': 'desktop-test',
      'updatedAt': 20,
      'pageIndex': 5,
    });
    await repository.merge([remote]);
    await repository.save(chapter, 2, 0.1, observedAt: 15);
    expect(repository.latest!.toJson(), remote.toJson());
    await repository.save(chapter, 5, 0.2);
    expect(repository.latest!.updatedAt, 20);
    await repository.save(chapter, 1, 0.2, observedAt: 30);
    await repository.merge([remote]);
    expect(repository.latest!.pageIndex, 1);
    expect(repository.latest!.updatedAt, 30);
  });
  test('本地进度保存、双向合并、并发写入、重启恢复与单调时钟', () async {
    final dir = await Directory.systemTemp.createTemp('comic-progress-');
    addTearDown(() => dir.delete(recursive: true));
    final repository = ProgressRepository(dir);
    await repository.init();
    final chapter = Chapter(
      pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
      comicName: '漫画',
      chapterName: '第七话',
      prevUrl: '',
      nextUrl: '',
      images: [],
    );
    await Future.wait([
      repository.save(chapter, 1, 0.2),
      repository.save(chapter, 2, 0.5),
    ]);
    final future = DateTime.now().millisecondsSinceEpoch + 10000;
    await repository.merge([
      ReadingProgress.fromJson({
        ...repository.latest!.toJson(),
        'updatedAt': future,
        'deviceId': 'desktop-1',
        'pageIndex': 5,
      }),
    ]);
    expect(repository.latest!.pageIndex, 5);
    await repository.save(chapter, 6, 0.8);
    expect(repository.latest!.updatedAt, greaterThan(future));
    final reopened = ProgressRepository(dir);
    await reopened.init();
    expect(reopened.deviceId, repository.deviceId);
    expect(reopened.latest!.pageIndex, 6);
    expect(reopened.latest!.pageOffset, 0.8);
  });
}
