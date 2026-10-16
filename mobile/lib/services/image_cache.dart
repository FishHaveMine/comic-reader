import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';

class _Download {
  final String url;
  final Completer<File> completer = Completer<File>();
  _Download(this.url);
}

class ImageCacheService {
  final Directory directory;
  final Future<Uint8List> Function(String) download;
  final int concurrency;
  final int retries;
  final Map<String, _Download> _tasks = {};
  final List<_Download> _waiting = [];
  int _active = 0;
  bool _disposed = false;
  ImageCacheService(
    this.directory,
    this.download, {
    this.concurrency = 6,
    this.retries = 3,
  });
  File fileFor(String url) =>
      File('${directory.path}/${sha1.convert(utf8.encode(url))}.img');

  Future<File> ensure(String url, {bool urgent = false}) async {
    final file = fileFor(url);
    if (await file.exists()) return file;
    if (_disposed) throw StateError('阅读器已关闭');
    var task = _tasks[url];
    if (task != null) {
      if (urgent && _waiting.remove(task)) _waiting.insert(0, task);
      return task.completer.future;
    }
    task = _Download(url);
    _tasks[url] = task;
    if (urgent) {
      _waiting.insert(0, task);
    } else {
      _waiting.add(task);
    }
    _pump();
    return task.completer.future;
  }

  void _pump() {
    while (!_disposed && _active < concurrency && _waiting.isNotEmpty) {
      final task = _waiting.removeAt(0);
      _active++;
      unawaited(_run(task));
    }
  }

  Future<void> _run(_Download task) async {
    try {
      Uint8List? bytes;
      for (var attempt = 0; attempt < retries; attempt++) {
        try {
          bytes = await download(task.url);
          break;
        } catch (_) {
          if (attempt == retries - 1) rethrow;
          await Future<void>.delayed(
            Duration(milliseconds: 250 * (attempt + 1)),
          );
        }
      }
      await directory.create(recursive: true);
      final file = fileFor(task.url);
      final temp = File('${file.path}.part');
      await temp.writeAsBytes(bytes!, flush: true);
      await temp.rename(file.path);
      task.completer.complete(file);
    } catch (error, stack) {
      task.completer.completeError(error, stack);
    } finally {
      _tasks.remove(task.url);
      _active--;
      _pump();
    }
  }

  Future<void> invalidate(String url) async {
    final file = fileFor(url);
    if (await file.exists()) await file.delete();
  }

  Future<int> prefetch(
    List<String> urls,
    void Function(int done, int total, int failed) onProgress,
  ) async {
    var done = 0;
    var failed = 0;
    await Future.wait(
      urls.map((url) async {
        try {
          await ensure(url);
        } catch (_) {
          failed++;
        }
        done++;
        onProgress(done, urls.length, failed);
      }),
    );
    return failed;
  }

  Future<void> prune(
    Set<String> urls, {
    required bool Function() stillCurrent,
  }) async {
    if (urls.isEmpty || !await directory.exists()) return;
    final keep = urls.map((url) => fileFor(url).path).toSet();
    await for (final file in directory.list()) {
      if (!stillCurrent()) return;
      if (file is File &&
          !file.path.endsWith('.part') &&
          !keep.contains(file.path) &&
          !_tasks.keys.any((url) => fileFor(url).path == file.path)) {
        try {
          await file.delete();
        } on FileSystemException {
          /* 已被另一任务删除 */
        }
      }
    }
  }

  Future<({int files, int bytes})> stats() async {
    var files = 0;
    var bytes = 0;
    if (await directory.exists()) {
      await for (final file in directory.list()) {
        if (file is File && !file.path.endsWith('.part')) {
          try {
            bytes += await file.length();
            files++;
          } on FileSystemException {
            /* 清理中 */
          }
        }
      }
    }
    return (files: files, bytes: bytes);
  }

  void dispose() {
    _disposed = true;
    for (final task in _waiting) {
      task.completer.completeError(StateError('阅读器已关闭'));
      _tasks.remove(task.url);
    }
    _waiting.clear();
  }
}
