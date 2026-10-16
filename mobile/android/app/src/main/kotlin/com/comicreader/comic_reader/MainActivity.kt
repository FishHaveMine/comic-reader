package com.comicreader.comic_reader

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var syncChannel: MethodChannel? = null

    private fun syncConfig(intent: Intent?): Map<String, Any>? {
        val token = intent?.getStringExtra("sync_token") ?: return null
        val port = intent.getIntExtra("sync_port", 48765)
        if (!token.matches(Regex("[a-f0-9]{64}")) || port !in 1024..65535) return null
        val config = mutableMapOf<String, Any>("token" to token, "port" to port)
        intent.getStringExtra("sync_request")?.takeIf { it.matches(Regex("[a-f0-9]{32}")) }?.let { config["requestId"] = it }
        intent.removeExtra("sync_request")
        return config
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        syncChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "comic_reader/adb_sync")
        syncChannel?.setMethodCallHandler { call, result ->
            if (call.method == "getSyncConfig") result.success(syncConfig(intent))
            else result.notImplemented()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        syncConfig(intent)?.let { syncChannel?.invokeMethod("paired", it) }
    }
}
