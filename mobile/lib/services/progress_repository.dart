import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import '../models/chapter.dart';
import '../models/reading_progress.dart';
import '../models/favorite.dart';

class ProgressRepository extends ChangeNotifier {
  final Directory directory;
  String deviceId = '';
  List<ReadingProgress> records = [];
  List<Favorite> favorites = [];
  final favoritesRevision = ValueNotifier<int>(0);
  List<Favorite> get activeFavorites =>
      favorites.where((favorite) => !favorite.removed).toList();
  bool isFavorite(String pageUrl) =>
      activeFavorites.any((favorite) => favorite.bookId == bookIdFor(pageUrl));
  Map<String, dynamic> settings = {};
  Future<void> _writing = Future.value();
  ProgressRepository(this.directory);
  ReadingProgress? get latest => records.isEmpty ? null : records.first;
  File get file => File('${directory.path}/reading-progress.json');
  Future<void> init() async {
    await directory.create(recursive: true);
    final random = Random.secure();
    deviceId =
        'android-${List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
    try {
      final data =
          jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      records = mergeProgress(
        [],
        (data['records'] as List)
            .map(
              (json) =>
                  ReadingProgress.fromJson(Map<String, dynamic>.from(json)),
            )
            .toList(),
      );
      favorites = mergeFavorites(
        [],
        (data['favorites'] as List? ?? [])
            .map((json) => Favorite.fromJson(Map<String, dynamic>.from(json)))
            .toList(),
      );
      deviceId = data['deviceId'] as String;
      settings = Map<String, dynamic>.from(data['settings'] ?? {});
    } on FileSystemException {
      /* 首次启动 */
    } on FormatException {
      /* 损坏文件使用空进度 */
    }
  }

  Map<String, dynamic> snapshot() => {
    'version': 1,
    'deviceId': deviceId,
    'records': records.map((record) => record.toJson()).toList(),
    'favorites': favorites.map((favorite) => favorite.toJson()).toList(),
  };
  Future<void> persist() {
    final content = jsonEncode({...snapshot(), 'settings': settings});
    _writing = _writing.catchError((_) {}).then((_) async {
      final temp = File('${file.path}.tmp');
      await temp.writeAsString(content, flush: true);
      await temp.rename(file.path);
    });
    return _writing;
  }

  Future<void> save(
    Chapter chapter,
    int index,
    double offset, {
    int? observedAt,
  }) async {
    final record = ReadingProgress(
      bookId: bookIdFor(chapter.pageUrl),
      pageUrl: chapter.pageUrl,
      comicName: chapter.comicName,
      chapterName: chapter.chapterName,
      pageIndex: index,
      pageOffset: offset.clamp(0, 1),
      updatedAt:
          observedAt ??
          max(
            DateTime.now().millisecondsSinceEpoch,
            max(
              (latest?.updatedAt ?? 0) + 1,
              (favorites.firstOrNull?.updatedAt ?? 0) + 1,
            ),
          ),
      deviceId: deviceId,
    );
    final existing = records
        .where((item) => item.bookId == record.bookId)
        .firstOrNull;
    if (existing?.pageUrl == record.pageUrl &&
        existing?.pageIndex == record.pageIndex &&
        existing?.pageOffset == record.pageOffset) {
      return;
    }
    await merge([record]);
  }

  Future<bool> merge(
    List<ReadingProgress> incoming, {
    List<Favorite> incomingFavorites = const [],
  }) async {
    final next = mergeProgress(records, incoming);
    final nextFavorites = mergeFavorites(favorites, incomingFavorites);
    final progressChanged =
        jsonEncode(next.map((e) => e.toJson()).toList()) !=
        jsonEncode(records.map((e) => e.toJson()).toList());
    final favoritesChanged =
        jsonEncode(nextFavorites.map((e) => e.toJson()).toList()) !=
        jsonEncode(favorites.map((e) => e.toJson()).toList());
    if (!progressChanged && !favoritesChanged) return false;
    records = next;
    favorites = nextFavorites;
    await persist();
    if (progressChanged) notifyListeners();
    if (favoritesChanged) favoritesRevision.value++;
    return true;
  }

  Future<void> setFavorite(Chapter chapter, bool removed) async {
    final favorite = Favorite(
      bookId: bookIdFor(chapter.pageUrl),
      pageUrl: chapter.pageUrl,
      comicName: chapter.comicName,
      chapterName: chapter.chapterName,
      removed: removed,
      deviceId: deviceId,
      updatedAt: max(
        DateTime.now().millisecondsSinceEpoch,
        max(
          (latest?.updatedAt ?? 0) + 1,
          (favorites.firstOrNull?.updatedAt ?? 0) + 1,
        ),
      ),
    );
    await merge([], incomingFavorites: [favorite]);
  }

  Future<void> removeFavorite(Favorite favorite) => setFavorite(
    Chapter(
      pageUrl: favorite.pageUrl,
      comicName: favorite.comicName,
      chapterName: favorite.chapterName,
      prevUrl: '',
      nextUrl: '',
      images: [],
    ),
    true,
  );

  Future<void> setting(String key, dynamic value) async {
    settings[key] = value;
    await persist();
  }
}
