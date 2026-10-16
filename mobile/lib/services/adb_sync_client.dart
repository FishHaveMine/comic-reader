import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import '../models/reading_progress.dart';
import '../models/favorite.dart';
import 'progress_repository.dart';

class AdbSyncClient extends ChangeNotifier {
  static const channel = MethodChannel('comic_reader/adb_sync');
  final ProgressRepository progress;
  final HttpClient _http = HttpClient()
    ..connectionTimeout = const Duration(seconds: 3);
  Future<void> Function()? beforeSync;
  String? _requestId;
  Future<void>? _running;
  bool _syncAgain = false;
  bool _disposed = false;
  bool _started = false;

  String status = '点击手动同步 · 进度保存在本机';
  AdbSyncClient(this.progress) {
    _http.findProxy = (_) => 'DIRECT';
  }

  Future<void> start() async {
    if (_disposed || _started) return;
    _started = true;
    channel.setMethodCallHandler((call) async {
      if (call.method == 'paired') {
        await _pair(Map<String, dynamic>.from(call.arguments));
      }
    });
    try {
      final config = await channel.invokeMapMethod<String, dynamic>(
        'getSyncConfig',
      );
      if (config != null) await _pair(config);
    } on MissingPluginException {
      /* 单元测试或非 Android 平台 */
    }
  }

  Future<void> _pair(Map<String, dynamic> config) async {
    final token = config['token'];
    final port = config['port'];
    if (token is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(token) ||
        port is! int ||
        port < 1024 ||
        port > 65535) {
      return;
    }
    progress.settings['syncToken'] = token;
    progress.settings['syncPort'] = port;
    await progress.persist();
    status = 'ADB 已配对 · 点击手动同步';
    if (!_disposed) notifyListeners();
    final requestId = config['requestId'];
    if (requestId is String && RegExp(r'^[a-f0-9]{32}$').hasMatch(requestId)) {
      _requestId = requestId;
      await sync();
    }
  }

  Future<void> sync() {
    if (_disposed) return Future.value();
    final running = _running;
    if (running != null) {
      _syncAgain = true;
      return running;
    }
    final task =
        (() async {
          await beforeSync?.call();
          // 一轮请求期间本地继续阅读时，立即补发一次，避免等待下个定时周期。
          for (var round = 0; round < 2 && !_disposed; round++) {
            _syncAgain = false;
            final succeeded = await _exchange();
            if (!succeeded || !_syncAgain) break;
          }
        })().whenComplete(() {
          _running = null;
          _requestId = null;
        });
    _running = task;
    return task;
  }

  Future<bool> _exchange() async {
    final token = progress.settings['syncToken'];
    final port = progress.settings['syncPort'];
    if (token is! String || port is! int) {
      status = '尚未配对，请连接 ADB 并在桌面点击同步';
      if (!_disposed) notifyListeners();
      return false;
    }
    HttpClientRequest? request;
    try {
      final response = await (() async {
        request = await _http.postUrl(
          Uri.parse('http://127.0.0.1:$port/v1/sync'),
        );
        request!.headers.contentType = ContentType.json;
        request!.headers.set('Authorization', 'Bearer $token');
        request!.headers.set('X-Comic-Sync-Trigger', 'manual');
        request!.write(
          jsonEncode({
            ...progress.snapshot(),
            if (_requestId != null) 'requestId': _requestId,
          }),
        );
        final response = await request!.close();
        if (response.statusCode != 200) {
          throw HttpException('同步 HTTP ${response.statusCode}');
        }
        final bytes = await response.fold<List<int>>([], (bytes, chunk) {
          if (bytes.length + chunk.length > 1024 * 1024) {
            throw const FormatException('同步数据过大');
          }
          return bytes..addAll(chunk);
        });
        return jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      })().timeout(const Duration(seconds: 5));
      if (response['version'] != 1 ||
          response['records'] is! List ||
          (response['records'] as List).length > 2000) {
        throw const FormatException('同步协议无效');
      }
      final records = (response['records'] as List)
          .map(
            (json) => ReadingProgress.fromJson(Map<String, dynamic>.from(json)),
          )
          .toList();
      final rawFavorites = response['favorites'] ?? [];
      if (rawFavorites is! List || rawFavorites.length > 2000) {
        throw const FormatException('收藏同步数据无效');
      }
      final favorites = rawFavorites
          .map((json) => Favorite.fromJson(Map<String, dynamic>.from(json)))
          .toList();
      if (_disposed) return false;
      await progress.merge(records, incomingFavorites: favorites);
      final remoteRecords = mergeProgress([], records);
      final remoteFavorites = mergeFavorites([], favorites);
      _syncAgain =
          _syncAgain ||
          jsonEncode([
                progress.records.map((item) => item.toJson()).toList(),
                progress.favorites.map((item) => item.toJson()).toList(),
              ]) !=
              jsonEncode([
                remoteRecords.map((item) => item.toJson()).toList(),
                remoteFavorites.map((item) => item.toJson()).toList(),
              ]);
      final time = DateTime.now();
      status =
          'ADB 已比对 · 保留最新阅读进度 ${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
      return true;
    } catch (_) {
      request?.abort();
      status = 'ADB 未连接 · 进度保存在本机';
      return false;
    } finally {
      if (!_disposed) notifyListeners();
    }
  }

  void pause(bool paused) {
    /* 生命周期变化只影响阅读，不发起同步。 */
  }

  @override
  void dispose() {
    _disposed = true;

    if (_started) channel.setMethodCallHandler(null);
    _http.close(force: true);
    super.dispose();
  }
}
