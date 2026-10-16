String bookIdFor(String pageUrl) {
  final url = Uri.parse(pageUrl);
  if (!['http', 'https'].contains(url.scheme) ||
      url.host.isEmpty ||
      url.userInfo.isNotEmpty) {
    throw const FormatException('进度中的章节网址无效');
  }
  final match = RegExp(r'^/comic/chapter/([^/]+)/').firstMatch(url.path);
  return '${url.origin}${match == null ? url.path : '/comic/chapter/${match.group(1)}'}';
}

class ReadingProgress {
  final String bookId;
  final String pageUrl;
  final String comicName;
  final String chapterName;
  final int pageIndex;
  final double pageOffset;
  final int updatedAt;
  final String deviceId;
  const ReadingProgress({
    required this.bookId,
    required this.pageUrl,
    required this.comicName,
    required this.chapterName,
    required this.pageIndex,
    required this.pageOffset,
    required this.updatedAt,
    required this.deviceId,
  });

  factory ReadingProgress.fromJson(Map<String, dynamic> json) {
    final record = ReadingProgress(
      bookId: json['bookId'] as String,
      pageUrl: json['pageUrl'] as String,
      comicName: json['comicName'] as String? ?? '',
      chapterName: json['chapterName'] as String? ?? '',
      pageIndex: json['pageIndex'] as int,
      pageOffset: (json['pageOffset'] as num).toDouble(),
      updatedAt: json['updatedAt'] as int,
      deviceId: json['deviceId'] as String,
    );
    if (record.bookId != bookIdFor(record.pageUrl) ||
        record.pageIndex < 0 ||
        record.pageIndex > 100000 ||
        !record.pageOffset.isFinite ||
        record.pageOffset < 0 ||
        record.pageOffset > 1 ||
        record.updatedAt <= 0 ||
        record.updatedAt > 9007199254740991 ||
        record.deviceId.isEmpty ||
        record.deviceId.length > 128 ||
        [
          record.bookId,
          record.pageUrl,
          record.comicName,
          record.chapterName,
        ].any((s) => s.length > 4096)) {
      throw const FormatException('阅读进度字段无效');
    }
    return record;
  }

  Map<String, dynamic> toJson() => {
    'bookId': bookId,
    'pageUrl': pageUrl,
    'comicName': comicName,
    'chapterName': chapterName,
    'pageIndex': pageIndex,
    'pageOffset': pageOffset,
    'updatedAt': updatedAt,
    'deviceId': deviceId,
  };

  int compareTo(ReadingProgress other) {
    final time = updatedAt.compareTo(other.updatedAt);
    if (time != 0) return time;
    final device = deviceId.compareTo(other.deviceId);
    if (device != 0) return device;
    final url = pageUrl.compareTo(other.pageUrl);
    if (url != 0) return url;
    final index = pageIndex.compareTo(other.pageIndex);
    if (index != 0) return index;
    final offset = pageOffset.compareTo(other.pageOffset);
    if (offset != 0) return offset;
    final comic = comicName.compareTo(other.comicName);
    return comic != 0 ? comic : chapterName.compareTo(other.chapterName);
  }
}

List<ReadingProgress> mergeProgress(
  List<ReadingProgress> local,
  List<ReadingProgress> incoming,
) {
  final result = <String, ReadingProgress>{};
  for (final record in [...local, ...incoming]) {
    final old = result[record.bookId];
    if (old == null || record.compareTo(old) > 0) {
      result[record.bookId] = record;
    }
  }
  return result.values.toList()..sort((a, b) => b.compareTo(a));
}
