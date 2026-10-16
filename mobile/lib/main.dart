import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'screens/reader_screen.dart';
import 'services/adb_sync_client.dart';
import 'services/chapter_repository.dart';
import 'services/chapter_source.dart';
import 'services/image_cache.dart';
import 'services/progress_repository.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final directory = await getApplicationSupportDirectory();
    final progress = ProgressRepository(directory);
    await progress.init();
    final source = ChapterSource();
    final cache = ImageCacheService(
      Directory('${directory.path}/image-cache'),
      source.image,
    );
    final chapters = ChapterRepository(
      source,
      Directory('${directory.path}/chapters'),
      cache,
    );
    runApp(
      ReaderApp(
        progress: progress,
        chapters: chapters,
        sync: AdbSyncClient(progress),
      ),
    );
  } catch (error) {
    runApp(
      MaterialApp(
        home: Scaffold(body: Center(child: Text('阅读器启动失败：$error'))),
      ),
    );
  }
}

class ReaderApp extends StatelessWidget {
  final ProgressRepository progress;
  final ChapterRepository chapters;
  final AdbSyncClient sync;
  const ReaderApp({
    super.key,
    required this.progress,
    required this.chapters,
    required this.sync,
  });
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '漫画阅读器',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      colorSchemeSeed: const Color(0xff5b8cff),
      scaffoldBackgroundColor: const Color(0xff111318),
      useMaterial3: true,
    ),
    home: ReaderScreen(progress: progress, chapters: chapters, sync: sync),
  );
}
