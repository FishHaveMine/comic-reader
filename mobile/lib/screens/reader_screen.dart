import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import '../models/chapter.dart';
import '../models/reading_progress.dart';
import '../models/favorite.dart';
import 'catalog_screen.dart';
import 'chapter_directory_sheet.dart';
import '../services/adb_sync_client.dart';
import '../services/chapter_repository.dart';
import '../services/image_cache.dart';
import '../services/progress_repository.dart';

class ReaderScreen extends StatefulWidget {
  final ProgressRepository progress;
  final ChapterRepository chapters;
  final AdbSyncClient sync;
  const ReaderScreen({
    super.key,
    required this.progress,
    required this.chapters,
    required this.sync,
  });
  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen>
    with WidgetsBindingObserver {
  final _scroll = ScrollController();
  final _url = TextEditingController();
  final _urlFocus = FocusNode();
  bool _controlsVisible = true;
  bool _addressVisible = false;
  bool _panelOpen = false;
  Timer? _hideTimer;
  Chapter? _chapter;
  final List<Chapter> _sequence = [];
  bool _appending = false;
  final List<({Chapter chapter, int index, ComicImage image})> _pages = [];
  void _addPages(Chapter chapter) {
    for (var index = 0; index < chapter.images.length; index++) {
      _pages.add((
        chapter: chapter,
        index: index,
        image: chapter.images[index],
      ));
    }
  }

  ReadingProgress? _incoming;
  ReadingProgress? _pendingProgress;
  int _readingClock = 0;
  double _lastScrollOffset = 0;
  bool _busy = false;
  bool _autoNext = true;
  bool _armed = false;
  bool _restoring = false;
  bool _foreground = true;
  int _request = 0;
  int _page = 0;
  double _width = 400;
  String _phase = '';
  String? _error;
  String _prefetch = '';
  String _cacheStats = '';
  Timer? _saveTimer;
  final Set<int> _loaded = {};
  final Set<int> _failed = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _autoNext = widget.progress.settings['autoNext'] != false;
    _scroll.addListener(_onScroll);
    widget.progress.addListener(_onRemoteProgress);
    widget.sync.beforeSync = _save;
    widget.sync.addListener(_syncChanged);
    widget.progress.favoritesRevision.addListener(_favoritesChanged);
    _urlFocus.addListener(_onAddressFocus);
    unawaited(_start());
  }

  Future<void> _start() async {
    unawaited(widget.sync.start().catchError((_) {}));
    if (!mounted) return;
    final last = widget.progress.latest;
    final localUrl = widget.progress.settings['lastUrl'] as String?;
    var startUrl = last?.pageUrl ?? localUrl ?? defaultChapterUrl;
    if (last != null &&
        localUrl != null &&
        localUrl != startUrl &&
        !await widget.chapters.hasCached(startUrl) &&
        await widget.chapters.hasCached(localUrl)) {
      startUrl = localUrl;
      if (last.deviceId != widget.progress.deviceId && mounted) {
        setState(() => _incoming = last);
      }
    }
    await _open(
      startUrl,
      resume: last?.pageUrl == startUrl ? last : null,
      userInitiated: false,
    );
    if (mounted &&
        startUrl == last?.pageUrl &&
        _incoming?.updatedAt == last?.updatedAt) {
      setState(() => _incoming = null);
    }
  }

  void _syncChanged() {
    if (mounted) setState(() {});
  }

  void _onRemoteProgress() {
    final progress = widget.progress.latest;
    _readingClock = max(_readingClock, progress?.updatedAt ?? 0);
    if (mounted) {
      setState(
        () => _incoming = progress?.deviceId != widget.progress.deviceId
            ? progress
            : null,
      );
    }
  }

  int _readingTimestamp() {
    _readingClock = max(
      DateTime.now().millisecondsSinceEpoch,
      max(
        _readingClock + 1,
        max(
              widget.progress.latest?.updatedAt ?? 0,
              widget.progress.favorites.firstOrNull?.updatedAt ?? 0,
            ) +
            1,
      ),
    );
    return _readingClock;
  }

