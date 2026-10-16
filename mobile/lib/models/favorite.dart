import 'reading_progress.dart';

class Favorite {
  final String bookId;
  final String pageUrl;
  final String comicName;
  final String chapterName;
  final int updatedAt;
  final String deviceId;
  final bool removed;
  const Favorite({
    required this.bookId,
    required this.pageUrl,
    required this.comicName,
    required this.chapterName,
    required this.updatedAt,
    required this.deviceId,
    required this.removed,
  });
  factory Favorite.fromJson(Map<String, dynamic> json) {
    final record = ReadingProgress.fromJson({
      ...json,
      'pageIndex': 0,
      'pageOffset': 0,
    });
    if (json['removed'] is! bool) throw const FormatException('收藏状态无效');
    return Favorite(
      bookId: record.bookId,
      pageUrl: record.pageUrl,
      comicName: record.comicName,
      chapterName: record.chapterName,
      updatedAt: record.updatedAt,
      deviceId: record.deviceId,
      removed: json['removed'],
    );
  }
  Map<String, dynamic> toJson() => {
    'bookId': bookId,
    'pageUrl': pageUrl,
    'comicName': comicName,
    'chapterName': chapterName,
    'updatedAt': updatedAt,
    'deviceId': deviceId,
    'removed': removed,
  };
  int compareTo(Favorite other) {
    final time = updatedAt.compareTo(other.updatedAt);
    return time == 0 ? deviceId.compareTo(other.deviceId) : time;
  }
}

List<Favorite> mergeFavorites(List<Favorite> local, List<Favorite> incoming) {
  final map = {for (final favorite in local) favorite.bookId: favorite};
  for (final favorite in incoming) {
    final old = map[favorite.bookId];
    if (old == null || favorite.compareTo(old) > 0) {
      map[favorite.bookId] = favorite;
    }
  }
  return map.values.toList()..sort((a, b) => b.compareTo(a));
}
