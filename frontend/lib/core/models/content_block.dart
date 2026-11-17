import 'dart:convert';

/// Unified multimodal and reserved agent content block aligned with the backend wire schema.
sealed class ContentBlock {
  const ContentBlock();

  String get type;

  Map<String, dynamic> toJson();

  factory ContentBlock.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String? ?? '';
    switch (type) {
      case 'text':
        return TextBlock(json['text'] as String? ?? '');
      case 'thinking':
        return ThinkingBlock(
          json['thinking'] as String? ?? '',
          signature: json['signature'] as String? ?? '',
        );
      case 'image':
        return ImageBlock(
          mimeType: json['mimeType'] as String? ?? '',
          url: json['url'] as String? ?? '',
          data: json['data'] as String? ?? '',
        );
      case 'toolCall':
        return ToolCallBlock(
          id: json['id'] as String? ?? '',
          name: json['name'] as String? ?? '',
          arguments: json['arguments'],
        );
      case 'toolResult':
        return ToolResultBlock(
          toolCallId: json['toolCallId'] as String? ?? '',
          toolName: json['toolName'] as String? ?? '',
          content: json['content'] as String? ?? '',
          isError: json['isError'] as bool? ?? false,
        );
      default:
        return ExtensionBlock(
          type: type,
          extra: json['extra'] ?? _remainingFields(json),
        );
    }
  }

  static Map<String, dynamic>? _remainingFields(Map<String, dynamic> json) {
    final copy = Map<String, dynamic>.from(json)..remove('type');
    return copy.isEmpty ? null : copy;
  }
}

final class TextBlock extends ContentBlock {
  const TextBlock(this.text);

  final String text;

  @override
  String get type => 'text';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'text': text,
      };
}

final class ThinkingBlock extends ContentBlock {
  const ThinkingBlock(this.thinking, {this.signature = ''});

  final String thinking;
  final String signature;

  @override
  String get type => 'thinking';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'thinking': thinking,
        if (signature.isNotEmpty) 'signature': signature,
      };
}

final class ImageBlock extends ContentBlock {
  const ImageBlock({
    this.mimeType = '',
    this.url = '',
    this.data = '',
  });

  final String mimeType;
  final String url;
  final String data;

  @override
  String get type => 'image';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        if (mimeType.isNotEmpty) 'mimeType': mimeType,
        if (url.isNotEmpty) 'url': url,
        if (data.isNotEmpty) 'data': data,
      };
}

final class ToolCallBlock extends ContentBlock {
  const ToolCallBlock({
    required this.id,
    required this.name,
    this.arguments,
  });

  final String id;
  final String name;
  final Object? arguments;

  @override
  String get type => 'toolCall';

  String get formattedArguments {
    if (arguments == null) return '{}';
    if (arguments is String) return arguments as String;
    return const JsonEncoder.withIndent('  ').convert(arguments);
  }

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'id': id,
        'name': name,
        if (arguments != null) 'arguments': arguments,
      };
}

final class ToolResultBlock extends ContentBlock {
  const ToolResultBlock({
    required this.toolCallId,
    this.toolName = '',
    this.content = '',
    this.isError = false,
  });

  final String toolCallId;
  final String toolName;
  final String content;
  final bool isError;

  @override
  String get type => 'toolResult';

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        'toolCallId': toolCallId,
        if (toolName.isNotEmpty) 'toolName': toolName,
        'content': content,
        if (isError) 'isError': true,
      };
}

final class ExtensionBlock extends ContentBlock {
  const ExtensionBlock({
    required this.type,
    this.extra,
  });

  @override
  final String type;
  final Object? extra;

  @override
  Map<String, dynamic> toJson() => {
        'type': type,
        if (extra != null) 'extra': extra,
      };
}
