import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/services/chapter_source.dart';
import 'package:comic_reader/services/chapter_repository.dart';
import 'package:comic_reader/services/image_cache.dart';

class TestSource extends ChapterSource {
  int requests = 0;
  bool failing = false;
  @override
  Future<Chapter> loadChapter(
    String url, {
    void Function(String)? onPhase,
  }) async {
    requests++;
    if (failing) throw const HttpException('断网');
    return Chapter(
      pageUrl: url,
      comicName: '漫画',
      chapterName: '章节',
      prevUrl: '',
      nextUrl: '',
      images: [ComicImage('https://cdn.example/1.jpg', 800, 1000, '')],
    );
  }
}

void main() {
  test('章节请求完成后释放任务，不自等待；重新启动可离线读缓存', () async {
    final dir = await Directory.systemTemp.createTemp('comic-chapters-');
    addTearDown(() => dir.delete(recursive: true));
    final source = TestSource();
    addTearDown(source.dispose);
    final cache = ImageCacheService(
      Directory('${dir.path}/images'),
      source.image,
    );
    final repository = ChapterRepository(
      source,
      Directory('${dir.path}/chapters'),
      cache,
    );
    const url = 'https://www.twmanga.com/comic/chapter/demo/0_6.html';
    final chapters = await Future.wait([
      repository.load(url),
      repository.load(url),
    ]).timeout(const Duration(seconds: 2));
    expect(chapters.first.images.length, 1);
    expect(source.requests, 1);
    source.failing = true;
    final reopened = ChapterRepository(source, repository.directory, cache);
    expect((await reopened.load(url)).images.length, 1);
    expect(source.requests, 1);
  });
  test('解析失败正常返回错误、下一次可重试', () async {
    final dir = await Directory.systemTemp.createTemp('comic-chapter-fail-');
    addTearDown(() => dir.delete(recursive: true));
    final source = TestSource()..failing = true;
    addTearDown(source.dispose);
    final repository = ChapterRepository(
      source,
      dir,
      ImageCacheService(Directory('${dir.path}/images'), source.image),
    );
    const url = 'https://example.com/chapter';
    await expectLater(
      repository.load(url).timeout(const Duration(seconds: 2)),
      throwsA(isA<HttpException>()),
    );
    source.failing = false;
    expect(
      (await repository.load(url).timeout(const Duration(seconds: 2)))
          .images
          .length,
      1,
    );
  });
}
