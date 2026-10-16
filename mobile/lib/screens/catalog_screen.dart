import 'dart:collection';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import '../models/catalog_navigation.dart';
import '../services/chapter_source.dart';

class CatalogScreen extends StatefulWidget {
  const CatalogScreen({super.key});
  @override
  State<CatalogScreen> createState() => _CatalogScreenState();
}

class _CatalogScreenState extends State<CatalogScreen> {
  InAppWebViewController? _controller;
  double _progress = 0;
  String? _error;
  bool _selected = false;
  bool _back = false;
  final _challenges = <String>{};
  Future<void> _load(String url) async {
    setState(() => _error = null);
    if (url == catalogHomeUrl) _challenges.clear();
    await _controller?.loadUrl(urlRequest: URLRequest(url: WebUri(url)));
  }

  bool _select(String url) {
    final chapter = chapterFromCatalog(url);
    if (chapter == null) return false;
    if (!_selected && mounted) {
      _selected = true;
      Navigator.pop(context, chapter);
    }
    return true;
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('首页与搜索'),
      leading: IconButton(
        tooltip: '返回阅读',
        icon: const Icon(Icons.close),
        onPressed: () => Navigator.pop(context),
      ),
      actions: [
        IconButton(
          tooltip: '网页后退',
          onPressed: _back ? () => _controller?.goBack() : null,
          icon: const Icon(Icons.arrow_back),
        ),
        IconButton(
          tooltip: '分类首页',
          onPressed: () => _load(catalogHomeUrl),
          icon: const Icon(Icons.home_outlined),
        ),
        IconButton(
          tooltip: '刷新',
          onPressed: () {
            setState(() => _error = null);
            _controller?.reload();
          },
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: Column(
      children: [
        if (_progress < 1) LinearProgressIndicator(value: _progress),
        Expanded(
          child: Stack(
            children: [
              InAppWebView(
                initialUrlRequest: URLRequest(url: WebUri(catalogHomeUrl)),
                initialSettings: InAppWebViewSettings(
                  userAgent: readerUserAgent,
                  javaScriptEnabled: true,
                  useShouldOverrideUrlLoading: true,
                  useShouldInterceptRequest: true,
                  supportMultipleWindows: true,
                ),
                initialUserScripts: UnmodifiableListView([
                  UserScript(
                    injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                    source:
                        "document.addEventListener('click', function(e) { const a = e.target.closest && e.target.closest('a'); if (a && a.target === '_blank') a.target = '_self'; }, true); window.open = function(url) { if (url) window.location.href = url; return null; };",
                  ),
                ]),
                onWebViewCreated: (controller) => _controller = controller,
                onProgressChanged: (controller, value) {
                  if (mounted) setState(() => _progress = value / 100);
                },
                shouldOverrideUrlLoading: (controller, action) async {
                  if (action.isForMainFrame != true) {
                    return NavigationActionPolicy.ALLOW;
                  }
                  final url = action.request.url?.toString() ?? '';
                  if (_select(url) || !isCatalogUrl(url)) {
                    return NavigationActionPolicy.CANCEL;
                  }
                  return NavigationActionPolicy.ALLOW;
                },
                onCreateWindow: (controller, action) async {
                  final url = action.request.url?.toString();
                  if (url != null && !_select(url) && isCatalogUrl(url)) {
                    await _load(url);
                  }
                  return false;
                },
                onLoadStart: (controller, url) {
                  if (url != null) _select(url.toString());
                },
                onLoadStop: (controller, url) async {
                  if (_selected || !mounted) return;
                  final challenge = await controller.evaluateJavascript(
                    source:
                        "(() => { try { const value = JSON.parse(document.querySelector('pre')?.textContent || document.body.innerText); return value.error === 'challenge_required' ? value.challenge_url : null; } catch { return null; } })()",
                  );
                  if (challenge is String && url != null) {
                    final target = Uri.parse(
                      url.toString(),
                    ).resolve(challenge).toString();
                    if (isCatalogUrl(target) && _challenges.add(target)) {
                      await _load(target);
                      return;
                    }
                    if (mounted) setState(() => _error = '站点验证未完成，请重试首页');
                  }
                  final back = await controller.canGoBack();
                  if (mounted) setState(() => _back = back);
                },
                onReceivedError: (controller, request, error) {
                  if (request.isForMainFrame == true && !_selected && mounted) {
                    setState(() => _error = '首页加载失败，请检查网络后重试');
                  }
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
              ),
              if (_error != null)
                Positioned.fill(
                  child: ColoredBox(
                    color: const Color(0xff111318),
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(_error!, textAlign: TextAlign.center),
                          const SizedBox(height: 16),
                          FilledButton(
                            onPressed: () => _load(catalogHomeUrl),
                            child: const Text('重试首页'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    ),
  );
}
