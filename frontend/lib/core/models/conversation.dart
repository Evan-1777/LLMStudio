class GenerationParams {
  const GenerationParams({
    this.temperature,
    this.maxTokens,
    this.reasoningEffort = '',
  });

  final double? temperature;
  final int? maxTokens;
  final String reasoningEffort;

  GenerationParams copyWith({
    double? Function()? temperature,
    int? Function()? maxTokens,
    String? reasoningEffort,
  }) {
    return GenerationParams(
      temperature: temperature != null ? temperature() : this.temperature,
      maxTokens: maxTokens != null ? maxTokens() : this.maxTokens,
      reasoningEffort: reasoningEffort ?? this.reasoningEffort,
    );
  }

  factory GenerationParams.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const GenerationParams();
    return GenerationParams(
      temperature: (json['temperature'] as num?)?.toDouble(),
      maxTokens: (json['maxTokens'] as num?)?.toInt(),
      reasoningEffort: json['reasoningEffort'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson({bool includeNulls = false}) {
    if (includeNulls) {
      return {
        'temperature': temperature,
        'maxTokens': maxTokens,
        'reasoningEffort': reasoningEffort,
      };
    }
    return {
      if (temperature != null) 'temperature': temperature,
      if (maxTokens != null) 'maxTokens': maxTokens,
      if (reasoningEffort.isNotEmpty) 'reasoningEffort': reasoningEffort,
    };
  }
}

class Conversation {
  const Conversation({
    required this.id,
    required this.title,
    this.providerId = '',
    this.modelId = '',
    this.systemPrompt = '',
    this.params = const GenerationParams(),
    this.syncEnabled = false,
    this.syncState = 'local_only',
    this.syncVersion = 0,
    this.lastSyncedAt,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String title;
  final String providerId;
  final String modelId;
  final String systemPrompt;
  final GenerationParams params;
  final bool syncEnabled;
  final String syncState;
  final int syncVersion;
  final DateTime? lastSyncedAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  Conversation copyWith({
    String? id,
    String? title,
    String? providerId,
    String? modelId,
    String? systemPrompt,
    GenerationParams? params,
    bool? syncEnabled,
    String? syncState,
    int? syncVersion,
    DateTime? lastSyncedAt,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Conversation(
      id: id ?? this.id,
      title: title ?? this.title,
      providerId: providerId ?? this.providerId,
      modelId: modelId ?? this.modelId,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      params: params ?? this.params,
      syncEnabled: syncEnabled ?? this.syncEnabled,
      syncState: syncState ?? this.syncState,
      syncVersion: syncVersion ?? this.syncVersion,
      lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  factory Conversation.fromJson(Map<String, dynamic> json) {
    return Conversation(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? 'New Chat',
      providerId: json['providerId'] as String? ?? '',
      modelId: json['modelId'] as String? ?? '',
      systemPrompt: json['systemPrompt'] as String? ?? '',
      params: GenerationParams.fromJson(
        json['params'] as Map<String, dynamic>?,
      ),
      syncEnabled: json['syncEnabled'] as bool? ?? false,
      syncState: json['syncState'] as String? ?? 'local_only',
      syncVersion: (json['syncVersion'] as num?)?.toInt() ?? 0,
      lastSyncedAt: json['lastSyncedAt'] is String
          ? DateTime.tryParse(json['lastSyncedAt'] as String)
          : null,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }
}
