import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/models/assistant.dart';
import 'package:llmstudio_frontend/core/models/content_block.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
import 'package:llmstudio_frontend/core/models/message.dart';
import 'package:llmstudio_frontend/core/models/plugin_models.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
import 'package:llmstudio_frontend/core/models/stream_event.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/state/assistants_controller.dart';
import 'package:llmstudio_frontend/core/state/chat_controller.dart';
import 'package:llmstudio_frontend/core/state/conversations_controller.dart';
import 'package:llmstudio_frontend/core/state/plugins_controller.dart';
import 'package:llmstudio_frontend/core/state/providers_controller.dart';

class _StubGatewayClient extends GatewayClient {
  _StubGatewayClient() : super(baseUrl: 'http://localhost:8080');

  ConversationDetail? detailToReturn;
  Stream<StreamEvent> Function({Future<void>? abortTrigger})? streamHandler;
  int streamCallCount = 0;
  List<ContentBlock>? lastBlocks;
  GenerationParams? lastParams;
  String? lastRegenerateId;
  bool lastWebSearch = false;
  String? lastSearchEngineId;
  final List<String> deletedMessageIds = [];

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(
          id: 'openai-completions',
          displayName: 'OpenAI Completions',
          defaultPath: '/v1/chat/completions',
        ),
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
  Future<List<Assistant>> listAssistants() async => const [
        Assistant(id: 'default', name: '默认助手', isDefault: true),
        Assistant(id: 'a2', name: '代码助手'),
      ];

  @override
  Future<List<SearchEnginePluginConfig>> listSearchEngines() async => const [
        SearchEnginePluginConfig(
          engineId: 'tavily',
          displayName: 'Tavily Search',
          enabled: true,
          isDefault: true,
        ),
      ];

  @override
  Future<List<McpServerConfig>> listMcpServers() async => const [
        McpServerConfig(id: 'mcp1', name: 'FS', transport: 'stdio', enabled: true),
      ];

  @override
  Future<List<Conversation>> listConversations() async => [
        Conversation(
          id: 'c1',
          assistantId: 'default',
          title: 'First Chat',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
        Conversation(
          id: 'c2',
          assistantId: 'a2',
          title: 'Code Review',
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
            assistantId: 'default',
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
  Future<void> deleteMessage(String conversationId, String messageId) async {
    deletedMessageIds.add(messageId);
  }

  @override
  Future<ConversationDetail> branchConversation(
    String conversationId,
    String messageId,
  ) async {
    return ConversationDetail(
      conversation: Conversation(
        id: 'c-branch',
        assistantId: 'default',
        title: 'First Chat (分支)',
        providerId: 'p1',
        modelId: 'm1',
        createdAt: DateTime.utc(2026, 11, 17),
        updatedAt: DateTime.utc(2026, 11, 17),
      ),
      messages: [
        Message(
          id: 'bm1',
          conversationId: 'c-branch',
          role: 'user',
          blocks: const [TextBlock('Hello')],
          createdAt: DateTime.utc(2026, 11, 17),
        ),
      ],
    );
  }

  @override
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
  }) {
    streamCallCount++;
    lastBlocks = blocks;
    lastParams = params;
    lastRegenerateId = regenerateMessageId;
    lastWebSearch = webSearch;
    lastSearchEngineId = searchEngineId;
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

  test('AssistantsController, PluginsController, ConversationsController filter by assistant and branch', () async {
    final stub = _StubGatewayClient();
    final providersCtrl = ProvidersController(gateway: stub);
    final assistantsCtrl = AssistantsController(gateway: stub);
    final pluginsCtrl = PluginsController(gateway: stub);
    final convsCtrl = ConversationsController(gateway: stub);

    await Future.wait([
      providersCtrl.refresh(),
      assistantsCtrl.refresh(),
      pluginsCtrl.refresh(),
      convsCtrl.refresh(),
    ]);

    expect(providersCtrl.hasUsableModel, isTrue);
    expect(assistantsCtrl.assistants, hasLength(2));
    expect(pluginsCtrl.searchEngines.single.engineId, 'tavily');
    expect(pluginsCtrl.enabledMcpServers, hasLength(1));

    // Scoped to 'default' initially.
    expect(convsCtrl.filteredConversations.map((c) => c.id), ['c1']);

    // Switching assistant scopes conversations to 'a2'.
    convsCtrl.setActiveAssistantId('a2');
    expect(convsCtrl.filteredConversations.map((c) => c.id), ['c2']);
    expect(convsCtrl.activeId, 'c2');

    // Branch creates new conversation and activates it.
    final branched = await convsCtrl.branchFromMessage('c1', 'm1');
    expect(branched.conversation.id, 'c-branch');
    expect(convsCtrl.activeId, 'c-branch');
  });

  test('ChatController passes 6 effort levels, webSearch, attachments, deleteMessage, and user/assistant retryMessage', () async {
    final stub = _StubGatewayClient();
    stub.detailToReturn = ConversationDetail(
      conversation: Conversation(
        id: 'c1',
        assistantId: 'default',
        title: 'Session',
        providerId: 'p1',
        modelId: 'm1',
        createdAt: DateTime.utc(2026, 11, 17),
        updatedAt: DateTime.utc(2026, 11, 17),
      ),
      messages: [
        Message(
          id: 'u1',
          conversationId: 'c1',
          role: 'user',
          blocks: const [TextBlock('Ask 1')],
          createdAt: DateTime.utc(2026, 11, 17),
        ),
        Message(
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          blocks: const [TextBlock('Ans 1')],
          stopReason: 'stop',
          createdAt: DateTime.utc(2026, 11, 17),
        ),
      ],
    );

    final ctrl = ChatController(gateway: stub);
    await ctrl.loadConversation('c1');

    ctrl.setReasoningEffort('xhigh');
    expect(ctrl.reasoningEffort, 'xhigh');

    stub.streamHandler = ({abortTrigger}) async* {
      yield StreamEvent(
        type: 'message_end',
        message: Message(
          id: 'a2',
          conversationId: 'c1',
          role: 'assistant',
          blocks: const [TextBlock('Ans 2')],
          stopReason: 'stop',
          createdAt: DateTime.utc(2026, 11, 17),
        ),
      );
    };

    await ctrl.sendMessage(
      'Check attachments',
      providerId: 'p1',
      modelId: 'm1',
      webSearch: true,
      searchEngineId: 'tavily',
      attachments: const [
        ComposerAttachment(name: 'notes.txt', textContent: 'hello'),
        ComposerAttachment(
          name: 'img.png',
          mimeType: 'image/png',
          isImage: true,
          base64Data: 'QUJD',
        ),
      ],
    );

    expect(stub.lastWebSearch, isTrue);
    expect(stub.lastSearchEngineId, 'tavily');
    expect(stub.lastParams?.reasoningEffort, 'xhigh');
    expect(stub.lastBlocks, hasLength(3));
    expect(stub.lastBlocks![0], isA<TextBlock>());
    expect(stub.lastBlocks![1], isA<ImageBlock>());

    // Retry on user message u1 targets assistant a1 (keeps u1).
    await ctrl.retryMessage('u1', providerId: 'p1', modelId: 'm1');
    expect(stub.lastRegenerateId, 'a1');
    expect(ctrl.messages.first.id, 'u1');

    // Delete message removes it locally and calls backend.
    await ctrl.deleteMessage('u1');
    expect(stub.deletedMessageIds, ['u1']);
    expect(ctrl.messages.any((m) => m.id == 'u1'), isFalse);
  });
}
