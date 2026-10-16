import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:comic_reader/services/adb_sync_client.dart';
import 'package:comic_reader/services/progress_repository.dart';

class CountingSync extends AdbSyncClient {
  int requests = 0;
  CountingSync(super.progress);
  @override
  Future<void> sync() async {
    requests++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final manual in [false, true]) {
    test(manual ? '桌面按钮请求携带一次性标识后触发同步' : '启动、配对与回到前台均不自动同步', () async {
      final dir = await Directory.systemTemp.createTemp('comic-manual-');
      final progress = ProgressRepository(dir);
      await progress.init();
      final client = CountingSync(progress);
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        AdbSyncClient.channel,
        (call) async => {
          'token': 'a' * 64,
          'port': 48765,
          if (manual) 'requestId': 'b' * 32,
        },
      );
      addTearDown(() async {
        client.dispose();
        messenger.setMockMethodCallHandler(AdbSyncClient.channel, null);
        await dir.delete(recursive: true);
      });
      await client.start();
      expect(client.requests, manual ? 1 : 0);
      client.pause(true);
      client.pause(false);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(client.requests, manual ? 1 : 0);
      if (!manual) {
        await client.sync();
        expect(client.requests, 1);
      }
    });
  }
}
