import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/models/content_block.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
import 'package:llmstudio_frontend/core/models/message.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
import 'package:llmstudio_frontend/core/models/stream_event.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/state/chat_controller.dart';
import 'package:llmstudio_frontend/core/state/conversations_controller.dart';
import 'package:llmstudio_frontend/core/state/providers_controller.dart';

class _StubGatewayClient extends GatewayClient {
  _StubGatewayClient() : super(baseUrl: 'http://localhost:8080');

  ConversationDetail? detailToReturn;
  Stream<StreamEvent> Function({Future<void>? abortTrigger})? streamHandler;
  int streamCallCount = 0;

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(id: 'openai-completions', displayName: 'OpenAI Completions'),
      ];

  @override
  Future<List<ProviderConfig>> listProviders() async => const [
        ProviderConfig(
          id: 'p1',
          name: 'Mock',
          baseUrl: 'http://mock',
          authType: 'none',
          enabled: true,
          models: [
            ModelConfig(
              id: 'm1',
              name: 'Model 1',
              apiFormat: 'openai-completions',
            ),
          ],
        ),
      ];

  @override
  Future<List<Conversation>> listConversations() async => [
        Conversation(
          id: 'c1',
          title: 'First Chat',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
      ];

  @override
  Future<ConversationDetail> getConversationDetail(String id) async {
    return detailToReturn ??
        ConversationDetail(
          conversation: Conversation(
            id: id,
            title: 'First Chat',
            providerId: 'p1',
            modelId: 'm1',
            createdAt: DateTime.utc(2026, 11, 17),
            updatedAt: DateTime.utc(2026, 11, 17),
          ),
          messages: const [],
        );
  }

  @override
  Stream<StreamEvent> streamChat({
    required String conversationId,
    String? text,
    String? providerId,
    String? modelId,
    GenerationParams? params,
    String? regenerateMessageId,
    Future<void>? abortTrigger,
  }) {
    streamCallCount++;
    return streamHandler!(abortTrigger: abortTrigger);
  }
}

void main() {
  test('ChatController transitions empty -> loading -> streaming -> idle', () async {
    final stub = _StubGatewayClient();
    final ctrl = ChatController(gateway: stub);
    final states = <ChatRunState>[];
    ctrl.addListener(() => states.add(ctrl.runState));

    await ctrl.loadConversation('c1');
    expect(ctrl.runState, ChatRunState.empty);

    stub.streamHandler = ({abortTrigger}) async* {
      yield const StreamEvent(
        type: 'message_start',
        conversationId: 'c1',
        messageId: 'a1',
        providerId: 'p1',
        modelId: 'm1',
      );
      yield const StreamEvent(
        type: 'block_start',
        index: 0,
        blockType: 'text',
      );
      yield const StreamEvent(
        type: 'block_delta',
        index: 0,
        blockType: 'text',
        deltaType: 'text_delta',
        delta: 'Hello world',
      );
      yield StreamEvent(
        type: 'message_end',
        conversationId: 'c1',
        messageId: 'a1',
        message: Message(
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          blocks: const [TextBlock('Hello world')],
          stopReason: 'stop',
          createdAt: DateTime.utc(2026, 11, 17),
        ),
      );
    };

    await ctrl.sendMessage('Hi', providerId: 'p1', modelId: 'm1');
    expect(states, containsAllInOrder([
      ChatRunState.loading,
      ChatRunState.empty,
      ChatRunState.loading,
      ChatRunState.streaming,
      ChatRunState.idle,
    ]));
    expect(ctrl.messages, hasLength(2));
    expect(ctrl.messages.last.plainText, 'Hello world');
  });

  test('ChatController transitions streaming -> aborted preserving partial blocks', () async {
    final stub = _StubGatewayClient();
    final ctrl = ChatController(gateway: stub);
    await ctrl.loadConversation('c1');

    final gate = Completer<void>();
    stub.streamHandler = ({abortTrigger}) {
      final sc = StreamController<StreamEvent>();
      abortTrigger?.then((_) {
        if (!sc.isClosed) sc.close();
      });
      sc.add(const StreamEvent(type: 'message_start', messageId: 'a2'));
      sc.add(const StreamEvent(type: 'block_start', index: 0, blockType: 'text'));
      sc.add(const StreamEvent(
        type: 'block_delta',
        index: 0,
        blockType: 'text',
        deltaType: 'text_delta',
        delta: 'Partial output',
      ));
      gate.complete();
      return sc.stream;
    };

    final future = ctrl.sendMessage('Start', providerId: 'p1', modelId: 'm1');
    await gate.future;
    await Future<void>.delayed(Duration.zero);
    expect(ctrl.runState, ChatRunState.streaming);

    ctrl.stopStreaming();
    await future;

    expect(ctrl.runState, ChatRunState.aborted);
    expect(ctrl.messages.last.stopReason, 'aborted');
    expect(ctrl.messages.last.plainText, 'Partial output');
  });

  test('ChatController transitions loading/streaming -> error -> loading on retry', () async {
    final stub = _StubGatewayClient();
    final ctrl = ChatController(gateway: stub);
    await ctrl.loadConversation('c1');

    stub.streamHandler = ({abortTrigger}) async* {
      yield const StreamEvent(
        type: 'error',
        error: StreamError(code: 'UPSTREAM_ERROR', message: 'rate limited'),
      );
    };

    await ctrl.sendMessage('Retry me', providerId: 'p1', modelId: 'm1');
    expect(ctrl.runState, ChatRunState.error);
    expect(ctrl.errorCode, 'UPSTREAM_ERROR');
    expect(ctrl.errorMessage, 'rate limited');

    stub.streamHandler = ({abortTrigger}) async* {
      yield const StreamEvent(type: 'block_start', index: 0, blockType: 'text');
      yield const StreamEvent(
        type: 'block_delta',
        index: 0,
        blockType: 'text',
        deltaType: 'text_delta',
        delta: 'Recovered',
      );
      yield StreamEvent(
        type: 'message_end',
        message: Message(
          id: 'a3',
          conversationId: 'c1',
          role: 'assistant',
          blocks: const [TextBlock('Recovered')],
          stopReason: 'stop',
          createdAt: DateTime.utc(2026, 11, 17),
        ),
      );
    };

    final observedStates = <ChatRunState>[];
    ctrl.addListener(() => observedStates.add(ctrl.runState));

    await ctrl.retry();
    expect(stub.streamCallCount, 2);
    expect(observedStates.first, ChatRunState.loading);
    expect(ctrl.runState, ChatRunState.idle);
    expect(ctrl.messages.last.plainText, 'Recovered');
  });

  test('ProvidersController and ConversationsController resolve defaults and search', () async {
    final stub = _StubGatewayClient();
    final providersCtrl = ProvidersController(gateway: stub);
    final convsCtrl = ConversationsController(gateway: stub);

    await providersCtrl.refresh();
    expect(providersCtrl.hasUsableModel, isTrue);
    expect(providersCtrl.defaultModel()?.model.id, 'm1');

    await convsCtrl.refresh();
    expect(convsCtrl.activeId, 'c1');
    convsCtrl.setSearchQuery('missing');
    expect(convsCtrl.filteredConversations, isEmpty);
    convsCtrl.setSearchQuery('first');
    expect(convsCtrl.filteredConversations, hasLength(1));
  });
}