  void _captureProgress([int? observedAt]) {
    if (_chapter == null || _restoring || !_scroll.hasClients || _busy) return;
    final position = _position();
    final page = _pages[position.index];
    _pendingProgress = ReadingProgress(
      bookId: bookIdFor(page.chapter.pageUrl),
      pageUrl: page.chapter.pageUrl,
      comicName: page.chapter.comicName,
      chapterName: page.chapter.chapterName,
      pageIndex: page.index,
      pageOffset: position.fraction,
      updatedAt: observedAt ?? _readingTimestamp(),
      deviceId: widget.progress.deviceId,
    );
  }

  double _height(int index) => _width / _pages[index].image.ratio + 6;
  ({int index, double fraction}) _position() {
    if (_chapter == null || !_scroll.hasClients) return (index: 0, fraction: 0);
    var offset = max(0.0, _scroll.offset - 12);
    for (var i = 0; i < _pages.length; i++) {
      final height = _height(i);
      if (offset < height || i == _pages.length - 1) {
        return (index: i, fraction: (offset / (height - 6)).clamp(0, 1));
      }
      offset -= height;
    }
    return (index: 0, fraction: 0);
  }

  Future<void> _save() async {
    _saveTimer?.cancel();
    _saveTimer = null;
    final record = _pendingProgress;
    if (record == null) return;
    _pendingProgress = null;
    try {
      await widget.progress.merge([record]);
    } catch (_) {
      _pendingProgress ??= record;
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('进度暂时无法保存，请检查存储空间')));
      }
    }
  }

  Future<void> _open(
    String raw, {
    ReadingProgress? resume,
    bool userInitiated = true,
  }) async {
    if (userInitiated && _chapter != null && _armed && !_busy) await _save();
    if (!mounted) return;
    final openedAt = userInitiated ? _readingTimestamp() : null;
    final token = ++_request;
    _appending = false;
    widget.chapters.cancelPrefetch();
    _hideTimer?.cancel();
    setState(() {
      _controlsVisible = true;
      _addressVisible = false;
      _busy = true;
      _error = null;
      _phase = '正在加载章节…';
    });
    try {
      final url = normalizeUrl(raw);
      final saved =
          resume ??
          widget.progress.records
              .where((record) => record.pageUrl == url)
              .firstOrNull;
      final chapter = await widget.chapters.load(
        url,
        onPhase: (phase) {
          if (mounted && token == _request) setState(() => _phase = phase);
        },
      );
      if (!mounted || token != _request) return;
      setState(() {
        _chapter = chapter;
        _sequence.clear();
        _sequence.add(chapter);
        _pages.clear();
        _addPages(chapter);
        _appending = false;
        _busy = false;
        _page = 0;
        _loaded.clear();
        _failed.clear();
        _armed = false;
        _restoring = true;
        _prefetch = '';
        _url.text = chapter.pageUrl;
      });
      unawaited(widget.progress.setting('lastUrl', chapter.pageUrl));
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || token != _request || !_scroll.hasClients) return;
        final index = min(saved?.pageIndex ?? 0, chapter.images.length - 1);
        var target = 12.0;
        for (var i = 0; i < index; i++) {
          target += _height(i);
        }
        target += (_height(index) - 6) * (saved?.pageOffset ?? 0);
        _scroll.jumpTo(target.clamp(0, _scroll.position.maxScrollExtent));
        setState(() {
          _restoring = false;
          _page = index;
        });
        _lastScrollOffset = _scroll.offset;
        if (userInitiated) {
          _captureProgress(openedAt);
          unawaited(_save());
        }
        _scheduleHide();
        _maybeAppendNext();
      });
    } catch (error) {
      if (mounted && token == _request) {
        setState(() {
          _busy = false;
          _error = '$error';
        });
      }
    }
  }

  Future<void> _refreshStats() async {
    final stats = await widget.chapters.cache.stats();
    if (mounted) {
      setState(
        () => _cacheStats =
            '${stats.files} 张 · ${(stats.bytes / 1048576).toStringAsFixed(1)} MB',
      );
    }
  }

  void _onScroll() {
    if (_restoring || !_scroll.hasClients || _busy || _sequence.isEmpty) return;
    final position = _position();
    final page = _pages[position.index];
    if (_page != page.index || _chapter != page.chapter) {
      setState(() {
        _page = page.index;
        _chapter = page.chapter;
        _url.text = page.chapter.pageUrl;
      });
    }
    if (_armed &&
        _foreground &&
        (_scroll.offset - _lastScrollOffset).abs() > 0.5) {
      _captureProgress();
    }
    _lastScrollOffset = _scroll.offset;
    if (_pendingProgress != null && _saveTimer == null) {
      _saveTimer = Timer(
        const Duration(milliseconds: 500),
        () => unawaited(_save()),
      );
    }
    _maybeAppendNext();
  }

  void _maybeAppendNext() {
    if (!_autoNext ||
        _busy ||
        _restoring ||
        !_foreground ||
        _panelOpen ||
        !_scroll.hasClients ||
        _sequence.isEmpty ||
        _appending) {
      return;
    }
    final tail = _sequence.last;
    if (tail.nextUrl.isEmpty ||
        _sequence.any((chapter) => chapter.pageUrl == tail.nextUrl)) {
      return;
    }
    var start = 12.0;
    var length = 0.0;
    final pages = _pages;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].chapter == tail) {
        length += _height(i);
      } else {
        start += _height(i);
      }
    }
    if (_scroll.offset + _scroll.position.viewportDimension <
        start + length / 2) {
      return;
    }
    unawaited(_appendNext(tail));
  }

  Future<void> _appendNext(Chapter tail) async {
    final token = _request;
    _appending = true;
    try {
      final next = await widget.chapters.load(tail.nextUrl);
      if (!mounted || token != _request || !_autoNext) return;
      setState(() {
        _sequence.add(next);
        _addPages(next);
        _prefetch = '下一话已接续';
      });
      unawaited(
        widget.chapters
            .prefetch(tail, (message) {
              if (mounted && token == _request) {
                setState(() => _prefetch = message);
              }
            }, retained: List.of(_sequence))
            .then((_) => _refreshStats())
            .catchError((_) {}),
      );
    } catch (_) {
      if (mounted && token == _request) {
        setState(() => _prefetch = '下一话加载失败，继续滑动可重试');
      }
    } finally {
      if (token == _request) _appending = false;
    }
  }

  void _returnToReading() {
    _request++;
    _appending = false;
    widget.chapters.cancelPrefetch();
    setState(() {
      _busy = false;
      _error = null;
      _url.text = _chapter!.pageUrl;
    });
    _scheduleHide();
    unawaited(
      widget.chapters
          .prefetch(_chapter!, (message) {
            if (mounted) setState(() => _prefetch = message);
          }, retained: List.of(_sequence))
          .catchError((_) {}),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    widget.sync.pause(!_foreground);
    if (_foreground) _scheduleHide();
    if (!_foreground) {
      _hideTimer?.cancel();
      if (_armed) unawaited(_save());
    }
  }

  @override
  void dispose() {
    _saveTimer?.cancel();
    _hideTimer?.cancel();
    _urlFocus.dispose();
    widget.progress.favoritesRevision.removeListener(_favoritesChanged);
    widget.chapters.cancelPrefetch();
    widget.sync.beforeSync = null;
    widget.sync.removeListener(_syncChanged);
    widget.sync.dispose();
    widget.progress.removeListener(_onRemoteProgress);
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    _url.dispose();
    widget.chapters.cache.dispose();
    widget.chapters.source.dispose();
    super.dispose();
  }

  bool get _canHide =>
      _chapter != null &&
      !_busy &&
      _error == null &&
      !_panelOpen &&
      !_urlFocus.hasFocus &&
      _foreground;
  void _favoritesChanged() {
    if (mounted) setState(() {});
  }

  void _onAddressFocus() {
    if (_urlFocus.hasFocus) {
      _showControls();
    } else {
      _scheduleHide();
    }
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    if (!_canHide || !_controlsVisible) return;
    _hideTimer = Timer(const Duration(seconds: 3), _hideControls);
  }

  void _showControls() {
    if (!mounted) return;
    setState(() => _controlsVisible = true);
    _scheduleHide();
  }

  void _hideControls() {
    if (!mounted || !_canHide) return;
    _hideTimer?.cancel();
    setState(() {
      _controlsVisible = false;
      _addressVisible = false;
    });
  }

  void _toggleControls() {
    if (_controlsVisible) {
      _hideControls();
    } else {
      _showControls();
    }
  }

  Future<void> _toggleFavorite() async {
    final chapter = _chapter;
    if (chapter == null || _busy) return;
    _showControls();
    try {
      final removed = widget.progress.isFavorite(chapter.pageUrl);
      await widget.progress.setFavorite(chapter, removed);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(removed ? '已取消收藏' : '已收藏漫画'),
            duration: const Duration(seconds: 1),
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('收藏保存失败，请重试')));
      }
    }
  }

  Future<void> _openHome() async {
    _showControls();
    _hideTimer?.cancel();
    _panelOpen = true;
    _urlFocus.unfocus();
    if (_armed && !_busy) await _save();
    if (!mounted) return;
    final chapterUrl = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const CatalogScreen()));
    _panelOpen = false;
    if (!mounted) return;
    if (chapterUrl != null) await _open(chapterUrl);
    _scheduleHide();
  }

  Future<void> _openDirectory() async {
    final chapter = _chapter;
    if (chapter == null || _busy) return;
    _showControls();
    _hideTimer?.cancel();
    _panelOpen = true;
    FocusScope.of(context).unfocus();
    await _save();
    if (!mounted) return;
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: const Color(0xff1a1d24),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      clipBehavior: Clip.antiAlias,
      builder: (_) =>
          ChapterDirectorySheet(chapter: chapter, repository: widget.chapters),
    );
    _panelOpen = false;
    if (!mounted) return;
    if (selected != null && selected != chapter.pageUrl) await _open(selected);
    _scheduleHide();
  }

  Future<void> _openFavorites() async {
    _showControls();
    _hideTimer?.cancel();
    _panelOpen = true;
    FocusScope.of(context).unfocus();
    final selected = await showModalBottomSheet<Favorite>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => FavoritesSheet(progress: widget.progress),
    );
    _panelOpen = false;
    if (!mounted) return;
    if (selected != null) {
      final progress = widget.progress.records
          .where((record) => record.bookId == selected.bookId)
          .firstOrNull;
      await _open(progress?.pageUrl ?? selected.pageUrl, resume: progress);
    }
    _scheduleHide();
  }

  Widget _buildPages() => LayoutBuilder(
    builder: (context, constraints) {
      _width = min(constraints.maxWidth, 820);
      final pages = _pages;
      final token = _request;
      return Stack(
        children: [
          if (_chapter != null)
            NotificationListener<UserScrollNotification>(
              onNotification: (notification) {
                if (!_busy &&
                    !_restoring &&
                    notification.direction != ScrollDirection.idle) {
                  _armed = true;
                  _hideControls();
                }
                return false;
              },
              child: ListView.builder(
                controller: _scroll,
                cacheExtent: 1600,
                padding: const EdgeInsets.only(top: 12, bottom: 72),
                itemCount: pages.length,
                itemExtentBuilder: (index, dimensions) => _height(index),
                itemBuilder: (context, index) => Center(
                  child: SizedBox(
                    width: _width,
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: ComicPage(
                        key: ValueKey(
                          '${pages[index].chapter.pageUrl}:${pages[index].index}',
                        ),
                        image: pages[index].image,
                        cache: widget.chapters.cache,
                        index: index,
                        onFailed: () {
                          if (token == _request) {
                            _failed.add(index);
                          }
                        },
                        onLoaded: () {
                          if (token != _request) return;
                          _failed.remove(index);
                          if (_loaded.add(index)) {
                            _maybeAppendNext();
                            unawaited(_refreshStats());
                          }
                        },
                      ),
                    ),
                  ),
                ),
              ),
            ),
          if (_busy || _error != null || _chapter == null)
            Positioned.fill(
              child: ColoredBox(
                color: const Color(0xff111318),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (_busy) const CircularProgressIndicator(),
                        const SizedBox(height: 20),
                        Text(_error ?? _phase, textAlign: TextAlign.center),
                        const SizedBox(height: 16),
                        if (_error != null)
                          FilledButton(
                            onPressed: () => _open(
                              _url.text.isEmpty ? defaultChapterUrl : _url.text,
                            ),
                            child: const Text('重试'),
                          ),
                        if (_chapter != null)
                          TextButton(
                            onPressed: _returnToReading,
                            child: const Text('返回当前章节'),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
  Widget _topControls() => Material(
    color: const Color(0xf5111318),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: kToolbarHeight,
          child: AppBar(
            leading: IconButton(
              tooltip: '返回首页',
              onPressed: _openHome,
              icon: const Icon(Icons.home_outlined),
            ),
            title: Tooltip(
              message: '回到顶部',
              child: InkWell(
                onTap: () {
                  _showControls();
                  if (_scroll.hasClients) {
                    _scroll.animateTo(
                      0,
                      duration: const Duration(milliseconds: 300),
                      curve: Curves.easeOut,
                    );
                  }
                },
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _chapter?.comicName.isNotEmpty == true
                          ? _chapter!.comicName
                          : '漫画阅读器',
                      style: const TextStyle(fontSize: 17),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (_chapter != null)
                      Text(
                        _chapter!.chapterName,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.white60,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
            ),
            actions: [
              IconButton(
                tooltip:
                    _chapter != null &&
                        widget.progress.isFavorite(_chapter!.pageUrl)
                    ? '取消收藏'
                    : '收藏漫画',
                onPressed: _chapter == null || _busy ? null : _toggleFavorite,
                icon: Icon(
                  _chapter != null &&
                          widget.progress.isFavorite(_chapter!.pageUrl)
                      ? Icons.star_rounded
                      : Icons.star_outline_rounded,
                ),
                color:
                    _chapter != null &&
                        widget.progress.isFavorite(_chapter!.pageUrl)
                    ? Colors.amber
                    : null,
              ),
              IconButton(
                tooltip: '我的收藏',
                onPressed: _openFavorites,
                icon: const Icon(Icons.collections_bookmark_outlined),
              ),
              IconButton(
                tooltip: '连续阅读下一话：${_autoNext ? '已开启' : '已关闭'}',
                isSelected: _autoNext,
                onPressed: () {
                  _showControls();
                  setState(() => _autoNext = !_autoNext);
                  _maybeAppendNext();
                  unawaited(widget.progress.setting('autoNext', _autoNext));
                },
                icon: const Icon(Icons.keyboard_double_arrow_down),
              ),
              IconButton(
                tooltip: '输入章节网址',
                onPressed: () {
                  _showControls();
                  setState(() => _addressVisible = !_addressVisible);
                  if (_addressVisible) {
                    _urlFocus.requestFocus();
                  } else {
                    _urlFocus.unfocus();
                  }
                },
                icon: const Icon(Icons.link),
              ),
            ],
          ),
        ),
        if (_addressVisible)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _url,
                    focusNode: _urlFocus,
                    decoration: const InputDecoration(
                      isDense: true,
                      hintText: '粘贴章节网址',
                      border: OutlineInputBorder(),
                    ),
                    keyboardType: TextInputType.url,
                    textInputAction: TextInputAction.go,
                    onSubmitted: (value) {
                      FocusScope.of(context).unfocus();
                      unawaited(_open(value));
                    },
                  ),
                ),
                IconButton(
                  tooltip: '打开章节',
                  onPressed: () {
                    FocusScope.of(context).unfocus();
                    unawaited(_open(_url.text));
                  },
                  icon: const Icon(Icons.arrow_forward),
                ),
              ],
            ),
          ),
        if (_incoming != null)
          MaterialBanner(
            content: Text(
              '桌面进度已同步：${_incoming!.chapterName} · 第 ${_incoming!.pageIndex + 1} 页',
            ),
            actions: [
              TextButton(
                onPressed: () => setState(() => _incoming = null),
                child: const Text('稍后'),
              ),
              TextButton(
                onPressed: () async {
                  await _save();
                  if (!mounted) return;
                  final record = widget.progress.latest;
                  setState(() => _incoming = null);
                  if (record != null) {
                    await _open(
                      record.pageUrl,
                      resume: record,
                      userInitiated: false,
                    );
                  }
                },
                child: const Text('继续阅读'),
              ),
            ],
          ),
      ],
    ),
  );
  Widget _bottomControls() => Material(
    color: const Color(0xf5111318),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              IconButton(
                tooltip: '上一话',
                onPressed: !_busy && _chapter?.prevUrl.isNotEmpty == true
                    ? () => _open(_chapter!.prevUrl)
                    : null,
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: TextButton.icon(
                  onPressed: _chapter == null || _busy ? null : _openDirectory,
                  icon: const Icon(Icons.toc, size: 20),
                  label: Text(
                    _chapter == null
                        ? '尚未打开章节'
                        : '第 ${_page + 1} / ${_chapter!.images.length} 页 · 目录',
                  ),
                ),
              ),
              IconButton(
                tooltip: '下一话',
                onPressed: !_busy && _chapter?.nextUrl.isNotEmpty == true
                    ? () => _open(_chapter!.nextUrl)
                    : null,
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          Text(
            [
              _prefetch,
              _cacheStats,
            ].where((text) => text.isNotEmpty).join(' · '),
            style: const TextStyle(fontSize: 11, color: Colors.white54),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          TextButton.icon(
            onPressed: () async {
              _showControls();
              if (_armed) await _save();
              await widget.sync.sync();
            },
            icon: const Icon(Icons.usb, size: 16),
            label: Text(
              widget.sync.status,
              style: const TextStyle(fontSize: 11),
            ),
          ),
        ],
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _toggleControls,
              child: _buildPages(),
            ),
          ),
          Align(
            alignment: Alignment.topCenter,
            child: IgnorePointer(
              ignoring: !_controlsVisible,
              child: AnimatedSlide(
                offset: _controlsVisible ? Offset.zero : const Offset(0, -1),
                duration: const Duration(milliseconds: 180),
                child: AnimatedOpacity(
                  key: const ValueKey('reader-top-controls'),
                  opacity: _controlsVisible ? 1 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: _topControls(),
                ),
              ),
            ),
          ),
          Align(
            alignment: Alignment.bottomCenter,
            child: IgnorePointer(
              ignoring: !_controlsVisible,
              child: AnimatedSlide(
                offset: _controlsVisible ? Offset.zero : const Offset(0, 1),
                duration: const Duration(milliseconds: 180),
                child: AnimatedOpacity(
                  opacity: _controlsVisible ? 1 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: _bottomControls(),
                ),
              ),
            ),
          ),
          if (!_controlsVisible && _chapter != null)
            Positioned(
              right: 12,
              bottom: 10,
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Colors.black54,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    child: Text(
                      '${_page + 1} / ${_chapter!.images.length}',
                      style: const TextStyle(
                        fontSize: 11,
                        color: Colors.white70,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

class FavoritesSheet extends StatelessWidget {
  final ProgressRepository progress;
  const FavoritesSheet({super.key, required this.progress});
  @override
  Widget build(BuildContext context) => SizedBox(
    height: MediaQuery.sizeOf(context).height * 0.65,
    child: ListenableBuilder(
      listenable: Listenable.merge([progress, progress.favoritesRevision]),
      builder: (context, child) {
        final favorites = progress.activeFavorites;
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '我的收藏 · ${favorites.length}',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭收藏',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Expanded(
              child: favorites.isEmpty
                  ? const Center(child: Text('还没有收藏，点击阅读页的星标添加漫画'))
                  : ListView.builder(
                      itemCount: favorites.length,
                      itemBuilder: (context, index) {
                        final favorite = favorites[index];
                        final record = progress.records
                            .where((record) => record.bookId == favorite.bookId)
                            .firstOrNull;
                        return ListTile(
                          leading: const Icon(Icons.book_outlined),
                          title: Text(
                            favorite.comicName.isEmpty
                                ? '未命名漫画'
                                : favorite.comicName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          subtitle: Text(
                            record == null
                                ? favorite.chapterName
                                : '${record.chapterName} · 第 ${record.pageIndex + 1} 页',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          onTap: () => Navigator.pop(context, favorite),
                          trailing: IconButton(
                            tooltip: '取消收藏',
                            onPressed: () async {
                              try {
                                await progress.removeFavorite(favorite);
                              } catch (_) {
                                if (context.mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    const SnackBar(content: Text('取消收藏失败，请重试')),
                                  );
                                }
                              }
                            },
                            icon: const Icon(
                              Icons.star_rounded,
                              color: Colors.amber,
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        );
      },
    ),
  );
}

class ComicPage extends StatefulWidget {
  final ComicImage image;
  final ImageCacheService cache;
  final int index;
  final VoidCallback onLoaded;
  final VoidCallback onFailed;
  const ComicPage({
    super.key,
    required this.image,
    required this.cache,
    required this.index,
    required this.onLoaded,
    required this.onFailed,
  });
  @override
  State<ComicPage> createState() => _ComicPageState();
}

class _ComicPageState extends State<ComicPage> {
  late Future<File> _file;
  bool _reported = false;
  @override
  void initState() {
    super.initState();
    _file = widget.cache.ensure(widget.image.url, urgent: true);
  }

  Future<void> _retry() async {
    try {
      await widget.cache.invalidate(widget.image.url);
      if (mounted) {
        setState(
          () => _file = widget.cache.ensure(widget.image.url, urgent: true),
        );
      }
    } catch (_) {
      /* 保持重试按钮可用 */
    }
  }

  Widget _error() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onFailed();
    });
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('第 ${widget.index + 1} 页加载失败'),
          const SizedBox(height: 12),
          FilledButton.tonal(onPressed: _retry, child: const Text('重试')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: widget.image.ratio,
    child: ColoredBox(
      color: const Color(0xff1a1d24),
      child: FutureBuilder<File>(
        future: _file,
        builder: (context, snapshot) {
          if (snapshot.hasError) return _error();
          if (!snapshot.hasData) {
            return const Center(
              child: CircularProgressIndicator(strokeWidth: 2),
            );
          }
          return Image.file(
            snapshot.data!,
            fit: BoxFit.contain,
            semanticLabel: widget.image.alt.isEmpty
                ? '第 ${widget.index + 1} 页'
                : widget.image.alt,
            errorBuilder: (context, error, stack) => _error(),
            frameBuilder: (context, child, frame, synchronous) {
              if ((frame != null || synchronous) && !_reported) {
                _reported = true;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) widget.onLoaded();
                });
              }
              return child;
            },
          );
        },
      ),
    ),
  );
}
