import 'package:html/parser.dart' as html;
import 'catalog_navigation.dart';

String comicIdFor(String pageUrl) {
  if (!isCatalogUrl(pageUrl)) throw const FormatException('此网址不支持章节目录');
  final match = RegExp(
    r'^/comic/chapter/([a-zA-Z0-9_-]+)/\d+_\d+(?:_\d+)?\.html$',
  ).firstMatch(Uri.parse(pageUrl).path);
  if (match == null) throw const FormatException('请先打开漫画章节');
  return match.group(1)!;
}

String directoryUrlFor(String pageUrl) =>
    'https://www.baozimh.com/comic/${comicIdFor(pageUrl)}';

class ChapterEntry {
  final String pageUrl;
  final String title;
  final int section;
  final int index;
  const ChapterEntry(this.pageUrl, this.title, this.section, this.index);
  Map<String, dynamic> toJson() => {
    'pageUrl': pageUrl,
    'title': title,
    'section': section,
    'index': index,
  };
  factory ChapterEntry.fromJson(Map<String, dynamic> json) => ChapterEntry(
    json['pageUrl'],
    json['title'],
    json['section'],
    json['index'],
  );
}

List<ChapterEntry> parseDirectory(
  String content,
  String pageUrl, {
  String? baseUrl,
}) {
  final id = comicIdFor(pageUrl), origin = Uri.parse(pageUrl).origin;
  final base = Uri.parse(baseUrl ?? directoryUrlFor(pageUrl));
  final doc = html.parse(content);
  final found = <String, ChapterEntry>{};
  for (final anchor in doc.querySelectorAll('a[href]')) {
    final raw = base.resolve(anchor.attributes['href']!).toString();
    final url = chapterFromCatalog(raw);
    if (url == null) continue;
    final path = Uri.parse(url).path;
    final parts = RegExp(
      r'^/comic/chapter/([^/]+)/(\d+)_(\d+)(?:_\d+)?\.html$',
    ).firstMatch(path);
    if (parts == null || parts.group(1) != id) continue;
    final title = anchor.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    found.putIfAbsent(
      path,
      () => ChapterEntry(
        '$origin$path',
        title.isEmpty ? '第 ${int.parse(parts.group(3)!) + 1} 话' : title,
        int.parse(parts.group(2)!),
        int.parse(parts.group(3)!),
      ),
    );
  }
  return found.values.toList()..sort((a, b) {
    final section = a.section.compareTo(b.section);
    return section == 0 ? a.index.compareTo(b.index) : section;
  });
}
