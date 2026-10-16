import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import '../models/chapter.dart';
import '../models/chapter_directory.dart';
import 'chapter_source.dart';
import 'image_cache.dart';

class ChapterRepository {
  final ChapterSource source;
  final Directory directory;
  final ImageCacheService cache;
  final Map<String, Chapter> _chapters = {};
  final Map<String, Future<Chapter>> _loading = {};
  int revision = 0;
  ChapterRepository(this.source, this.directory, this.cache);
  File fileFor(String url) =>
      File('${directory.path}/${sha1.convert(utf8.encode(url))}.json');
  Future<bool> hasCached(String url) => fileFor(url).exists();
  final _directories = <String, List<ChapterEntry>>{};
  final _directoryLoading = <String, Future<List<ChapterEntry>>>{};
  Future<List<ChapterEntry>> loadDirectory(
    String pageUrl, {
    bool refresh = false,
  }) async {
    final key = '${Uri.parse(pageUrl).origin}/${comicIdFor(pageUrl)}';
    final file = File('${fileFor('directory:$key').path}.directory');
    if (!refresh) {
      if (_directories.containsKey(key)) return _directories[key]!;
      try {
        final saved = (jsonDecode(await file.readAsString()) as List)
            .map(
              (json) => ChapterEntry.fromJson(Map<String, dynamic>.from(json)),
            )
            .toList();
        if (saved.isNotEmpty &&
            saved.every(
              (entry) => comicIdFor(entry.pageUrl) == comicIdFor(pageUrl),
            )) {
          _directories[key] = saved;
          return saved;
        }
      } catch (_) {
        /* 无缓存时网络加载 */
      }
    }
    if (_directoryLoading.containsKey(key)) return _directoryLoading[key]!;
    final task =
        (() async {
          final entries = await source.loadDirectory(pageUrl);
          if (entries.isEmpty) throw const FormatException('未找到章节目录');
          _directories[key] = entries;
          try {
            await directory.create(recursive: true);
            final temp = File('${file.path}.part');
            await temp.writeAsString(
              jsonEncode(entries.map((entry) => entry.toJson()).toList()),
              flush: true,
            );
            await temp.rename(file.path);
          } on FileSystemException {
            /* 存储失败仍可选章 */
          }
          return entries;
        })().whenComplete(() {
          _directoryLoading.remove(key);
        });
    _directoryLoading[key] = task;
    return task;
  }

  void cancelPrefetch() {
    revision++;
  }

  Future<Chapter> load(String url, {void Function(String)? onPhase}) {
    if (_chapters.containsKey(url)) return Future.value(_chapters[url]);
    final running = _loading[url];
    if (running != null) return running;
    final task =
        (() async {
          final file = fileFor(url);
          try {
            final saved = Chapter.fromJson(
              jsonDecode(await file.readAsString()),
            );
            if (saved.pageUrl == url && saved.images.isNotEmpty) {
              _chapters[url] = saved;
              return saved;
            }
          } catch (_) {
            /* 无缓存时网络加载 */
          }
          final chapter = await source.loadChapter(url, onPhase: onPhase);
          _chapters[url] = chapter;
          await directory.create(recursive: true);
          final temp = File('${file.path}.part');
          await temp.writeAsString(jsonEncode(chapter.toJson()), flush: true);
          await temp.rename(file.path);
          return chapter;
        })().whenComplete(() {
          _loading.remove(url);
        });
    _loading[url] = task;
    return task;
  }

  Future<void> prefetch(
    Chapter current,
    void Function(String) onProgress, {
    List<Chapter> retained = const [],
  }) async {
    final token = ++revision;
    bool active() => token == revision;
    final keep = <String>{
      ...current.images.map((image) => image.url),
      for (final chapter in retained)
        ...chapter.images.map((image) => image.url),
    };
    final keepChapters = <String>{
      current.pageUrl,
      ...retained.map((chapter) => chapter.pageUrl),
    };
    final visited = <String>{current.pageUrl};
    var url = current.nextUrl;
    for (
      var level = 0;
      level < 2 && url.isNotEmpty && !visited.contains(url);
      level++
    ) {
      if (!active()) return;
      try {
        onProgress('正在缓存${level == 0 ? '下一话' : '下二话'}…');
        final chapter = await load(url);
        if (!active()) return;
        visited.add(url);
        keepChapters.add(url);
        keep.addAll(chapter.images.map((image) => image.url));
        final failed = await cache.prefetch(
          chapter.images.map((image) => image.url).toList(),
          (done, total, failed) {
            if (active()) {
              onProgress(
                '后${level + 1}话缓存 $done/$total${failed > 0 ? ' · $failed 页失败' : ''}',
              );
            }
          },
        );
        if (!active()) return;
        if (failed > 0) {
          onProgress('预取部分失败，下次翻章可重试');
          return;
        }
        url = chapter.nextUrl;
      } catch (_) {
        if (active()) onProgress('后续章节预取失败');
        return;
      }
    }
    if (!active()) return;
    await cache.prune(keep, stillCurrent: active);
    if (!active()) return;
    _chapters.removeWhere(
      (key, _) => !keepChapters.contains(key) && !_loading.containsKey(key),
    );
    final paths = keepChapters.map((url) => fileFor(url).path).toSet();
    if (await directory.exists()) {
      await for (final file in directory.list()) {
        if (!active()) return;
        if (file is File &&
            file.path.endsWith('.json') &&
            !paths.contains(file.path)) {
          try {
            await file.delete();
          } on FileSystemException {
            /* 清理中 */
          }
        }
      }
    }
    if (active()) onProgress(current.nextUrl.isEmpty ? '已到最新一话' : '后续章节已缓存');
  }
}
