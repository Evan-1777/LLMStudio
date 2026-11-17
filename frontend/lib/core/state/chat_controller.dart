import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../models/content_block.dart';
import '../models/conversation.dart';
import '../models/message.dart';
import '../models/plugin_models.dart';
import '../models/stream_event.dart';
import '../network/gateway_client.dart';

/// Five-state conversation lifecycle plus empty initial state.
enum ChatRunState {
  empty,
  idle,
  loading,
  streaming,
  aborted,
  error,
}

class ChatController extends ChangeNotifier {
  static const List<String> reasoningEffortLevels = [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];

  ChatController({
    required this.gateway,
    this.onConversationUpdated,
  });

  final GatewayClient gateway;
  final void Function(Conversation conversation)? onConversationUpdated;

  Conversation? _conversation;
  List<Message> _messages = const [];
  ChatRunState _runState = ChatRunState.empty;
  String? _errorCode;
  String? _errorMessage;
  String _reasoningEffort = 'none';

  Completer<void>? _abortCompleter;
  bool _manualAbort = false;
  int _generationEpoch = 0;

  List<ContentBlock>? _pendingSendBlocks;
  String? _pendingSendText;
  String? _pendingProviderId;
  String? _pendingModelId;
  String? _pendingRegenerateId;
  bool _pendingWebSearch = false;
  String? _pendingSearchEngineId;

  Conversation? get conversation => _conversation;
  List<Message> get messages => _messages;
  ChatRunState get runState => _runState;
  String? get errorCode => _errorCode;
  String? get errorMessage => _errorMessage;
  String get reasoningEffort => _reasoningEffort;
  bool get isBusy =>
      _runState == ChatRunState.loading || _runState == ChatRunState.streaming;

  void setReasoningEffort(String effort) {
    final normalized = reasoningEffortLevels.contains(effort) ? effort : 'none';
    if (_reasoningEffort == normalized) return;
    _reasoningEffort = normalized;
    notifyListeners();
  }

  void clearSession() {
    _cancelActiveRequest(quiet: true);
    _conversation = null;
    _messages = const [];
    _errorCode = null;
    _errorMessage = null;
    _pendingSendBlocks = null;
    _pendingSendText = null;
    _pendingRegenerateId = null;
    _pendingWebSearch = false;
    _pendingSearchEngineId = null;
    _runState = ChatRunState.empty;
    notifyListeners();
  }

  Future<void> loadConversation(String conversationId) async {
    _cancelActiveRequest(quiet: true);
    final epoch = ++_generationEpoch;

    _errorCode = null;
    _errorMessage = null;
    _pendingSendBlocks = null;
    _pendingSendText = null;
    _pendingRegenerateId = null;
    _pendingWebSearch = false;
    _pendingSearchEngineId = null;
    _messages = const [];
    _runState = ChatRunState.loading;
    notifyListeners();

    try {
      final detail = await gateway.getConversationDetail(conversationId);
      if (epoch != _generationEpoch) return;
      _conversation = detail.conversation;
      _messages = detail.messages;
      final convEffort = detail.conversation.params.reasoningEffort;
      if (reasoningEffortLevels.contains(convEffort)) {
        _reasoningEffort = convEffort;
      }
      _runState = _deriveRestState(_messages);
      onConversationUpdated?.call(detail.conversation);
      notifyListeners();
    } catch (e) {
      if (epoch != _generationEpoch) return;
      _setError(e);
    }
  }

  GenerationParams _effectiveParams(GenerationParams? params) {
    final base = params ?? const GenerationParams();
    final effort = base.reasoningEffort.isNotEmpty
        ? base.reasoningEffort
        : _reasoningEffort;
    return base.copyWith(reasoningEffort: effort);
  }

