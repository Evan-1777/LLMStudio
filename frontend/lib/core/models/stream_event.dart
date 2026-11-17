import 'content_block.dart';
import 'message.dart';

class StreamError {
  const StreamError({
    required this.code,
    required this.message,
  });

  final String code;
  final String message;

  factory StreamError.fromJson(Map<String, dynamic> json) {
    return StreamError(
      code: json['code'] as String? ?? 'UPSTREAM_ERROR',
      message: json['message'] as String? ?? 'Upstream error',
    );
  }
}

class StreamEvent {
  const StreamEvent({
    required this.type,
    this.conversationId = '',
    this.messageId = '',
    this.providerId = '',
    this.modelId = '',
    this.index,
    this.blockType = '',
    this.deltaType = '',
    this.delta = '',
    this.block,
    this.usage,
    this.stopReason = '',
    this.message,
    this.error,
  });

  final String type;
  final String conversationId;
  final String messageId;
  final String providerId;
  final String modelId;
  final int? index;
  final String blockType;
  final String deltaType;
  final String delta;
  final ContentBlock? block;
  final TokenUsage? usage;
  final String stopReason;
  final Message? message;
  final StreamError? error;

  factory StreamEvent.fromJson(Map<String, dynamic> json) {
    return StreamEvent(
      type: json['type'] as String? ?? '',
      conversationId: json['conversationId'] as String? ?? '',
      messageId: json['messageId'] as String? ?? '',
      providerId: json['providerId'] as String? ?? '',
      modelId: json['modelId'] as String? ?? '',
      index: (json['index'] as num?)?.toInt(),
      blockType: json['blockType'] as String? ?? '',
      deltaType: json['deltaType'] as String? ?? '',
      delta: json['delta'] as String? ?? '',
      block: json['block'] is Map<String, dynamic>
          ? ContentBlock.fromJson(json['block'] as Map<String, dynamic>)
          : null,
      usage: json['usage'] is Map<String, dynamic>
          ? TokenUsage.fromJson(json['usage'] as Map<String, dynamic>)
          : null,
      stopReason: json['stopReason'] as String? ?? '',
      message: json['message'] is Map<String, dynamic>
          ? Message.fromJson(json['message'] as Map<String, dynamic>)
          : null,
      error: json['error'] is Map<String, dynamic>
          ? StreamError.fromJson(json['error'] as Map<String, dynamic>)
          : null,
    );
  }
}
