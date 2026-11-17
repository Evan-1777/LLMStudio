import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../models/content_block.dart';
import '../models/conversation.dart';
import '../models/message.dart';
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

  Completer<void>? _abortCompleter;
  bool _manualAbort = false;
  int _generationEpoch = 0;

  String? _pendingSendText;
  String? _pendingProviderId;
  String? _pendingModelId;
  String? _pendingRegenerateId;

  Conversation? get conversation => _conversation;
  List<Message> get messages => _messages;
  ChatRunState get runState => _runState;
  String? get errorCode => _errorCode;
  String? get errorMessage => _errorMessage;
  bool get isBusy =>
      _runState == ChatRunState.loading || _runState == ChatRunState.streaming;

  void clearSession() {
    _cancelActiveRequest(quiet: true);
    _conversation = null;
    _messages = const [];
    _errorCode = null;
    _errorMessage = null;
    _pendingSendText = null;
    _pendingRegenerateId = null;
    _runState = ChatRunState.empty;
    notifyListeners();
  }

  Future<void> loadConversation(String conversationId) async {
    _cancelActiveRequest(quiet: true);
    final epoch = ++_generationEpoch;

    _errorCode = null;
    _errorMessage = null;
    _pendingSendText = null;
    _pendingRegenerateId = null;
    _messages = const [];
    _runState = ChatRunState.loading;
    notifyListeners();

    try {
      final detail = await gateway.getConversationDetail(conversationId);
      if (epoch != _generationEpoch) return;
      _conversation = detail.conversation;
      _messages = detail.messages;
      _runState = _deriveRestState(_messages);
      onConversationUpdated?.call(detail.conversation);
      notifyListeners();
    } catch (e) {
      if (epoch != _generationEpoch) return;
      _setError(e);
    }
  }

  Future<void> sendMessage(
    String text, {
    required String providerId,
    required String modelId,
    GenerationParams? params,
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _conversation == null || isBusy) return;

    final conv = _conversation!;
    final optimisticUser = Message(
      id: 'local-user-${DateTime.now().microsecondsSinceEpoch}',
      conversationId: conv.id,
      role: 'user',
      blocks: [TextBlock(trimmed)],
      createdAt: DateTime.now().toUtc(),
    );

    _messages = [..._messages, optimisticUser];
    _pendingSendText = trimmed;
    _pendingProviderId = providerId;
    _pendingModelId = modelId;
    _pendingRegenerateId = null;

    await _runStream(
      conversationId: conv.id,
      text: trimmed,
      providerId: providerId,
      modelId: modelId,
      params: params,
    );
  }

  Future<void> regenerate(
    String assistantMessageId, {
    required String providerId,
    required String modelId,
    GenerationParams? params,
  }) async {
    if (_conversation == null || isBusy) return;
    final conv = _conversation!;
    final idx = _messages.indexWhere((m) => m.id == assistantMessageId);
    if (idx < 0) return;

    _messages = _messages.sublist(0, idx);
    _pendingSendText = null;
    _pendingProviderId = providerId;
    _pendingModelId = modelId;
    _pendingRegenerateId = assistantMessageId;

    await _runStream(
      conversationId: conv.id,
      providerId: providerId,
      modelId: modelId,
      params: params,
      regenerateMessageId: assistantMessageId,
    );
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
        );
        return;
      }
    }

    if (_pendingRegenerateId != null) {
      await _runStream(
        conversationId: _conversation!.id,
        providerId: pId,
        modelId: mId,
        params: params,
        regenerateMessageId: _pendingRegenerateId,
      );
      return;
    }

    final retryText = _pendingSendText;
    if (retryText != null && retryText.isNotEmpty) {
      await _runStream(
        conversationId: _conversation!.id,
        text: retryText,
        providerId: pId,
        modelId: mId,
        params: params,
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
    String? text,
    required String providerId,
    required String modelId,
    GenerationParams? params,
    String? regenerateMessageId,
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
        text: text,
        providerId: providerId,
        modelId: modelId,
        params: params,
        regenerateMessageId: regenerateMessageId,
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