  Future<void> sendMessage(
    String text, {
    required String providerId,
    required String modelId,
    GenerationParams? params,
    List<ComposerAttachment> attachments = const [],
    bool webSearch = false,
    String? searchEngineId,
  }) async {
    final trimmed = text.trim();
    if ((trimmed.isEmpty && attachments.isEmpty) ||
        _conversation == null ||
        isBusy) {
      return;
    }

    final conv = _conversation!;
    final blocks = <ContentBlock>[
      for (final att in attachments) att.toContentBlock(),
      if (trimmed.isNotEmpty) TextBlock(trimmed),
    ];

    final optimisticUser = Message(
      id: 'local-user-${DateTime.now().microsecondsSinceEpoch}',
      conversationId: conv.id,
      role: 'user',
      blocks: blocks,
      createdAt: DateTime.now().toUtc(),
    );

    _messages = [..._messages, optimisticUser];
    _pendingSendBlocks = blocks;
    _pendingSendText = trimmed;
    _pendingProviderId = providerId;
    _pendingModelId = modelId;
    _pendingRegenerateId = null;
    _pendingWebSearch = webSearch;
    _pendingSearchEngineId = searchEngineId;

    await _runStream(
      conversationId: conv.id,
      blocks: blocks,
      text: trimmed,
      providerId: providerId,
      modelId: modelId,
      params: _effectiveParams(params),
      webSearch: webSearch,
      searchEngineId: searchEngineId,
    );
  }

  Future<void> regenerate(
    String targetMessageId, {
    required String providerId,
    required String modelId,
    GenerationParams? params,
    bool webSearch = false,
    String? searchEngineId,
  }) async {
    if (_conversation == null || isBusy) return;
    final conv = _conversation!;
    final idx = _messages.indexWhere((m) => m.id == targetMessageId);
    if (idx < 0) return;

    final target = _messages[idx];
    _messages = target.role == 'user'
        ? _messages.sublist(0, idx + 1)
        : _messages.sublist(0, idx);
    _pendingSendBlocks = null;
    _pendingSendText = null;
    _pendingProviderId = providerId;
    _pendingModelId = modelId;
    _pendingRegenerateId = targetMessageId;
    _pendingWebSearch = webSearch;
    _pendingSearchEngineId = searchEngineId;

    await _runStream(
      conversationId: conv.id,
      providerId: providerId,
      modelId: modelId,
      params: _effectiveParams(params),
      regenerateMessageId: targetMessageId,
      webSearch: webSearch,
      searchEngineId: searchEngineId,
    );
  }

  Future<void> retryMessage(
    String messageId, {
    required String providerId,
    required String modelId,
    GenerationParams? params,
    bool webSearch = false,
    String? searchEngineId,
  }) async {
    if (_conversation == null || isBusy) return;
    final idx = _messages.indexWhere((m) => m.id == messageId);
    if (idx < 0) return;
    final msg = _messages[idx];
    if (msg.role == 'user' &&
        idx + 1 < _messages.length &&
        _messages[idx + 1].role == 'assistant' &&
        !_messages[idx + 1].id.startsWith('local-')) {
      await regenerate(
        _messages[idx + 1].id,
        providerId: providerId,
        modelId: modelId,
        params: params,
        webSearch: webSearch,
        searchEngineId: searchEngineId,
      );
      return;
    }
    if (msg.id.startsWith('local-')) {
      await retry(
        providerId: providerId,
        modelId: modelId,
        params: params,
      );
      return;
    }
    await regenerate(
      messageId,
      providerId: providerId,
      modelId: modelId,
      params: params,
      webSearch: webSearch,
      searchEngineId: searchEngineId,
    );
  }

  Future<void> deleteMessage(String messageId) async {
    if (_conversation == null || isBusy) return;
    if (!messageId.startsWith('local-')) {
      await gateway.deleteMessage(_conversation!.id, messageId);
    }
    _messages = _messages.where((m) => m.id != messageId).toList();
    _runState = _deriveRestState(_messages);
    notifyListeners();
  }

