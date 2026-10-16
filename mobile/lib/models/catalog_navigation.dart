const catalogHomeUrl =
    'https://www.baozimh.com/classify?type=all&region=all&state=all&filter=%2a';
bool isCatalogUrl(String raw) {
  final url = Uri.tryParse(raw);
  return url != null &&
      ['http', 'https'].contains(url.scheme) &&
      url.userInfo.isEmpty &&
      [
        'baozimh.com',
        'bzmgcn.com',
        'twmanga.com',
        'dzmanga.com',
      ].any((host) => url.host == host || url.host.endsWith('.$host'));
}

String? chapterFromCatalog(String raw) {
  if (!isCatalogUrl(raw)) return null;
  final url = Uri.parse(raw);
  if (RegExp(
    r'^/comic/chapter/[^/]+/\d+_\d+(?:_\d+)?\.html$',
  ).hasMatch(url.path)) {
    return url.removeFragment().toString();
  }
  if (url.path != '/user/page_direct') return null;
  final comic = url.queryParameters['comic_id'] ?? '';
  final section = url.queryParameters['section_slot'] ?? '';
  final chapter = url.queryParameters['chapter_slot'] ?? '';
  if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(comic) ||
      !RegExp(r'^\d+$').hasMatch(section) ||
      !RegExp(r'^\d+$').hasMatch(chapter)) {
    return null;
  }
  return 'https://www.twmanga.com/comic/chapter/$comic/${section}_$chapter.html';
}
