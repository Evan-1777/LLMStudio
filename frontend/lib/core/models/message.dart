import 'content_block.dart';

class TokenUsage {
  const TokenUsage({
    this.inputTokens = 0,
    this.outputTokens = 0,
    this.thinkingTokens = 0,
    this.totalTokens = 0,
  });

  final int inputTokens;
  final int outputTokens;
  final int thinkingTokens;
  final int totalTokens;

  factory TokenUsage.fromJson(Map<String, dynamic> json) {
    return TokenUsage(
      inputTokens: (json['inputTokens'] as num?)?.toInt() ?? 0,
      outputTokens: (json['outputTokens'] as num?)?.toInt() ?? 0,
      thinkingTokens: (json['thinkingTokens'] as num?)?.toInt() ?? 0,
      totalTokens: (json['totalTokens'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'inputTokens': inputTokens,
        'outputTokens': outputTokens,
        if (thinkingTokens > 0) 'thinkingTokens': thinkingTokens,
        'totalTokens': totalTokens,
      };
}

class Message {
  const Message({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.blocks,
    this.providerId = '',
    this.modelId = '',
    this.usage,
    this.stopReason = '',
    this.errorMessage = '',
    required this.createdAt,
  });

  final String id;
  final String conversationId;
  final String role;
  final List<ContentBlock> blocks;
  final String providerId;
  final String modelId;
  final TokenUsage? usage;
  final String stopReason;
  final String errorMessage;
  final DateTime createdAt;

  String get plainText => blocks
      .whereType<TextBlock>()
      .map((b) => b.text)
      .where((t) => t.isNotEmpty)
      .join('\n\n');

  Message copyWith({
    String? id,
    String? conversationId,
    String? role,
    List<ContentBlock>? blocks,
    String? providerId,
    String? modelId,
    TokenUsage? usage,
    String? stopReason,
    String? errorMessage,
    DateTime? createdAt,
  }) {
    return Message(
      id: id ?? this.id,
      conversationId: conversationId ?? this.conversationId,
      role: role ?? this.role,
      blocks: blocks ?? this.blocks,
      providerId: providerId ?? this.providerId,
      modelId: modelId ?? this.modelId,
      usage: usage ?? this.usage,
      stopReason: stopReason ?? this.stopReason,
      errorMessage: errorMessage ?? this.errorMessage,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  factory Message.fromJson(Map<String, dynamic> json) {
    final rawBlocks = (json['blocks'] as List<dynamic>?) ?? const [];
    return Message(
      id: json['id'] as String? ?? '',
      conversationId: json['conversationId'] as String? ?? '',
      role: json['role'] as String? ?? 'user',
      blocks: rawBlocks
          .whereType<Map<String, dynamic>>()
          .map(ContentBlock.fromJson)
          .toList(),
      providerId: json['providerId'] as String? ?? '',
      modelId: json['modelId'] as String? ?? '',
      usage: json['usage'] is Map<String, dynamic>
          ? TokenUsage.fromJson(json['usage'] as Map<String, dynamic>)
          : null,
      stopReason: json['stopReason'] as String? ?? '',
      errorMessage: json['errorMessage'] as String? ?? '',
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'conversationId': conversationId,
        'role': role,
        'blocks': blocks.map((b) => b.toJson()).toList(),
        if (providerId.isNotEmpty) 'providerId': providerId,
        if (modelId.isNotEmpty) 'modelId': modelId,
        if (usage != null) 'usage': usage!.toJson(),
        if (stopReason.isNotEmpty) 'stopReason': stopReason,
        if (errorMessage.isNotEmpty) 'errorMessage': errorMessage,
        'createdAt': createdAt.toUtc().toIso8601String(),
      };
}