  void applyBranchedDetail(ConversationDetail detail) {
    _cancelActiveRequest(quiet: true);
    _conversation = detail.conversation;
    _messages = detail.messages;
    _errorCode = null;
    _errorMessage = null;
    _pendingSendBlocks = null;
    _pendingSendText = null;
    _pendingRegenerateId = null;
    _runState = _deriveRestState(_messages);
    notifyListeners();
  }

  Future<void> retry({
    String? providerId,
    String? modelId,
    GenerationParams? params,
  }) async {
    if (_conversation == null || isBusy) return;
    final pId = providerId ?? _pendingProviderId ?? _conversation!.providerId;
    final mId = modelId ?? _pendingModelId ?? _conversation!.modelId;

    if (_messages.isNotEmpty) {
      final last = _messages.last;
      if (last.role == 'assistant' &&
          (last.stopReason == 'error' || last.stopReason == 'aborted') &&
          !last.id.startsWith('local-')) {
        await regenerate(
          last.id,
          providerId: pId,
          modelId: mId,
          params: params,
          webSearch: _pendingWebSearch,
          searchEngineId: _pendingSearchEngineId,
        );
        return;
      }
    }

    if (_pendingRegenerateId != null) {
      await _runStream(
        conversationId: _conversation!.id,
        providerId: pId,
        modelId: mId,
        params: _effectiveParams(params),
        regenerateMessageId: _pendingRegenerateId,
        webSearch: _pendingWebSearch,
        searchEngineId: _pendingSearchEngineId,
      );
      return;
    }

    final retryBlocks = _pendingSendBlocks;
    final retryText = _pendingSendText;
    if ((retryBlocks != null && retryBlocks.isNotEmpty) ||
        (retryText != null && retryText.isNotEmpty)) {
      await _runStream(
        conversationId: _conversation!.id,
        blocks: retryBlocks,
        text: retryText,
        providerId: pId,
        modelId: mId,
        params: _effectiveParams(params),
        webSearch: _pendingWebSearch,
        searchEngineId: _pendingSearchEngineId,
      );
    }
  }

  void stopStreaming() {
    if (!isBusy || _abortCompleter == null) return;
    _manualAbort = true;
    if (!_abortCompleter!.isCompleted) {
      _abortCompleter!.complete();
    }
    _finalizeAbortedInMemory();
  }

  void _cancelActiveRequest({required bool quiet}) {
    _generationEpoch++;
    if (_abortCompleter != null && !_abortCompleter!.isCompleted) {
      _manualAbort = !quiet;
      _abortCompleter!.complete();
    }
    _abortCompleter = null;
  }

  void _finalizeAbortedInMemory() {
    if (_messages.isNotEmpty && _messages.last.role == 'assistant') {
      final last = _messages.last;
      _messages = [
        ..._messages.sublist(0, _messages.length - 1),
        last.copyWith(stopReason: 'aborted'),
      ];
    }
    _runState = ChatRunState.aborted;
    notifyListeners();
  }

