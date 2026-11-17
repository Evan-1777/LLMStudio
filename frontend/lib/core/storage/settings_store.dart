import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/app_settings.dart';

class SettingsStore {
  SettingsStore({SharedPreferences? prefs}) : _cached = prefs;

  static const String storageKey = 'llmstudio.settings.v1';

  SharedPreferences? _cached;

  Future<SharedPreferences> _ensurePrefs() async {
    return _cached ??= await SharedPreferences.getInstance();
  }

  Future<AppSettings> load() async {
    final prefs = await _ensurePrefs();
    final raw = prefs.getString(storageKey);
    if (raw == null || raw.isEmpty) {
      return AppSettings.defaults();
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) {
        return AppSettings.fromJson(decoded);
      }
    } catch (_) {
      // Corrupted persisted settings fall back to defaults.
    }
    return AppSettings.defaults();
  }

  Future<void> save(AppSettings settings) async {
    final prefs = await _ensurePrefs();
    await prefs.setString(storageKey, jsonEncode(settings.toJson()));
  }
}
