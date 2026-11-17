import 'package:flutter/foundation.dart';

import '../models/app_settings.dart';
import '../network/gateway_client.dart';
import '../storage/settings_store.dart';

enum ConnectionCheckStatus {
  idle,
  checking,
  ok,
  failed,
}

class SettingsController extends ChangeNotifier {
  SettingsController({
    required this.store,
    required this.gateway,
    AppSettings? initialSettings,
  }) : _settings = initialSettings ?? AppSettings.defaults();

  final SettingsStore store;
  final GatewayClient gateway;

  AppSettings _settings;
  bool _loaded = false;
  Future<void>? _loadingFuture;
  ConnectionCheckStatus _connectionStatus = ConnectionCheckStatus.idle;
  String _connectionMessage = '';

  AppSettings get settings => _settings;
  bool get isLoaded => _loaded;
  ConnectionCheckStatus get connectionStatus => _connectionStatus;
  String get connectionMessage => _connectionMessage;

  Future<void> load() {
    if (_loaded) return Future.value();
    return _loadingFuture ??= _performLoad();
  }

  Future<void> _performLoad() async {
    _settings = await store.load();
    gateway.updateConfig(
      baseUrl: _settings.gatewayBaseUrl,
      accessToken: _settings.accessToken,
    );
    _loaded = true;
    _loadingFuture = null;
    notifyListeners();
  }

  Future<void> update(AppSettings next) async {
    _settings = next;
    gateway.updateConfig(
      baseUrl: next.gatewayBaseUrl,
      accessToken: next.accessToken,
    );
    notifyListeners();
    await store.save(next);
  }

  Future<void> updateWith(AppSettings Function(AppSettings current) transform) =>
      update(transform(_settings));

  Future<bool> testConnection({String? overrideBaseUrl, String? overrideToken}) async {
    final prevBase = gateway.baseUrl;
    final prevToken = gateway.accessToken;
    if (overrideBaseUrl != null || overrideToken != null) {
      gateway.updateConfig(
        baseUrl: overrideBaseUrl ?? prevBase,
        accessToken: overrideToken ?? prevToken,
      );
    }

    _connectionStatus = ConnectionCheckStatus.checking;
    _connectionMessage = '';
    notifyListeners();

    try {
      final resp = await gateway.healthCheck();
      _connectionStatus = ConnectionCheckStatus.ok;
      _connectionMessage = 'v${resp['version'] ?? 'ok'}';
      notifyListeners();
      return true;
    } catch (e) {
      _connectionStatus = ConnectionCheckStatus.failed;
      _connectionMessage = e.toString();
      notifyListeners();
      return false;
    } finally {
      if (overrideBaseUrl != null || overrideToken != null) {
        gateway.updateConfig(baseUrl: prevBase, accessToken: prevToken);
      }
    }
  }
}