  Future<void> _runStream({
    required String conversationId,
    List<ContentBlock>? blocks,
    String? text,
    required String providerId,
    required String modelId,
    GenerationParams? params,
    String? regenerateMessageId,
    bool webSearch = false,
    String? searchEngineId,
  }) async {
    final epoch = ++_generationEpoch;
    final abortCompleter = Completer<void>();
    _abortCompleter = abortCompleter;
    _manualAbort = false;
    _errorCode = null;
    _errorMessage = null;
    _runState = ChatRunState.loading;
    notifyListeners();

    final blockBuffers = <int, _StreamingBlockBuffer>{};
    final blockOrder = <int>[];
    var assistantIndex = -1;
    var receivedMessageEnd = false;

    void ensureAssistantMessage(StreamEvent ev) {
      if (assistantIndex >= 0) return;
      final assistant = Message(
        id: ev.messageId.isNotEmpty
            ? ev.messageId
            : 'local-assistant-${DateTime.now().microsecondsSinceEpoch}',
        conversationId: conversationId,
        role: 'assistant',
        blocks: const [],
        providerId: ev.providerId.isNotEmpty ? ev.providerId : providerId,
        modelId: ev.modelId.isNotEmpty ? ev.modelId : modelId,
        createdAt: DateTime.now().toUtc(),
      );
      _messages = [..._messages, assistant];
      assistantIndex = _messages.length - 1;
    }

    void syncStreamingBlocks() {
      if (assistantIndex < 0) return;
      final updatedBlocks = [
        for (final idx in blockOrder) blockBuffers[idx]!.toContentBlock(),
      ];
      _messages = [
        ..._messages.sublist(0, assistantIndex),
        _messages[assistantIndex].copyWith(blocks: updatedBlocks),
        ..._messages.sublist(assistantIndex + 1),
      ];
    }

    try {
      await for (final ev in gateway.streamChat(
        conversationId: conversationId,
        blocks: blocks,
        text: text,
        providerId: providerId,
        modelId: modelId,
        params: params,
        regenerateMessageId: regenerateMessageId,
        webSearch: webSearch,
        searchEngineId: searchEngineId,
        abortTrigger: abortCompleter.future,
      )) {
        if (epoch != _generationEpoch || _manualAbort) break;

        switch (ev.type) {
          case 'message_start':
            ensureAssistantMessage(ev);
          case 'block_start':
            ensureAssistantMessage(ev);
            if (_runState != ChatRunState.streaming) {
              _runState = ChatRunState.streaming;
            }
            final idx = ev.index ?? blockOrder.length;
            if (!blockBuffers.containsKey(idx)) {
              blockOrder.add(idx);
              blockBuffers[idx] = _StreamingBlockBuffer(
                blockType: ev.blockType,
                initialBlock: ev.block,
              );
            }
            syncStreamingBlocks();
            notifyListeners();
          case 'block_delta':
            ensureAssistantMessage(ev);
            if (_runState != ChatRunState.streaming) {
              _runState = ChatRunState.streaming;
            }
            final idx = ev.index ?? 0;
            final buf = blockBuffers.putIfAbsent(idx, () {
              blockOrder.add(idx);
              return _StreamingBlockBuffer(blockType: ev.blockType);
            });
            buf.applyDelta(ev.deltaType, ev.delta);
            syncStreamingBlocks();
            notifyListeners();
          case 'block_end':
            ensureAssistantMessage(ev);
            if (ev.index != null && ev.block != null) {
              final idx = ev.index!;
              final buf = blockBuffers.putIfAbsent(idx, () {
                blockOrder.add(idx);
                return _StreamingBlockBuffer(blockType: ev.block!.type);
              });
              buf.finalize(ev.block!);
              syncStreamingBlocks();
              notifyListeners();
            }
          case 'message_delta':
            if (assistantIndex >= 0) {
              _messages = [
                ..._messages.sublist(0, assistantIndex),
                _messages[assistantIndex].copyWith(
                  usage: ev.usage,
                  stopReason: ev.stopReason,
                ),
                ..._messages.sublist(assistantIndex + 1),
              ];
              notifyListeners();
            }
          case 'message_end':
            receivedMessageEnd = true;
            _pendingSendBlocks = null;
            _pendingSendText = null;
            _pendingRegenerateId = null;
            if (ev.message != null) {
              ensureAssistantMessage(ev);
              _messages = [
                ..._messages.sublist(0, assistantIndex),
                ev.message!,
                ..._messages.sublist(assistantIndex + 1),
              ];
            }
            _runState = _deriveRestState(_messages);
            notifyListeners();
            unawaited(_refreshConversationMetadata(conversationId, epoch));
          case 'error':
            _errorCode = ev.error?.code ?? 'UPSTREAM_ERROR';
            _errorMessage = ev.error?.message ?? 'Upstream streaming error';
            if (assistantIndex >= 0) {
              _messages = [
                ..._messages.sublist(0, assistantIndex),
                _messages[assistantIndex].copyWith(
                  stopReason: 'error',
                  errorMessage: _errorMessage,
                ),
                ..._messages.sublist(assistantIndex + 1),
              ];
            }
            _runState = ChatRunState.error;
            notifyListeners();
            return;
        }
      }

      if (epoch != _generationEpoch) return;
      if (_manualAbort) {
        _finalizeAbortedInMemory();
        return;
      }
      if (!receivedMessageEnd && _runState != ChatRunState.error) {
        _runState = _deriveRestState(_messages);
        notifyListeners();
      }
    } on http.RequestAbortedException {
      if (epoch == _generationEpoch && _runState != ChatRunState.aborted) {
        _finalizeAbortedInMemory();
      }
    } catch (e) {
      if (epoch != _generationEpoch) return;
      if (_manualAbort) {
        _finalizeAbortedInMemory();
        return;
      }
      _setError(e);
    } finally {
      if (_abortCompleter == abortCompleter) {
        _abortCompleter = null;
      }
    }
  }

