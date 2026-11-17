import 'dart:convert';

import 'content_block.dart';
import 'provider.dart';

class SearchEnginePluginConfig {
  const SearchEnginePluginConfig({
    required this.engineId,
    required this.displayName,
    this.defaultEndpoint = '',
    this.requiresApiKey = false,
    this.enabled = false,
    this.endpoint = '',
    this.apiKeyMasked = '',
    this.apiKeySet = false,
    this.maxResults = 5,
    this.isDefault = false,
    this.updatedAt,
  });

  final String engineId;
  final String displayName;
  final String defaultEndpoint;
  final bool requiresApiKey;
  final bool enabled;
  final String endpoint;
  final String apiKeyMasked;
  final bool apiKeySet;
  final int maxResults;
  final bool isDefault;
  final DateTime? updatedAt;

  SearchEnginePluginConfig copyWith({
    String? engineId,
    String? displayName,
    String? defaultEndpoint,
    bool? requiresApiKey,
    bool? enabled,
    String? endpoint,
    String? apiKeyMasked,
    bool? apiKeySet,
    int? maxResults,
    bool? isDefault,
    DateTime? updatedAt,
  }) {
    return SearchEnginePluginConfig(
      engineId: engineId ?? this.engineId,
      displayName: displayName ?? this.displayName,
      defaultEndpoint: defaultEndpoint ?? this.defaultEndpoint,
      requiresApiKey: requiresApiKey ?? this.requiresApiKey,
      enabled: enabled ?? this.enabled,
      endpoint: endpoint ?? this.endpoint,
      apiKeyMasked: apiKeyMasked ?? this.apiKeyMasked,
      apiKeySet: apiKeySet ?? this.apiKeySet,
      maxResults: maxResults ?? this.maxResults,
      isDefault: isDefault ?? this.isDefault,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  factory SearchEnginePluginConfig.fromJson(Map<String, dynamic> json) {
    return SearchEnginePluginConfig(
      engineId: json['engineId'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      defaultEndpoint: json['defaultEndpoint'] as String? ?? '',
      requiresApiKey: json['requiresApiKey'] as bool? ?? false,
      enabled: json['enabled'] as bool? ?? false,
      endpoint: json['endpoint'] as String? ?? '',
      apiKeyMasked: json['apiKeyMasked'] as String? ?? '',
      apiKeySet: json['apiKeySet'] as bool? ?? false,
      maxResults: (json['maxResults'] as num?)?.toInt() ?? 5,
      isDefault: json['isDefault'] as bool? ?? false,
      updatedAt: json['updatedAt'] is String
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'engineId': engineId,
        'displayName': displayName,
        'defaultEndpoint': defaultEndpoint,
        'requiresApiKey': requiresApiKey,
        'enabled': enabled,
        'endpoint': endpoint,
        'apiKeyMasked': apiKeyMasked,
        'apiKeySet': apiKeySet,
        'maxResults': maxResults,
        'isDefault': isDefault,
      };
}

class SearchResultItem {
  const SearchResultItem({
    required this.title,
    required this.url,
    this.snippet = '',
  });

  final String title;
  final String url;
  final String snippet;

  factory SearchResultItem.fromJson(Map<String, dynamic> json) {
    return SearchResultItem(
      title: json['title'] as String? ?? '',
      url: json['url'] as String? ?? '',
      snippet: json['snippet'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'title': title,
        'url': url,
        if (snippet.isNotEmpty) 'snippet': snippet,
      };
}

class WebSearchPayload {
  const WebSearchPayload({
    this.query = '',
    this.engineId = '',
    this.results = const [],
    this.error = '',
  });

  final String query;
  final String engineId;
  final List<SearchResultItem> results;
  final String error;

  factory WebSearchPayload.fromExtra(Object? extra) {
    Map<String, dynamic>? map;
    if (extra is Map<String, dynamic>) {
      map = extra;
    } else if (extra is Map) {
      map = extra.map((k, v) => MapEntry(k.toString(), v));
    } else if (extra is String && extra.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(extra);
        if (decoded is Map<String, dynamic>) {
          map = decoded;
        }
      } catch (_) {}
    }
    if (map == null) return const WebSearchPayload();
    final rawResults = map['results'] as List<dynamic>? ?? const [];
    return WebSearchPayload(
      query: map['query'] as String? ?? '',
      engineId: map['engineId'] as String? ?? '',
      error: map['error'] as String? ?? '',
      results: rawResults
          .whereType<Map>()
          .map((e) => SearchResultItem.fromJson(
                e.map((k, v) => MapEntry(k.toString(), v)),
              ))
          .toList(),
    );
  }
}

class SearchEngineTestResult {
  const SearchEngineTestResult({
    required this.ok,
    required this.engineId,
    this.resultCount = 0,
    this.latencyMs = 0,
    this.message = '',
    this.results = const [],
  });

  final bool ok;
  final String engineId;
  final int resultCount;
  final int latencyMs;
  final String message;
  final List<SearchResultItem> results;

  factory SearchEngineTestResult.fromJson(Map<String, dynamic> json) {
    final rawResults = json['results'] as List<dynamic>? ?? const [];
    return SearchEngineTestResult(
      ok: json['ok'] as bool? ?? false,
      engineId: json['engineId'] as String? ?? '',
      resultCount: (json['resultCount'] as num?)?.toInt() ?? 0,
      latencyMs: (json['latencyMs'] as num?)?.toInt() ?? 0,
      message: json['message'] as String? ?? '',
      results: rawResults
          .whereType<Map>()
          .map((e) => SearchResultItem.fromJson(
                e.map((k, v) => MapEntry(k.toString(), v)),
              ))
          .toList(),
    );
  }
}

class McpServerConfig {
  const McpServerConfig({
    required this.id,
    required this.name,
    this.transport = 'stdio',
    this.endpoint = '',
    this.command = '',
    this.args = const [],
    this.env = const {},
    this.headers = const {},
    this.enabled = true,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String transport;
  final String endpoint;
  final String command;
  final List<String> args;
  final Map<String, String> env;
  final Map<String, String> headers;
  final bool enabled;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  McpServerConfig copyWith({
    String? id,
    String? name,
    String? transport,
    String? endpoint,
    String? command,
    List<String>? args,
    Map<String, String>? env,
    Map<String, String>? headers,
    bool? enabled,
  }) {
    return McpServerConfig(
      id: id ?? this.id,
      name: name ?? this.name,
      transport: transport ?? this.transport,
      endpoint: endpoint ?? this.endpoint,
      command: command ?? this.command,
      args: args ?? this.args,
      env: env ?? this.env,
      headers: headers ?? this.headers,
      enabled: enabled ?? this.enabled,
      createdAt: createdAt,
      updatedAt: updatedAt,
    );
  }

  factory McpServerConfig.fromJson(Map<String, dynamic> json) {
    final rawArgs = json['args'] as List<dynamic>? ?? const [];
    final rawEnv = json['env'] as Map<String, dynamic>?;
    final rawHeaders = json['headers'] as Map<String, dynamic>?;
    return McpServerConfig(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      transport: json['transport'] as String? ?? 'stdio',
      endpoint: json['endpoint'] as String? ?? '',
      command: json['command'] as String? ?? '',
      args: rawArgs.map((e) => e.toString()).toList(),
      env: rawEnv == null
          ? const {}
          : rawEnv.map((k, v) => MapEntry(k, v.toString())),
      headers: rawHeaders == null
          ? const {}
          : rawHeaders.map((k, v) => MapEntry(k, v.toString())),
      enabled: json['enabled'] as bool? ?? true,
      createdAt: json['createdAt'] is String
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      updatedAt: json['updatedAt'] is String
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
    );
  }

  McpServerUpsertPayload toUpsertPayload({bool? enabledOverride}) {
    return McpServerUpsertPayload(
      id: id,
      name: name,
      transport: transport,
      endpoint: endpoint,
      command: command,
      args: args,
      env: env,
      headers: headers,
      enabled: enabledOverride ?? enabled,
    );
  }
}

class McpServerUpsertPayload {
  const McpServerUpsertPayload({
    this.id,
    required this.name,
    this.transport = 'stdio',
    this.endpoint = '',
    this.command = '',
    this.args = const [],
    this.env = const {},
    this.headers = const {},
    this.enabled = true,
  });

  final String? id;
  final String name;
  final String transport;
  final String endpoint;
  final String command;
  final List<String> args;
  final Map<String, String> env;
  final Map<String, String> headers;
  final bool enabled;

  Map<String, dynamic> toJson() => {
        if (id != null && id!.isNotEmpty) 'id': id,
        'name': name,
        'transport': transport,
        'endpoint': endpoint,
        'command': command,
        'args': args,
        'env': env,
        'headers': headers,
        'enabled': enabled,
      };
}

class ProviderAdapterInfo {
  const ProviderAdapterInfo({
    required this.id,
    required this.displayName,
  });

  final String id;
  final String displayName;

  factory ProviderAdapterInfo.fromJson(Map<String, dynamic> json) {
    return ProviderAdapterInfo(
      id: json['id'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
    );
  }
}

class ProviderConnectionTestResult {
  const ProviderConnectionTestResult({
    required this.ok,
    this.latencyMs = 0,
    this.modelCount = 0,
    this.message = '',
  });

  final bool ok;
  final int latencyMs;
  final int modelCount;
  final String message;

  factory ProviderConnectionTestResult.fromJson(Map<String, dynamic> json) {
    return ProviderConnectionTestResult(
      ok: json['ok'] as bool? ?? false,
      latencyMs: (json['latencyMs'] as num?)?.toInt() ?? 0,
      modelCount: (json['modelCount'] as num?)?.toInt() ?? 0,
      message: json['message'] as String? ?? '',
    );
  }
}

class DiscoveredModel {
  const DiscoveredModel({
    required this.id,
    required this.name,
    this.group = 'other',
    this.apiFormat = 'openai-completions',
    this.contextWindow = 0,
    this.maxTokens = 0,
    this.reasoning = false,
    this.inputModalities = const ['text'],
  });

  final String id;
  final String name;
  final String group;
  final String apiFormat;
  final int contextWindow;
  final int maxTokens;
  final bool reasoning;
  final List<String> inputModalities;

  factory DiscoveredModel.fromJson(Map<String, dynamic> json) {
    final rawMods = json['inputModalities'] as List<dynamic>?;
    return DiscoveredModel(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      group: json['group'] as String? ?? 'other',
      apiFormat: json['apiFormat'] as String? ?? 'openai-completions',
      contextWindow: (json['contextWindow'] as num?)?.toInt() ?? 0,
      maxTokens: (json['maxTokens'] as num?)?.toInt() ?? 0,
      reasoning: json['reasoning'] as bool? ?? false,
      inputModalities: rawMods == null
          ? const ['text']
          : rawMods.map((e) => e.toString()).toList(),
    );
  }

  ModelConfig toModelConfig() {
    return ModelConfig(
      id: id,
      name: name.isNotEmpty ? name : id,
      apiFormat: apiFormat.isNotEmpty ? apiFormat : 'openai-completions',
      contextWindow: contextWindow,
      maxTokens: maxTokens,
      reasoning: reasoning,
      inputModalities: inputModalities,
    );
  }
}

class ComposerAttachment {
  const ComposerAttachment({
    required this.name,
    this.mimeType = 'text/plain',
    this.isImage = false,
    this.base64Data = '',
    this.textContent = '',
    this.byteLength = 0,
  });

  final String name;
  final String mimeType;
  final bool isImage;
  final String base64Data;
  final String textContent;
  final int byteLength;

  ContentBlock toContentBlock() {
    if (isImage) {
      return ImageBlock(
        mimeType: mimeType.isNotEmpty ? mimeType : 'image/png',
        data: base64Data,
      );
    }
    return TextBlock('<file name="$name">\n$textContent\n</file>');
  }
}
