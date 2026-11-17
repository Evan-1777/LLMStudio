import 'conversation.dart';

class Assistant {
  const Assistant({
    required this.id,
    required this.name,
    this.systemPrompt = '',
    this.defaultProviderId = '',
    this.defaultModelId = '',
    this.params = const GenerationParams(),
    this.isDefault = false,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String name;
  final String systemPrompt;
  final String defaultProviderId;
  final String defaultModelId;
  final GenerationParams params;
  final bool isDefault;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  Assistant copyWith({
    String? id,
    String? name,
    String? systemPrompt,
    String? defaultProviderId,
    String? defaultModelId,
    GenerationParams? params,
    bool? isDefault,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Assistant(
      id: id ?? this.id,
      name: name ?? this.name,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      defaultProviderId: defaultProviderId ?? this.defaultProviderId,
      defaultModelId: defaultModelId ?? this.defaultModelId,
      params: params ?? this.params,
      isDefault: isDefault ?? this.isDefault,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  factory Assistant.fromJson(Map<String, dynamic> json) {
    return Assistant(
      id: json['id'] as String? ?? '',
      name: json['name'] as String? ?? '',
      systemPrompt: json['systemPrompt'] as String? ?? '',
      defaultProviderId: json['defaultProviderId'] as String? ?? '',
      defaultModelId: json['defaultModelId'] as String? ?? '',
      params: GenerationParams.fromJson(
        json['params'] as Map<String, dynamic>?,
      ),
      isDefault: json['isDefault'] as bool? ?? false,
      createdAt: json['createdAt'] is String
          ? DateTime.tryParse(json['createdAt'] as String)
          : null,
      updatedAt: json['updatedAt'] is String
          ? DateTime.tryParse(json['updatedAt'] as String)
          : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        if (systemPrompt.isNotEmpty) 'systemPrompt': systemPrompt,
        if (defaultProviderId.isNotEmpty)
          'defaultProviderId': defaultProviderId,
        if (defaultModelId.isNotEmpty) 'defaultModelId': defaultModelId,
        'params': params.toJson(),
        'isDefault': isDefault,
        if (createdAt != null) 'createdAt': createdAt!.toUtc().toIso8601String(),
        if (updatedAt != null) 'updatedAt': updatedAt!.toUtc().toIso8601String(),
      };
}

class AssistantUpsertPayload {
  const AssistantUpsertPayload({
    this.id,
    required this.name,
    this.systemPrompt = '',
    this.defaultProviderId = '',
    this.defaultModelId = '',
    this.params = const GenerationParams(),
  });

  final String? id;
  final String name;
  final String systemPrompt;
  final String defaultProviderId;
  final String defaultModelId;
  final GenerationParams params;

  Map<String, dynamic> toJson() => {
        if (id != null && id!.isNotEmpty) 'id': id,
        'name': name,
        'systemPrompt': systemPrompt,
        'defaultProviderId': defaultProviderId,
        'defaultModelId': defaultModelId,
        'params': params.toJson(),
      };
}