  Future<void> _refreshConversationMetadata(
    String conversationId,
    int epoch,
  ) async {
    try {
      final detail = await gateway.getConversationDetail(conversationId);
      if (epoch != _generationEpoch || _conversation?.id != conversationId) {
        return;
      }
      _conversation = detail.conversation;
      onConversationUpdated?.call(detail.conversation);
      notifyListeners();
    } catch (_) {
      // Non-fatal metadata refresh.
    }
  }

  void _setError(Object err) {
    if (err is GatewayException) {
      _errorCode = err.code;
      _errorMessage = err.message;
    } else {
      _errorCode = 'NETWORK_ERROR';
      _errorMessage = err.toString();
    }
    _runState = ChatRunState.error;
    notifyListeners();
  }

  ChatRunState _deriveRestState(List<Message> msgs) {
    if (msgs.isEmpty) return ChatRunState.empty;
    final last = msgs.last;
    if (last.role == 'assistant' && last.stopReason == 'aborted') {
      return ChatRunState.aborted;
    }
    if (last.role == 'assistant' && last.stopReason == 'error') {
      _errorCode = 'UPSTREAM_ERROR';
      _errorMessage = last.errorMessage.isNotEmpty
          ? last.errorMessage
          : 'Generation failed';
      return ChatRunState.error;
    }
    return ChatRunState.idle;
  }

  @override
  void dispose() {
    _cancelActiveRequest(quiet: true);
    super.dispose();
  }
}

class _StreamingBlockBuffer {
  _StreamingBlockBuffer({
    required this.blockType,
    ContentBlock? initialBlock,
  }) : _finalized = initialBlock {
    if (initialBlock is ToolCallBlock) {
      _toolId = initialBlock.id;
      _toolName = initialBlock.name;
    }
  }

  final String blockType;
  final StringBuffer _text = StringBuffer();
  final StringBuffer _signature = StringBuffer();
  String _toolId = '';
  String _toolName = '';
  ContentBlock? _finalized;

  void applyDelta(String deltaType, String delta) {
    _finalized = null;
    if (deltaType == 'signature_delta') {
      _signature.write(delta);
    } else {
      _text.write(delta);
    }
  }

  void finalize(ContentBlock block) {
    _finalized = block;
  }

  ContentBlock toContentBlock() {
    if (_finalized != null) return _finalized!;
    switch (blockType) {
      case 'thinking':
        return ThinkingBlock(_text.toString(), signature: _signature.toString());
      case 'toolCall':
        return ToolCallBlock(
          id: _toolId,
          name: _toolName,
          arguments: _text.toString(),
        );
      default:
        return TextBlock(_text.toString());
    }
  }
}
