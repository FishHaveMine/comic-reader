import 'package:html/parser.dart' as html;

const defaultChapterUrl =
    'https://www.twmanga.com/comic/chapter/mojieshoumenren-yuewenmanhua/0_6.html';

String normalizeUrl(String input) {
  final raw = input.trim();
  if (raw.isEmpty) throw const FormatException('请输入章节网址');
  final value = RegExp(r'^[a-zA-Z][a-zA-Z\d+.-]*:').hasMatch(raw)
      ? raw
      : 'https://$raw';
  final uri = Uri.parse(value);
  if (!['http', 'https'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty) {
    throw const FormatException('只支持 http / https 章节网址');
  }
  return uri.removeFragment().toString();
}

class ComicImage {
  final String url;
  final double width;
  final double height;
  final String alt;
  const ComicImage(this.url, this.width, this.height, this.alt);
  double get ratio => width > 0 && height > 0 ? width / height : 2 / 3;
  Map<String, dynamic> toJson() => {
    'url': url,
    'width': width,
    'height': height,
    'alt': alt,
  };
  factory ComicImage.fromJson(Map<String, dynamic> json) => ComicImage(
    json['url'] as String,
    (json['width'] as num).toDouble(),
    (json['height'] as num).toDouble(),
    json['alt'] as String,
  );
}

class Chapter {
  final String pageUrl;
  final String comicName;
  final String chapterName;
  final String prevUrl;
  final String nextUrl;
  final List<ComicImage> images;
  const Chapter({
    required this.pageUrl,
    required this.comicName,
    required this.chapterName,
    required this.prevUrl,
    required this.nextUrl,
    required this.images,
  });
  String get title =>
      [comicName, chapterName].where((name) => name.isNotEmpty).join(' · ');
  Map<String, dynamic> toJson() => {
    'pageUrl': pageUrl,
    'comicName': comicName,
    'chapterName': chapterName,
    'prevUrl': prevUrl,
    'nextUrl': nextUrl,
    'images': images.map((image) => image.toJson()).toList(),
  };
  factory Chapter.fromJson(Map<String, dynamic> json) => Chapter(
    pageUrl: json['pageUrl'],
    comicName: json['comicName'],
    chapterName: json['chapterName'],
    prevUrl: json['prevUrl'],
    nextUrl: json['nextUrl'],
    images: (json['images'] as List)
        .map((value) => ComicImage.fromJson(Map<String, dynamic>.from(value)))
        .toList(),
  );
}

Chapter parseChapter(String content, String pageUrl) {
  if (content.trim().isEmpty) throw const FormatException('章节内容为空');
  final doc = html.parse(content);
  final base = Uri.parse(pageUrl);
  String resolve(String? value) {
    if (value == null || value.isEmpty) return '';
    final uri = base.resolve(value);
    return ['http', 'https'].contains(uri.scheme) ? uri.toString() : '';
  }

  final tags = doc.querySelectorAll('amp-img');
  var selected = tags
      .where((tag) => RegExp(r'^chapter-img-\d+-\d+$').hasMatch(tag.id))
      .toList();
  if (selected.isEmpty) {
    selected = tags
        .where((tag) => (tag.attributes['src'] ?? '').contains('/scomic/'))
        .toList();
  }
  final seen = <String>{};
  final images = <ComicImage>[];
  for (final tag in selected) {
    final url = resolve(tag.attributes['src']);
    if (url.isEmpty || !seen.add(url)) continue;
    images.add(
      ComicImage(
        url,
        double.tryParse(tag.attributes['width'] ?? '') ?? 0,
        double.tryParse(tag.attributes['height'] ?? '') ?? 0,
        tag.attributes['alt'] ?? '',
      ),
    );
  }
  int? pageNumber(ComicImage image) {
    final name = Uri.parse(image.url).pathSegments.last;
    final match = RegExp(r'^(\d+)\.\w+$').firstMatch(name);
    return match == null ? null : int.tryParse(match.group(1)!);
  }

  final numbers = images.map(pageNumber).toList();
  if (numbers.every((n) => n != null) &&
      numbers.toSet().length == numbers.length) {
    images.sort((a, b) => pageNumber(a)!.compareTo(pageNumber(b)!));
  }
  final title = (doc.querySelector('title')?.text ?? '')
      .replaceFirst(RegExp(r'\s*-\s*包子漫畫\s*$'), '')
      .trim();
  final description =
      doc.querySelector('meta[name="description"]')?.attributes['content'] ??
      '';
  final comic =
      RegExp(r'《([^》]+)》').firstMatch(description)?.group(1) ??
      (title.contains(' - ') ? title.split(' - ').last : '');
  final labels = doc
      .querySelectorAll('span.title')
      .map((element) => element.text.trim())
      .where(
        (text) => text.isNotEmpty && !RegExp('推薦|更多|热门|標籤').hasMatch(text),
      );
  return Chapter(
    pageUrl: pageUrl,
    comicName: comic,
    chapterName: labels.isEmpty ? title : labels.first,
    prevUrl: resolve(doc.querySelector('a#prev-chapter')?.attributes['href']),
    nextUrl: resolve(doc.querySelector('a#next-chapter')?.attributes['href']),
    images: images,
  );
}
