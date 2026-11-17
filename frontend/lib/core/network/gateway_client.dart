import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../models/assistant.dart';
import '../models/content_block.dart';
import '../models/conversation.dart';
import '../models/message.dart';
import '../models/plugin_models.dart';
import '../models/provider.dart';
import '../models/stream_event.dart';

class GatewayException implements Exception {
  const GatewayException({
    required this.code,
    required this.message,
    this.statusCode,
  });

  final String code;
  final String message;
  final int? statusCode;

  @override
  String toString() => 'GatewayException($code, status=$statusCode): $message';
}

class ConversationDetail {
  const ConversationDetail({
    required this.conversation,
    required this.messages,
  });

  final Conversation conversation;
  final List<Message> messages;

  factory ConversationDetail.fromJson(Map<String, dynamic> json) {
    final rawMsgs = json['messages'] as List<dynamic>? ?? const [];
    return ConversationDetail(
      conversation: Conversation.fromJson(
        json['conversation'] as Map<String, dynamic>? ?? const {},
      ),
      messages: rawMsgs
          .whereType<Map<String, dynamic>>()
          .map(Message.fromJson)
          .toList(),
    );
  }
}

class SseFrame {
  const SseFrame({
    this.event = '',
    required this.data,
  });

  final String event;
  final String data;
}

/// Decodes chunked UTF-8 bytes into SSE frames delimited by blank lines (\n\n or \r\n\r\n).
Stream<SseFrame> decodeSseByteStream(Stream<List<int>> byteStream) async* {
  final lineBuffer = StringBuffer();
  var currentEvent = '';
  final dataLines = <String>[];

  SseFrame? flushFrame() {
    if (currentEvent.isEmpty && dataLines.isEmpty) {
      return null;
    }
    final frame = SseFrame(
      event: currentEvent,
      data: dataLines.join('\n'),
    );
    currentEvent = '';
    dataLines.clear();
    return frame;
  }

  SseFrame? handleLine(String rawLine) {
    final line = rawLine.endsWith('\r')
        ? rawLine.substring(0, rawLine.length - 1)
        : rawLine;
    if (line.isEmpty) {
      return flushFrame();
    }
    if (line.startsWith(':')) {
      return null;
    }
    final colonIdx = line.indexOf(':');
    if (colonIdx < 0) {
      return null;
    }
    final field = line.substring(0, colonIdx);
    var value = line.substring(colonIdx + 1);
    if (value.startsWith(' ')) {
      value = value.substring(1);
    }
    if (field == 'event') {
      currentEvent = value;
    } else if (field == 'data') {
      dataLines.add(value);
    }
    return null;
  }

  await for (final chunk in byteStream.transform(const Utf8Decoder(allowMalformed: true))) {
    var start = 0;
    while (true) {
      final nl = chunk.indexOf('\n', start);
      if (nl < 0) {
        lineBuffer.write(chunk.substring(start));
        break;
      }
      lineBuffer.write(chunk.substring(start, nl));
      final frame = handleLine(lineBuffer.toString());
      lineBuffer.clear();
      if (frame != null) {
        yield frame;
      }
      start = nl + 1;
    }
  }

  if (lineBuffer.isNotEmpty) {
    final frame = handleLine(lineBuffer.toString());
    lineBuffer.clear();
    if (frame != null) {
      yield frame;
    }
  }
  final trailing = flushFrame();
  if (trailing != null) {
    yield trailing;
  }
}

class GatewayClient {
  GatewayClient({
    required this.baseUrl,
    this.accessToken = '',
    http.Client? httpClient,
  }) : _client = httpClient ?? http.Client();

  String baseUrl;
  String accessToken;
  final http.Client _client;
  List<ProviderAdapterInfo> _lastLoadedAdapters = const [];

  void updateConfig({
    required String baseUrl,
    required String accessToken,
  }) {
    this.baseUrl = baseUrl;
    this.accessToken = accessToken;
  }

  Uri resolveUri(String path) {
    final cleanPath = path.startsWith('/') ? path.substring(1) : path;
    final trimmed = baseUrl.trim();
    if (trimmed.isEmpty || trimmed == '/') {
      if (kIsWeb && (Uri.base.scheme == 'http' || Uri.base.scheme == 'https')) {
        return Uri.base.resolve('/$cleanPath');
      }
      return Uri.parse('http://localhost:8080/$cleanPath');
    }
    final normalized = trimmed.endsWith('/') ? trimmed : '$trimmed/';
    return Uri.parse(normalized).resolve(cleanPath);
  }

