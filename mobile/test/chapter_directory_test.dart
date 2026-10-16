import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter_directory.dart';
import 'package:comic_reader/services/chapter_source.dart';
import 'package:comic_reader/services/chapter_repository.dart';
import 'package:comic_reader/services/image_cache.dart';

const url = 'https://www.twmanga.com/comic/chapter/demo/0_1.html';

class DirectorySource extends ChapterSource {
  int calls = 0;
  bool failing = false;
  @override
  Future<List<ChapterEntry>> loadDirectory(String pageUrl) async {
    calls++;
    if (failing) throw const HttpException('offline');
    return parseDirectory(
      File('../test/fixtures/directory-sample.html').readAsStringSync(),
      pageUrl,
    );
  }
}

void main() {
  test('两端共用目录固件，链接去重、实体解码、分卷排序与过滤一致', () {
    final entries = parseDirectory(
      File('../test/fixtures/directory-sample.html').readAsStringSync(),
      url,
      baseUrl: 'https://cn.bzmgcn.com/comic/demo',
    );
    expect(entries.map((entry) => entry.title), [
      '第 1 话',
      '第 2 话',
      '第 3 话 & 重逢',
      '番外 1',
    ]);
    expect(entries[1].pageUrl, url);
    expect(
      () => directoryUrlFor('https://evil.example/comic/chapter/demo/0_1.html'),
      throwsFormatException,
    );
  });
  test('实际 dzmanga 分段网址能打开主章节目录', () {
    const partial = 'https://cn.dzmanga.com/comic/chapter/demo/0_1_3.html';
    expect(directoryUrlFor(partial), 'https://www.baozimh.com/comic/demo');
    final entries = parseDirectory(
      File('../test/fixtures/directory-sample.html').readAsStringSync(),
      partial,
    );
    expect(
      entries[1].pageUrl,
      'https://cn.dzmanga.com/comic/chapter/demo/0_1.html',
    );
  });
  test('目录请求合并、重启离线恢复，刷新失败不删除原目录', () async {
    final dir = await Directory.systemTemp.createTemp('comic-directory-');
    final source = DirectorySource();
    addTearDown(() async {
      source.dispose();
      await dir.delete(recursive: true);
    });
    final cache = ImageCacheService(
      Directory('${dir.path}/images'),
      source.image,
    );
    final repository = ChapterRepository(
      source,
      Directory('${dir.path}/chapters'),
      cache,
    );
    await Future.wait([
      repository.loadDirectory(url),
      repository.loadDirectory(url),
    ]);
    expect(source.calls, 1);
    source.failing = true;
    final reopened = ChapterRepository(source, repository.directory, cache);
    expect((await reopened.loadDirectory(url)).length, 4);
    expect(source.calls, 1);
    await expectLater(
      reopened.loadDirectory(url, refresh: true),
      throwsA(isA<HttpException>()),
    );
    expect((await reopened.loadDirectory(url)).length, 4);
  });
}
