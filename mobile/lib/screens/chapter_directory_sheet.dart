import 'package:flutter/material.dart';
import '../models/chapter.dart';
import '../models/chapter_directory.dart';
import '../services/chapter_repository.dart';

class ChapterDirectorySheet extends StatefulWidget {
  final Chapter chapter;
  final ChapterRepository repository;
  const ChapterDirectorySheet({
    super.key,
    required this.chapter,
    required this.repository,
  });
  @override
  State<ChapterDirectorySheet> createState() => _ChapterDirectorySheetState();
}

class _ChapterDirectorySheetState extends State<ChapterDirectorySheet> {
  final _search = TextEditingController();
  final _scroll = ScrollController();
  List<ChapterEntry> _entries = [];
  double get _rowHeight =>
      72 * (MediaQuery.textScalerOf(context).scale(14) / 14).clamp(1, 2);
  bool _busy = true, _descending = false;
  String? _error;
  int _request = 0;
  @override
  void initState() {
    super.initState();
    _load();
  }

  bool _current(ChapterEntry entry) =>
      Uri.parse(entry.pageUrl).path.replaceFirstMapped(
        RegExp(r'(\d+_\d+)(?:_\d+)?\.html$'),
        (match) => '${match[1]}.html',
      ) ==
      Uri.parse(widget.chapter.pageUrl).path.replaceFirstMapped(
        RegExp(r'(\d+_\d+)(?:_\d+)?\.html$'),
        (match) => '${match[1]}.html',
      );
  Future<void> _load({bool refresh = false}) async {
    final token = ++_request;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final entries = await widget.repository.loadDirectory(
        widget.chapter.pageUrl,
        refresh: refresh,
      );
      if (!mounted || token != _request) return;
      setState(() {
        _entries = entries;
        _busy = false;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted ||
            !_scroll.hasClients ||
            token != _request ||
            _search.text.isNotEmpty) {
          return;
        }
        final visible = _visible;
        final index = visible.indexWhere(_current);
        if (index >= 0) {
          _scroll.jumpTo(
            (index * _rowHeight).clamp(0, _scroll.position.maxScrollExtent),
          );
        }
      });
    } catch (_) {
      if (mounted && token == _request) {
        setState(() {
          _busy = false;
          _error = '章节目录加载失败，请重试';
        });
      }
    }
  }

  List<ChapterEntry> get _visible {
    final query = _search.text.trim().toLowerCase();
    final entries = _entries
        .where((entry) => entry.title.toLowerCase().contains(query))
        .toList();
    return _descending ? entries.reversed.toList() : entries;
  }

  @override
  void dispose() {
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final entries = _visible;
    final media = MediaQuery.of(context);
    final colors = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: AnimatedPadding(
        padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
        child: LayoutBuilder(
          builder: (context, constraints) => SizedBox(
            height: constraints.maxHeight.clamp(0, media.size.height * 0.84),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 18, 16, 16),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              '章节目录',
                              style: TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              widget.chapter.comicName.isEmpty
                                  ? '选择章节开始阅读'
                                  : widget.chapter.comicName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12,
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      IconButton.filledTonal(
                        tooltip: '关闭章节目录',
                        style: IconButton.styleFrom(
                          minimumSize: const Size(44, 44),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        onPressed: () {
                          FocusScope.of(context).unfocus();
                          Navigator.pop(context);
                        },
                        icon: const Icon(Icons.close, size: 22),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: TextField(
                    controller: _search,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      hintText: '搜索章节名称',
                      prefixIcon: const Icon(Icons.search, size: 20),
                      suffixIcon: _search.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: '清除章节搜索',
                              icon: const Icon(Icons.close, size: 18),
                              onPressed: () {
                                _search.clear();
                                setState(() {});
                              },
                            ),
                      filled: true,
                      fillColor: colors.surfaceContainerHigh,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 14,
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 6, 12, 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _search.text.trim().isEmpty
                              ? '共 ${_entries.length} 章'
                              : '找到 ${entries.length} / ${_entries.length} 章',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ),
                      TextButton.icon(
                        onPressed: () =>
                            setState(() => _descending = !_descending),
                        icon: const Icon(Icons.swap_vert, size: 18),
                        label: Text(_descending ? '正序' : '倒序'),
                      ),
                      IconButton(
                        tooltip: '刷新章节目录',
                        onPressed: _busy ? null : () => _load(refresh: true),
                        icon: const Icon(Icons.refresh, size: 20),
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  height: 2,
                  child: _busy
                      ? const LinearProgressIndicator(minHeight: 2)
                      : Divider(height: 1, color: colors.outlineVariant),
                ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 20,
                      vertical: 8,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            _error!,
                            style: TextStyle(fontSize: 12, color: colors.error),
                          ),
                        ),
                        TextButton(
                          onPressed: () => _load(refresh: true),
                          child: const Text('重试'),
                        ),
                      ],
                    ),
                  ),
                Expanded(
                  child: entries.isEmpty
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Text(
                              _busy
                                  ? '正在加载章节目录…'
                                  : _error != null
                                  ? '可关闭目录返回阅读'
                                  : '没有匹配的章节',
                              style: TextStyle(color: colors.onSurfaceVariant),
                            ),
                          ),
                        )
                      : ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          itemExtent: _rowHeight,
                          itemCount: entries.length,
                          itemBuilder: (context, index) {
                            final entry = entries[index],
                                current = _current(entry);
                            return Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 3,
                              ),
                              child: Material(
                                color: current
                                    ? colors.primary.withValues(alpha: 0.10)
                                    : Colors.transparent,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(12),
                                  side: BorderSide(
                                    color: current
                                        ? colors.primary.withValues(alpha: 0.25)
                                        : Colors.transparent,
                                  ),
                                ),
                                clipBehavior: Clip.antiAlias,
                                child: ListTile(
                                  selected: current,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                  ),
                                  horizontalTitleGap: 12,
                                  leading: SizedBox(
                                    width: 30,
                                    child: Center(
                                      child: Text(
                                        '${entry.index + 1}'.padLeft(3, '0'),
                                        style: TextStyle(
                                          fontSize: 12,
                                          color: current
                                              ? colors.primary
                                              : colors.onSurfaceVariant,
                                        ),
                                      ),
                                    ),
                                  ),
                                  title: Text(
                                    entry.title,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 14,
                                      height: 1.3,
                                      fontWeight: current
                                          ? FontWeight.w600
                                          : FontWeight.w400,
                                    ),
                                  ),
                                  trailing: current
                                      ? Container(
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 7,
                                            vertical: 4,
                                          ),
                                          decoration: BoxDecoration(
                                            color: colors.primary.withValues(
                                              alpha: 0.14,
                                            ),
                                            borderRadius: BorderRadius.circular(
                                              6,
                                            ),
                                          ),
                                          child: Text(
                                            '正在阅读',
                                            style: TextStyle(
                                              fontSize: 11,
                                              color: colors.primary,
                                            ),
                                          ),
                                        )
                                      : null,
                                  onTap: () {
                                    FocusScope.of(context).unfocus();
                                    Navigator.pop(context, entry.pageUrl);
                                  },
                                ),
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
