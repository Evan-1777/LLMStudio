import 'conversation.dart';

class CompatConfig {
  const CompatConfig({
    this.maxTokensField = '',
    this.supportsDeveloperRole,
    this.supportsStreamOptions,
    this.thinkingFormat = '',
    this.reasoningEffortField = '',
    this.pathOverride = '',
    this.extraHeaders = const {},
    this.extraBody = const {},
  });

  final String maxTokensField;
  final bool? supportsDeveloperRole;
  final bool? supportsStreamOptions;
  final String thinkingFormat;
  final String reasoningEffortField;
  final String pathOverride;
  final Map<String, String> extraHeaders;
  final Map<String, dynamic> extraBody;

  factory CompatConfig.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const CompatConfig();
    final rawHeaders = json['extraHeaders'] as Map<String, dynamic>?;
    final rawBody = json['extraBody'] as Map<String, dynamic>?;
    return CompatConfig(
      maxTokensField: json['maxTokensField'] as String? ?? '',
      supportsDeveloperRole: json['supportsDeveloperRole'] as bool?,
      supportsStreamOptions: json['supportsStreamOptions'] as bool?,
      thinkingFormat: json['thinkingFormat'] as String? ?? '',
      reasoningEffortField: json['reasoningEffortField'] as String? ?? '',
      pathOverride: json['pathOverride'] as String? ?? '',
      extraHeaders: rawHeaders == null
          ? const {}
          : rawHeaders.map((k, v) => MapEntry(k, v.toString())),
      extraBody: rawBody ?? const {},
    );
  }

  Map<String, dynamic> toJson() => {
        if (maxTokensField.isNotEmpty) 'maxTokensField': maxTokensField,
        if (supportsDeveloperRole != null)
          'supportsDeveloperRole': supportsDeveloperRole,
        if (supportsStreamOptions != null)
          'supportsStreamOptions': supportsStreamOptions,
        if (thinkingFormat.isNotEmpty) 'thinkingFormat': thinkingFormat,
        if (reasoningEffortField.isNotEmpty)
          'reasoningEffortField': reasoningEffortField,
        if (pathOverride.isNotEmpty) 'pathOverride': pathOverride,
        if (extraHeaders.isNotEmpty) 'extraHeaders': extraHeaders,
        if (extraBody.isNotEmpty) 'extraBody': extraBody,
      };

  CompatConfig copyWith({
    String? maxTokensField,
    bool? Function()? supportsDeveloperRole,
    bool? Function()? supportsStreamOptions,
    String? thinkingFormat,
    String? reasoningEffortField,
    String? pathOverride,
    Map<String, String>? extraHeaders,
    Map<String, dynamic>? extraBody,
  }) {
    return CompatConfig(
      maxTokensField: maxTokensField ?? this.maxTokensField,
      supportsDeveloperRole: supportsDeveloperRole != null
          ? supportsDeveloperRole()
          : this.supportsDeveloperRole,
      supportsStreamOptions: supportsStreamOptions != null
          ? supportsStreamOptions()
          : this.supportsStreamOptions,
      thinkingFormat: thinkingFormat ?? this.thinkingFormat,
      reasoningEffortField: reasoningEffortField ?? this.reasoningEffortField,
      pathOverride: pathOverride ?? this.pathOverride,
      extraHeaders: extraHeaders ?? this.extraHeaders,
      extraBody: extraBody ?? this.extraBody,
    );
  }
}

class FormatInfo {
  const FormatInfo({
    required this.id,
    required this.displayName,
    this.defaultCompat = const CompatConfig(),
  });

  final String id;
  final String displayName;
  final CompatConfig defaultCompat;

  factory FormatInfo.fromJson(Map<String, dynamic> json) {
    return FormatInfo(
      id: json['id'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      defaultCompat: CompatConfig.fromJson(
        json['defaultCompat'] as Map<String, dynamic>?,
      ),
    );
  }
}

class ModelConfig {
  const ModelConfig({
    required this.id,
    required this.name,
    required this.apiFormat,
    this.contextWindow = 0,
    this.maxTokens = 0,
    this.reasoning = false,
    this.inputModalities = const ['text'],
    this.compat = const CompatConfig(),
    this.defaultParams = const GenerationParams(),
  });

  final String id;
  final String name;
  final String apiFormat;
  final int contextWindow;
  final int maxTokens;
  final bool reasoning;
  final List<String> inputModalities;
  final CompatConfig compat;
  final GenerationParams defaultParams;

