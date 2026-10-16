import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../models/chapter.dart';
import '../models/chapter_directory.dart';
import '../models/catalog_navigation.dart';

const readerUserAgent =
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const blockedHosts = [
  'outbrain.com',
  '91app.io',
  '91app.com',
  'impactify.media',
  'servenobid.com',
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'scorecardresearch.com',
  'adnxs.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'smartadserver.com',
  'facebook.net',
];

class ChapterSource {
  final HttpClient _http = HttpClient()
    ..connectionTimeout = const Duration(seconds: 15);
  Future<void>? _warming;
  bool _disposed = false;
  ChapterSource() {
    _http.userAgent = readerUserAgent;
    _http.findProxy = (_) => 'DIRECT';
  }

  Future<({int status, Uint8List bytes})> request(
    String url,
    String accept,
  ) async {
    HttpClientRequest? request;
    try {
      return await (() async {
        request = await _http.getUrl(Uri.parse(url));
        request!.headers.set('Referer', 'https://www.twmanga.com/');
        request!.headers.set('Accept', accept);
        final cookies = await CookieManager.instance().getCookies(
          url: WebUri(url),
        );
        if (cookies.isNotEmpty) {
          request!.headers.set(
            'Cookie',
            cookies
                .map((cookie) => '${cookie.name}=${cookie.value}')
                .join('; '),
          );
        }
        final response = await request!.close();
        final bytes = await response.fold<BytesBuilder>(
          BytesBuilder(),
          (builder, part) => builder..add(part),
        );
        return (status: response.statusCode, bytes: bytes.takeBytes());
      })().timeout(const Duration(seconds: 15));
    } on TimeoutException {
      request?.abort();
      throw const HttpException('请求超时，请重试');
    }
  }

  Future<Chapter> loadChapter(
    String url, {
    void Function(String)? onPhase,
  }) async {
    onPhase?.call('正在加载章节…');
    var response = await request(url, 'text/html,application/xhtml+xml');
    if (response.status == 403) {
      onPhase?.call('正在通过站点验证，通常需要十几秒…');
      await warmUp(url);
      response = await request(url, 'text/html,application/xhtml+xml');
    }
    if (response.status != 200) {
      throw HttpException('抓取章节失败：HTTP ${response.status}');
    }
    final chapter = parseChapter(
      utf8.decode(response.bytes, allowMalformed: true),
      url,
    );
    if (chapter.images.isEmpty) {
      throw const FormatException('未找到正片图片，请使用本站章节网址');
    }
    return chapter;
  }

  Future<List<ChapterEntry>> loadDirectory(String pageUrl) async {
    final url = directoryUrlFor(pageUrl);
    final response = await request(url, 'text/html');
    var entries = parseDirectory(
      utf8.decode(response.bytes, allowMalformed: true),
      pageUrl,
    );
    if (response.status == 200 && entries.isNotEmpty) return entries;
    final verified = await _runWarmUp(url, directoryChapter: pageUrl);
    entries = parseDirectory(verified, pageUrl);
    if (entries.isEmpty) {
      throw const FormatException('章节目录加载失败，请稍后重试');
    }
    return entries;
  }

  Future<void> warmUp(String url) {
    final running = _warming;
    if (running != null) return running;
    final task = _runWarmUp(
      url,
    ).then<void>((_) {}).whenComplete(() => _warming = null);
    _warming = task;
    return task;
  }

  Future<String> _runWarmUp(String url, {String? directoryChapter}) async {
    HeadlessInAppWebView? webview;
    try {
      InAppWebViewController? controller;
      webview = HeadlessInAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(url)),
        initialSettings: InAppWebViewSettings(
          userAgent: readerUserAgent,
          javaScriptEnabled: true,
          useShouldInterceptRequest: true,
          blockNetworkImage: true,
        ),
        onWebViewCreated: (value) {
          controller = value;
        },
        shouldInterceptRequest: (controller, request) async {
          final host = request.url.host;
          if (blockedHosts.any(
            (blocked) => host == blocked || host.endsWith('.$blocked'),
          )) {
            return WebResourceResponse(
              data: Uint8List(0),
              contentType: 'text/plain',
              statusCode: 200,
              reasonPhrase: 'OK',
            );
          }
          return null;
        },
      );
      await webview.run();
      var passed = false;
      String verified = '';
      final challenges = <String>{};
      for (var tick = 0; tick < 45 && !_disposed; tick++) {
        await Future<void>.delayed(const Duration(seconds: 1));
        try {
          final value = await controller?.evaluateJavascript(
            source: 'document.documentElement.outerHTML',
          );
          if (value is String &&
              (directoryChapter == null
                  ? parseChapter(value, url).images.isNotEmpty
                  : parseDirectory(
                      value,
                      directoryChapter,
                      baseUrl: url,
                    ).isNotEmpty)) {
            passed = true;
            verified = value;
            break;
          }
          if (directoryChapter != null) {
            final challenge = await controller?.evaluateJavascript(
              source:
                  "(() => { try { return JSON.parse(document.body.innerText).challenge_url || null; } catch { return null; } })()",
            );
            if (challenge is String) {
              final target = Uri.parse(url).resolve(challenge).toString();
              if (isCatalogUrl(target) && challenges.add(target)) {
                await controller?.loadUrl(
                  urlRequest: URLRequest(url: WebUri(target)),
                );
              }
            }
          }
        } catch (_) {
          /* 网关跳转期间下一轮再检查 */
        }
      }
      if (!passed) throw const HttpException('站点验证未完成，请稍后重试');
      return verified;
    } finally {
      await webview?.dispose();
    }
  }

  Future<Uint8List> image(String url) async {
    final response = await request(
      url,
      'image/avif,image/webp,image/*,*/*;q=0.8',
    );
    if (response.status != 200) {
      throw HttpException('图片 HTTP ${response.status}');
    }
    final bytes = response.bytes;
    final signature = String.fromCharCodes(bytes.take(16));
    final valid =
        bytes.length > 64 &&
        ((bytes[0] == 0xff && bytes[1] == 0xd8) ||
            (bytes[0] == 0x89 && bytes[1] == 0x50) ||
            signature.startsWith('GIF') ||
            (signature.startsWith('RIFF') && signature.contains('WEBP')) ||
            signature.contains('ftyp'));
    if (!valid) throw const HttpException('返回内容不是有效图片');
    return bytes;
  }

  void dispose() {
    _disposed = true;
    _http.close(force: true);
  }
}