  Map<String, String> _headers({bool includeJson = true}) {
    final out = <String, String>{};
    if (includeJson) {
      out['Content-Type'] = 'application/json';
    }
    final token = accessToken.trim();
    if (token.isNotEmpty) {
      out['Authorization'] = 'Bearer $token';
    }
    return out;
  }

  Future<Map<String, dynamic>> _sendJson(
    String method,
    String path, {
    Object? body,
    bool requireAuthHeaders = true,
  }) async {
    final req = http.Request(method, resolveUri(path));
    if (requireAuthHeaders) {
      req.headers.addAll(_headers(includeJson: body != null));
    } else if (body != null) {
      req.headers['Content-Type'] = 'application/json';
    }
    if (body != null) {
      req.body = jsonEncode(body);
    }

    final streamed = await _client.send(req);
    final resp = await http.Response.fromStream(streamed);
    if (resp.statusCode == 204) {
      return const {};
    }
    final decoded = _decodeMap(resp.body);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return decoded;
    }
    throw GatewayException(
      code: decoded['code'] as String? ?? 'HTTP_${resp.statusCode}',
      message: decoded['message'] as String? ?? 'Request failed (${resp.statusCode})',
      statusCode: resp.statusCode,
    );
  }

  Map<String, dynamic> _decodeMap(String raw) {
    if (raw.trim().isEmpty) return const {};
    try {
      final parsed = jsonDecode(raw);
      return parsed is Map<String, dynamic> ? parsed : const {};
    } catch (_) {
      return {'message': raw};
    }
  }

  Future<Map<String, dynamic>> healthCheck() async {
    return _sendJson('GET', '/healthz', requireAuthHeaders: false);
  }

  Future<List<FormatInfo>> listFormats() async {
    final data = await _sendJson('GET', '/api/v1/formats');
    final raw = data['formats'] as List<dynamic>? ?? const [];
    final rawAdapters = data['adapters'] as List<dynamic>? ?? const [];
    _lastLoadedAdapters = rawAdapters
        .whereType<Map<String, dynamic>>()
        .map(ProviderAdapterInfo.fromJson)
        .toList();
    return raw
        .whereType<Map<String, dynamic>>()
        .map(FormatInfo.fromJson)
        .toList();
  }

  Future<({List<FormatInfo> formats, List<ProviderAdapterInfo> adapters})>
      listFormatsAndAdapters() async {
    final formats = await listFormats();
    return (formats: formats, adapters: _lastLoadedAdapters);
  }

  Future<List<ProviderConfig>> listProviders() async {
    final data = await _sendJson('GET', '/api/v1/providers');
    final raw = data['providers'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(ProviderConfig.fromJson)
        .toList();
  }

  Future<ProviderConfig> createProvider(ProviderUpsertPayload payload) async {
    final data = await _sendJson('POST', '/api/v1/providers', body: payload.toJson());
    return ProviderConfig.fromJson(data['provider'] as Map<String, dynamic>);
  }

  Future<ProviderConfig> updateProvider(
    String id,
    ProviderUpsertPayload payload,
  ) async {
    final data = await _sendJson(
      'PUT',
      '/api/v1/providers/$id',
      body: payload.toJson(),
    );
    return ProviderConfig.fromJson(data['provider'] as Map<String, dynamic>);
  }

  Future<void> deleteProvider(String id) async {
    await _sendJson('DELETE', '/api/v1/providers/$id');
  }

  Future<ProviderConnectionTestResult> testProviderConnection(
    String id, {
    String? baseUrl,
    String? authType,
    String? apiKey,
    Map<String, String>? headers,
  }) async {
    final body = <String, dynamic>{
      if (baseUrl != null && baseUrl.isNotEmpty) 'baseURL': baseUrl,
      if (authType != null && authType.isNotEmpty) 'authType': authType,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      'headers': ?headers,
    };
    final data = await _sendJson(
      'POST',
      '/api/v1/providers/$id/test',
      body: body,
    );
    return ProviderConnectionTestResult.fromJson(data);
  }

  Future<List<DiscoveredModel>> fetchProviderModels(
    String id, {
    String? baseUrl,
    String? authType,
    String? apiKey,
    Map<String, String>? headers,
  }) async {
    final body = <String, dynamic>{
      if (baseUrl != null && baseUrl.isNotEmpty) 'baseURL': baseUrl,
      if (authType != null && authType.isNotEmpty) 'authType': authType,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      'headers': ?headers,
    };
    final data = await _sendJson(
      'POST',
      '/api/v1/providers/$id/models/fetch',
      body: body,
    );
    final raw = data['models'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(DiscoveredModel.fromJson)
        .toList();
  }

  Future<List<Assistant>> listAssistants() async {
    final data = await _sendJson('GET', '/api/v1/assistants');
    final raw = data['assistants'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(Assistant.fromJson)
        .toList();
  }

  Future<Assistant> createAssistant(AssistantUpsertPayload payload) async {
    final data = await _sendJson(
      'POST',
      '/api/v1/assistants',
      body: payload.toJson(),
    );
    return Assistant.fromJson(data['assistant'] as Map<String, dynamic>);
  }

  Future<Assistant> updateAssistant(
    String id,
    AssistantUpsertPayload payload,
  ) async {
    final data = await _sendJson(
      'PUT',
      '/api/v1/assistants/$id',
      body: payload.toJson(),
    );
    return Assistant.fromJson(data['assistant'] as Map<String, dynamic>);
  }

  Future<void> deleteAssistant(String id) async {
    await _sendJson('DELETE', '/api/v1/assistants/$id');
  }

  Future<List<Conversation>> listConversations() async {
    final data = await _sendJson('GET', '/api/v1/conversations');
    final raw = data['conversations'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(Conversation.fromJson)
        .toList();
  }

  Future<Conversation> createConversation({
    String assistantId = 'default',
    String title = '',
    String providerId = '',
    String modelId = '',
    String systemPrompt = '',
    GenerationParams? params,
  }) async {
    final data = await _sendJson('POST', '/api/v1/conversations', body: {
      if (assistantId.isNotEmpty) 'assistantId': assistantId,
      if (title.isNotEmpty) 'title': title,
      if (providerId.isNotEmpty) 'providerId': providerId,
      if (modelId.isNotEmpty) 'modelId': modelId,
      if (systemPrompt.isNotEmpty) 'systemPrompt': systemPrompt,
      if (params != null && params.toJson().isNotEmpty) 'params': params.toJson(),
    });
    return Conversation.fromJson(data['conversation'] as Map<String, dynamic>);
  }

  Future<ConversationDetail> getConversationDetail(String id) async {
    final data = await _sendJson('GET', '/api/v1/conversations/$id');
    return ConversationDetail.fromJson(data);
  }

  Future<Conversation> patchConversation(
    String id, {
    String? assistantId,
    String? title,
    String? providerId,
    String? modelId,
    String? systemPrompt,
    GenerationParams? params,
    bool clearNullParams = false,
    bool? syncEnabled,
  }) async {
    final body = <String, dynamic>{
      'assistantId': ?assistantId,
      'title': ?title,
      'providerId': ?providerId,
      'modelId': ?modelId,
      'systemPrompt': ?systemPrompt,
      if (params != null) 'params': params.toJson(includeNulls: clearNullParams),
      'syncEnabled': ?syncEnabled,
    };
    final data = await _sendJson(
      'PATCH',
      '/api/v1/conversations/$id',
      body: body,
    );
    return Conversation.fromJson(data['conversation'] as Map<String, dynamic>);
  }

  Future<void> deleteConversation(String id) async {
    await _sendJson('DELETE', '/api/v1/conversations/$id');
  }

  Future<void> deleteMessage(String conversationId, String messageId) async {
    await _sendJson(
      'DELETE',
      '/api/v1/conversations/$conversationId/messages/$messageId',
    );
  }

  Future<ConversationDetail> branchConversation(
    String conversationId,
    String messageId,
  ) async {
    final data = await _sendJson(
      'POST',
      '/api/v1/conversations/$conversationId/messages/$messageId/branch',
      body: const {},
    );
    return ConversationDetail.fromJson(data);
  }

  Future<List<SearchEnginePluginConfig>> listSearchEngines() async {
    final data = await _sendJson('GET', '/api/v1/plugins/search');
    final raw = data['engines'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(SearchEnginePluginConfig.fromJson)
        .toList();
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
    final body = <String, dynamic>{
      'enabled': ?enabled,
      'endpoint': ?endpoint,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      if (clearApiKey) 'clearApiKey': true,
      'maxResults': ?maxResults,
      'isDefault': ?isDefault,
    };
    final data = await _sendJson(
      'PUT',
      '/api/v1/plugins/search/$id',
      body: body,
    );
    return SearchEnginePluginConfig.fromJson(
      data['engine'] as Map<String, dynamic>,
    );
  }

  Future<SearchEngineTestResult> testSearchEngine(
    String id, {
    String? query,
    String? endpoint,
    String? apiKey,
    int? maxResults,
  }) async {
    final body = <String, dynamic>{
      if (query != null && query.isNotEmpty) 'query': query,
      if (endpoint != null && endpoint.isNotEmpty) 'endpoint': endpoint,
      if (apiKey != null && apiKey.isNotEmpty) 'apiKey': apiKey,
      'maxResults': ?maxResults,
    };
    final data = await _sendJson(
      'POST',
      '/api/v1/plugins/search/$id/test',
      body: body,
    );
    return SearchEngineTestResult.fromJson(data);
  }

  Future<List<McpServerConfig>> listMcpServers() async {
    final data = await _sendJson('GET', '/api/v1/mcp/servers');
    final raw = data['servers'] as List<dynamic>? ?? const [];
    return raw
        .whereType<Map<String, dynamic>>()
        .map(McpServerConfig.fromJson)
        .toList();
  }

  Future<McpServerConfig> createMcpServer(
    McpServerUpsertPayload payload,
  ) async {
    final data = await _sendJson(
      'POST',
      '/api/v1/mcp/servers',
      body: payload.toJson(),
    );
    return McpServerConfig.fromJson(data['server'] as Map<String, dynamic>);
  }

  Future<McpServerConfig> updateMcpServer(
    String id,
    McpServerUpsertPayload payload,
  ) async {
    final data = await _sendJson(
      'PUT',
      '/api/v1/mcp/servers/$id',
      body: payload.toJson(),
    );
    return McpServerConfig.fromJson(data['server'] as Map<String, dynamic>);
  }

  Future<void> deleteMcpServer(String id) async {
    await _sendJson('DELETE', '/api/v1/mcp/servers/$id');
  }

  /// Streams chat events from the gateway and aborts the underlying HTTP request
  /// (fetch AbortController on Web) when [abortTrigger] completes.
  Stream<StreamEvent> streamChat({
    required String conversationId,
    List<ContentBlock>? blocks,
    String? text,
    String? providerId,
    String? modelId,
    GenerationParams? params,
    String? regenerateMessageId,
    bool webSearch = false,
    String? searchEngineId,
    Future<void>? abortTrigger,
  }) async* {
    final req = http.AbortableRequest(
      'POST',
      resolveUri('/api/v1/conversations/$conversationId/messages/stream'),
      abortTrigger: abortTrigger,
    );
    req.headers.addAll(_headers(includeJson: true));
    req.headers['Accept'] = 'text/event-stream';
    req.body = jsonEncode({
      if (blocks != null && blocks.isNotEmpty)
        'blocks': blocks.map((b) => b.toJson()).toList()
      else if (text != null && text.isNotEmpty)
        'text': text,
      if (providerId != null && providerId.isNotEmpty) 'providerId': providerId,
      if (modelId != null && modelId.isNotEmpty) 'modelId': modelId,
      if (params != null && params.toJson().isNotEmpty) 'params': params.toJson(),
      if (regenerateMessageId != null && regenerateMessageId.isNotEmpty)
        'regenerateMessageId': regenerateMessageId,
      if (webSearch) 'webSearch': true,
      if (searchEngineId != null && searchEngineId.isNotEmpty)
        'searchEngineId': searchEngineId,
    });

    final streamed = await _client.send(req);
    if (streamed.statusCode < 200 || streamed.statusCode >= 300) {
      final rawErr = await streamed.stream.bytesToString();
      final decoded = _decodeMap(rawErr);
      throw GatewayException(
        code: decoded['code'] as String? ?? 'HTTP_${streamed.statusCode}',
        message: decoded['message'] as String? ??
            'Stream failed (${streamed.statusCode})',
        statusCode: streamed.statusCode,
      );
    }

    await for (final frame in decodeSseByteStream(streamed.stream)) {
      final data = frame.data.trim();
      if (data.isEmpty || data == '[DONE]') continue;
      final parsed = jsonDecode(data);
      if (parsed is Map<String, dynamic>) {
        yield StreamEvent.fromJson(parsed);
      }
    }
  }
}