  factory ModelConfig.fromJson(Map<String, dynamic> json) {
    final rawMods = json['inputModalities'] as List<dynamic>?;
    return ModelConfig(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      apiFormat: json['apiFormat'] as String? ?? '',
      contextWindow: (json['contextWindow'] as num?)?.toInt() ?? 0,
      maxTokens: (json['maxTokens'] as num?)?.toInt() ?? 0,
      reasoning: json['reasoning'] as bool? ?? false,
      inputModalities: rawMods == null
          ? const ['text']
          : rawMods.map((e) => e.toString()).toList(),
      compat: CompatConfig.fromJson(json['compat'] as Map<String, dynamic>?),
      defaultParams: GenerationParams.fromJson(
        json['defaultParams'] as Map<String, dynamic>?,
      ),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'apiFormat': apiFormat,
        if (contextWindow > 0) 'contextWindow': contextWindow,
        if (maxTokens > 0) 'maxTokens': maxTokens,
        if (reasoning) 'reasoning': true,
        if (inputModalities.isNotEmpty) 'inputModalities': inputModalities,
        if (compat.toJson().isNotEmpty) 'compat': compat.toJson(),
        if (defaultParams.toJson().isNotEmpty)
          'defaultParams': defaultParams.toJson(),
      };

  ModelConfig copyWith({
    String? id,
    String? name,
    String? apiFormat,
    int? contextWindow,
    int? maxTokens,
    bool? reasoning,
    List<String>? inputModalities,
    CompatConfig? compat,
    GenerationParams? defaultParams,
  }) {
    return ModelConfig(
      id: id ?? this.id,
      name: name ?? this.name,
      apiFormat: apiFormat ?? this.apiFormat,
      contextWindow: contextWindow ?? this.contextWindow,
      maxTokens: maxTokens ?? this.maxTokens,
      reasoning: reasoning ?? this.reasoning,
      inputModalities: inputModalities ?? this.inputModalities,
      compat: compat ?? this.compat,
      defaultParams: defaultParams ?? this.defaultParams,
    );
  }
}

class ProviderConfig {
  const ProviderConfig({
    required this.id,
    required this.name,
    this.adapter = 'generic-http',
    required this.baseUrl,
    this.authType = 'bearer',
    this.apiKeyMasked = '',
    this.apiKeySet = false,
    this.headers = const {},
    this.models = const [],
    this.enabled = true,
    this.builtIn = false,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String adapter;
  final String baseUrl;
  final String authType;
  final String apiKeyMasked;
  final bool apiKeySet;
  final Map<String, String> headers;
  final List<ModelConfig> models;
  final bool enabled;
  final bool builtIn;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  factory ProviderConfig.fromJson(Map<String, dynamic> json) {
    final rawHeaders = json['headers'] as Map<String, dynamic>?;
    final rawModels = json['models'] as List<dynamic>? ?? const [];
    return ProviderConfig(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      adapter: json['adapter'] as String? ?? 'generic-http',
      baseUrl: json['baseURL'] as String? ?? '',
      authType: json['authType'] as String? ?? 'bearer',
      apiKeyMasked: json['apiKeyMasked'] as String? ?? '',
      apiKeySet: json['apiKeySet'] as bool? ?? false,
      headers: rawHeaders == null
          ? const {}
          : rawHeaders.map((k, v) => MapEntry(k, v.toString())),
      models: rawModels
          .whereType<Map<String, dynamic>>()
          .map(ModelConfig.fromJson)
          .toList(),
      enabled: json['enabled'] as bool? ?? true,
      builtIn: json['builtIn'] as bool? ?? false,
      createdAt: json['createdAt'] is String
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      updatedAt: json['updatedAt'] is String
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
    );
  }
}

class ProviderUpsertPayload {
  const ProviderUpsertPayload({
    this.id,
    required this.name,
    this.adapter = 'generic-http',
    required this.baseUrl,
    this.authType = 'bearer',
    this.apiKey = '',
    this.clearApiKey = false,
    this.headers = const {},
    this.models = const [],
    this.enabled = true,
  });

  final String? id;
  final String name;
  final String adapter;
  final String baseUrl;
  final String authType;
  final String apiKey;
  final bool clearApiKey;
  final Map<String, String> headers;
  final List<ModelConfig> models;
  final bool enabled;

  Map<String, dynamic> toJson() => {
        if (id != null && id!.isNotEmpty) 'id': id,
        'name': name,
        'adapter': adapter,
        'baseURL': baseUrl,
        'authType': authType,
        if (apiKey.isNotEmpty) 'apiKey': apiKey,
        if (clearApiKey) 'clearApiKey': true,
        'headers': headers,
        'models': models.map((m) => m.toJson()).toList(),
        'enabled': enabled,
      };
}
