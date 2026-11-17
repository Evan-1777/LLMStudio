import 'package:flutter/foundation.dart';

import '../models/plugin_models.dart';
import '../network/gateway_client.dart';

class PluginsController extends ChangeNotifier {
  PluginsController({required this.gateway});

  final GatewayClient gateway;

  List<SearchEnginePluginConfig> _searchEngines = const [];
  List<McpServerConfig> _mcpServers = const [];
  String? _selectedSearchEngineId;
  bool _webSearchEnabled = false;
  bool _isLoading = false;
  String? _error;

  List<SearchEnginePluginConfig> get searchEngines => _searchEngines;
  List<McpServerConfig> get mcpServers => _mcpServers;
  List<McpServerConfig> get enabledMcpServers =>
      _mcpServers.where((s) => s.enabled).toList();
  String? get selectedSearchEngineId => _selectedSearchEngineId;
  bool get webSearchEnabled => _webSearchEnabled;
  bool get isLoading => _isLoading;
  String? get error => _error;

  SearchEnginePluginConfig? get selectedSearchEngine {
    final id = _selectedSearchEngineId;
    if (id != null) {
      for (final e in _searchEngines) {
        if (e.engineId == id) return e;
      }
    }
    for (final e in _searchEngines) {
      if (e.isDefault) return e;
    }
    return _searchEngines.isNotEmpty ? _searchEngines.first : null;
  }

  void toggleWebSearch([bool? enabled]) {
    final next = enabled ?? !_webSearchEnabled;
    if (_webSearchEnabled == next) return;
    _webSearchEnabled = next;
    notifyListeners();
  }

  void selectSearchEngine(String id) {
    if (_selectedSearchEngineId == id) return;
    _selectedSearchEngineId = id;
    notifyListeners();
  }

  Future<void> refresh() async {
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        gateway.listSearchEngines(),
        gateway.listMcpServers(),
      ]);
      _searchEngines = results[0] as List<SearchEnginePluginConfig>;
      _mcpServers = results[1] as List<McpServerConfig>;
      if (_selectedSearchEngineId == null ||
          !_searchEngines.any((e) => e.engineId == _selectedSearchEngineId)) {
        String? fallback;
        for (final e in _searchEngines) {
          if (e.isDefault && e.enabled) {
            fallback = e.engineId;
            break;
          }
        }
        fallback ??= _searchEngines
            .where((e) => e.isDefault)
            .map((e) => e.engineId)
            .firstOrNull;
        fallback ??= _searchEngines.isNotEmpty
            ? _searchEngines.first.engineId
            : null;
        _selectedSearchEngineId = fallback;
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<SearchEnginePluginConfig> updateSearchEngine(
    String id, {
    bool? enabled,
    String? endpoint,
    String? apiKey,
    bool clearApiKey = false,
    int? maxResults,
    bool? isDefault,
  }) async {
    final updated = await gateway.updateSearchEngine(
      id,
      enabled: enabled,
      endpoint: endpoint,
      apiKey: apiKey,
      clearApiKey: clearApiKey,
      maxResults: maxResults,
      isDefault: isDefault,
    );
    _searchEngines = [
      for (final e in _searchEngines)
        if (e.engineId == id)
          updated
        else if (updated.isDefault && e.isDefault)
          e.copyWith(isDefault: false)
        else
          e,
    ];
    if (updated.isDefault) {
      _selectedSearchEngineId ??= updated.engineId;
    }
    notifyListeners();
    return updated;
  }

  Future<SearchEngineTestResult> testSearchEngine(
    String id, {
    String? query,
    String? endpoint,
    String? apiKey,
    int? maxResults,
  }) {
    return gateway.testSearchEngine(
      id,
      query: query,
      endpoint: endpoint,
      apiKey: apiKey,
      maxResults: maxResults,
    );
  }

  Future<McpServerConfig> createMcpServer(
    McpServerUpsertPayload payload,
  ) async {
    final created = await gateway.createMcpServer(payload);
    _mcpServers = [..._mcpServers, created];
    notifyListeners();
    return created;
  }

  Future<McpServerConfig> updateMcpServer(
    String id,
    McpServerUpsertPayload payload,
  ) async {
    final updated = await gateway.updateMcpServer(id, payload);
    _mcpServers = [
      for (final s in _mcpServers)
        if (s.id == id) updated else s,
    ];
    notifyListeners();
    return updated;
  }

  Future<McpServerConfig> toggleMcpServer(String id, bool enabled) async {
    final existing = _mcpServers.firstWhere((s) => s.id == id);
    return updateMcpServer(
      id,
      existing.toUpsertPayload(enabledOverride: enabled),
    );
  }

  Future<void> deleteMcpServer(String id) async {
    await gateway.deleteMcpServer(id);
    _mcpServers = _mcpServers.where((s) => s.id != id).toList();
    notifyListeners();
  }
}
