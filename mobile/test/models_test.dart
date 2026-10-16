import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/models/reading_progress.dart';

Map<String, dynamic> record(int timestamp, String device, int index) => {
  'bookId': 'https://www.twmanga.com/comic/chapter/demo',
  'pageUrl': 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
  'comicName': '漫画',
  'chapterName': '第七话',
  'pageIndex': index,
  'pageOffset': 0.4,
  'updatedAt': timestamp,
  'deviceId': device,
};
void main() {
  test('复用 Electron 固件，正片顺序、去重、导航一致', () {
    final content = File(
      '../test/fixtures/chapter-sample.html',
    ).readAsStringSync();
    final chapter = parseChapter(
      content,
      'https://www.twmanga.com/comic/chapter/demo/0_6.html',
    );
    expect(chapter.images.length, 6);
    expect(
      chapter.images.map((image) => Uri.parse(image.url).pathSegments.last),
      ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg'],
    );
    expect(chapter.comicName, '萬界守門人');
    expect(chapter.chapterName, '7 坑爹呢這是！');
    expect(chapter.nextUrl, endsWith('0_7.html'));
  });
  test('数字页码含查询参数仍正确排序，绑定 src 不误匹配', () {
    final chapter = parseChapter(
      '<amp-img id="chapter-img-0-0" [src]="binding" src="/3.jpg?v=1"></amp-img><amp-img id="chapter-img-0-1" src="/1.jpg"></amp-img>',
      'https://example.com/chapter',
    );
    expect(chapter.images.first.url, 'https://example.com/1.jpg');
  });
  test('无效协议、空网址拒绝', () {
    expect(normalizeUrl(' www.twmanga.com/a '), 'https://www.twmanga.com/a');
    expect(() => normalizeUrl('javascript:alert(1)'), throwsFormatException);
    expect(() => normalizeUrl(''), throwsFormatException);
  });
  test('两个章节的 bookId 与 Electron 一致', () {
    expect(
      bookIdFor('https://www.twmanga.com/comic/chapter/demo/0_7.html'),
      record(10, 'desktop-1', 1)['bookId'],
    );
  });
  test('双向合并以最后阅读时间优先并且幂等', () {
    final local = ReadingProgress.fromJson(record(10, 'desktop-1', 1));
    final remote = ReadingProgress.fromJson(record(20, 'android-1', 5));
    expect(mergeProgress([local], [remote]).single.pageIndex, 5);
    expect(mergeProgress([remote], [local, remote]).single.pageIndex, 5);
  });
  test('相同时间的冲突在两端收敛到同一设备', () {
    final a = ReadingProgress.fromJson(record(20, 'android-a', 2));
    final b = ReadingProgress.fromJson(record(20, 'desktop-z', 1));
    expect(
      mergeProgress([a], [b]).single.toJson(),
      mergeProgress([b], [a]).single.toJson(),
    );
  });
  test('较新回看优先，同设备同时间冲突也双向收敛', () {
    final older = ReadingProgress.fromJson({
      ...record(10, 'android-test', 99),
      'pageUrl': 'https://www.twmanga.com/comic/chapter/demo/0_9.html',
    });
    final newer = ReadingProgress.fromJson(record(20, 'desktop-test', 0));
    expect(mergeProgress([older], [newer]).single.toJson(), newer.toJson());
    expect(mergeProgress([newer], [older]).single.toJson(), newer.toJson());
    expect(mergeProgress([newer, older], []).single.toJson(), newer.toJson());
    final a = ReadingProgress.fromJson(record(20, 'desktop-test', 1));
    final b = ReadingProgress.fromJson(record(20, 'desktop-test', 4));
    expect(
      mergeProgress([a], [b]).single.toJson(),
      mergeProgress([b], [a]).single.toJson(),
    );
  });
  test('拒绝超范围页码、页内偏移与伪造书籍标识', () {
    expect(
      () => ReadingProgress.fromJson({
        ...record(20, 'android-1', 1),
        'pageOffset': 1.1,
      }),
      throwsFormatException,
    );
    expect(
      () => ReadingProgress.fromJson(record(20, 'android-1', -1)),
      throwsFormatException,
    );
    expect(
      () => ReadingProgress.fromJson({
        ...record(20, 'android-1', 1),
        'bookId': 'fake',
      }),
      throwsFormatException,
    );
  });
}
