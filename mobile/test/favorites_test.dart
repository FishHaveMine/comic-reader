import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/models/chapter.dart';
import 'package:comic_reader/models/favorite.dart';
import 'package:comic_reader/services/progress_repository.dart';

const chapter = Chapter(
  pageUrl: 'https://www.twmanga.com/comic/chapter/demo/0_6.html',
  comicName: '测试漫画',
  chapterName: '第七话',
  prevUrl: '',
  nextUrl: '',
  images: [],
);
Favorite favorite(int time, String device, bool removed) => Favorite(
  bookId: 'https://www.twmanga.com/comic/chapter/demo',
  pageUrl: chapter.pageUrl,
  comicName: chapter.comicName,
  chapterName: chapter.chapterName,
  updatedAt: time,
  deviceId: device,
  removed: removed,
);
void main() {
  test('收藏去重、取消收藏与重启持久化，不影响阅读时间', () async {
    final dir = await Directory.systemTemp.createTemp('comic-favorites-');
    addTearDown(() => dir.delete(recursive: true));
    final repository = ProgressRepository(dir);
    await repository.init();
    await repository.save(chapter, 3, 0.4);
    final readingTime = repository.latest!.updatedAt;
    await repository.setFavorite(chapter, false);
    await repository.setFavorite(chapter, false);
    expect(repository.activeFavorites.length, 1);
    expect(repository.latest!.updatedAt, readingTime);
    final reopened = ProgressRepository(dir);
    await reopened.init();
    expect(reopened.isFavorite(chapter.pageUrl), isTrue);
    await reopened.removeFavorite(reopened.activeFavorites.single);
    expect(reopened.activeFavorites, isEmpty);
    expect(reopened.favorites.single.removed, isTrue);
  });
  test('离线旧收藏不能覆盖取消收藏，之后仍可重新收藏', () async {
    final dir = await Directory.systemTemp.createTemp('comic-fav-sync-');
    addTearDown(() => dir.delete(recursive: true));
    final repository = ProgressRepository(dir);
    await repository.init();
    final old = favorite(10, 'desktop-1', false);
    await repository.merge([], incomingFavorites: [old]);
    await repository.removeFavorite(old);
    await repository.merge([], incomingFavorites: [old]);
    expect(repository.activeFavorites, isEmpty);
    await repository.setFavorite(chapter, false);
    expect(repository.activeFavorites.length, 1);
  });
  test('相同时间冲突两端确定性合并，拒绝无效状态', () {
    final a = favorite(10, 'android-a', false),
        b = favorite(10, 'desktop-z', true);
    expect(
      mergeFavorites([a], [b]).single.toJson(),
      mergeFavorites([b], [a]).single.toJson(),
    );
    expect(
      () => Favorite.fromJson({...a.toJson(), 'removed': 'yes'}),
      throwsFormatException,
    );
  });
  test('旧进度文件迁移不丢设备标识、设置或进度', () async {
    final dir = await Directory.systemTemp.createTemp('comic-fav-migrate-');
    addTearDown(() => dir.delete(recursive: true));
    final repository = ProgressRepository(dir);
    await repository.init();
    await repository.save(chapter, 2, 0.5);
    await repository.setting('autoNext', false);
    final data =
        jsonDecode(await repository.file.readAsString())
            as Map<String, dynamic>;
    data.remove('favorites');
    await repository.file.writeAsString(jsonEncode(data));
    final reopened = ProgressRepository(dir);
    await reopened.init();
    expect(reopened.deviceId, repository.deviceId);
    expect(reopened.latest!.pageIndex, 2);
    expect(reopened.settings['autoNext'], false);
    expect(reopened.favorites, isEmpty);
  });
}
