import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/app.dart';
import 'package:llmstudio_frontend/core/models/app_settings.dart';
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
import 'package:llmstudio_frontend/core/state/settings_controller.dart';
import 'package:llmstudio_frontend/core/storage/settings_store.dart';
import 'package:llmstudio_frontend/core/theme/app_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _LayoutFakeGateway extends GatewayClient {
  _LayoutFakeGateway() : super(baseUrl: 'http://localhost:8080');

  List<Message> initialMessages = const [];
  Stream<StreamEvent> Function({Future<void>? abortTrigger})? onStream;
  final List<String> deletedMessages = [];
  bool branched = false;
  GenerationParams? lastParams;
  bool lastWebSearch = false;
  List<ContentBlock>? lastBlocks;

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(
          id: 'openai-completions',
          displayName: 'OpenAI',
          defaultPath: '/v1/chat/completions',
        ),
      ];

  @override
  Future<List<ProviderConfig>> listProviders() async => const [
        ProviderConfig(
          id: 'p1',
          name: 'Axonhub',
          baseUrl: 'http://localhost:11434/v1',
          authType: 'none',
          enabled: true,
          models: [
            ModelConfig(
              id: 'm1',
              name: 'model-chat-low',
              apiFormat: 'openai-completions',
            ),
          ],
        ),
      ];

  @override
  Future<List<Assistant>> listAssistants() async => const [
        Assistant(id: 'default', name: '默认助手', isDefault: true),
        Assistant(id: 'coder', name: '代码助手'),
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
        McpServerConfig(id: 'mcp1', name: 'Git', transport: 'stdio', enabled: false),
      ];

  @override
  Future<McpServerConfig> updateMcpServer(
    String id,
    McpServerUpsertPayload payload,
  ) async =>
      McpServerConfig(
        id: id,
        name: payload.name,
        transport: payload.transport,
        enabled: payload.enabled,
      );

  @override
  Future<List<Conversation>> listConversations() async => [
        Conversation(
          id: 'c1',
          assistantId: 'default',
          title: 'Session One',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
        Conversation(
          id: 'c2',
          assistantId: 'coder',
          title: 'Coder Topic',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
      ];

  @override
  Future<ConversationDetail> getConversationDetail(String id) async =>
      ConversationDetail(
        conversation: Conversation(
          id: id,
          assistantId: id == 'c2' ? 'coder' : 'default',
          title: id == 'c2' ? 'Coder Topic' : 'Session One',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
        messages: initialMessages,
      );

  @override
  Future<void> deleteMessage(String conversationId, String messageId) async {
    deletedMessages.add(messageId);
  }

  @override
  Future<ConversationDetail> branchConversation(
    String conversationId,
    String messageId,
  ) async {
    branched = true;
    return ConversationDetail(
      conversation: Conversation(
        id: 'c-branched',
        assistantId: 'default',
        title: 'Session One (分支)',
        providerId: 'p1',
        modelId: 'm1',
        createdAt: DateTime.utc(2026, 11, 17),
        updatedAt: DateTime.utc(2026, 11, 17),
      ),
      messages: initialMessages,
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
    lastBlocks = blocks;
    lastParams = params;
    lastWebSearch = webSearch;
    return onStream!(abortTrigger: abortTrigger);
  }
}

void main() {
  Future<
      ({
        SettingsController settings,
        ProvidersController providers,
        AssistantsController assistants,
        PluginsController plugins,
        ConversationsController convs,
        ChatController chat,
        _LayoutFakeGateway gateway,
      })> createEnv({List<Message> messages = const []}) async {
    SharedPreferences.setMockInitialValues({});
    final gw = _LayoutFakeGateway()..initialMessages = messages;
    final settings = SettingsController(
      store: SettingsStore(),
      gateway: gw,
      initialSettings: AppSettings.defaults(),
    );
    await settings.load();
    final providers = ProvidersController(gateway: gw);
    final assistants = AssistantsController(gateway: gw);
    final plugins = PluginsController(gateway: gw);
    final convs = ConversationsController(gateway: gw);
    final chat = ChatController(
      gateway: gw,
      onConversationUpdated: convs.upsertLocal,
    );
    return (
      settings: settings,
      providers: providers,
      assistants: assistants,
      plugins: plugins,
      convs: convs,
      chat: chat,
      gateway: gw,
    );
  }

  testWidgets('Three-column workbench adapts across 1280x800, 720x900, and 390x844 with deduplicated entries', (tester) async {
    final env = await createEnv();

    // Desktop (1280x800): 3 panes (assistants + center + history), unique entries.
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: env.settings,
        providersController: env.providers,
        assistantsController: env.assistants,
        pluginsController: env.plugins,
        conversationsController: env.convs,
        chatController: env.chat,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('workbench_assistants_pane')), findsOneWidget);
    expect(find.byKey(const Key('workbench_history_pane')), findsOneWidget);
    expect(find.byKey(const Key('topbar_model_selector')), findsOneWidget);
    expect(find.byKey(const Key('history_new_topic_button')), findsOneWidget);
    expect(find.byKey(const Key('topbar_settings_button')), findsOneWidget);
    expect(find.byKey(const Key('topbar_new_chat_button')), findsNothing);
    expect(find.text('model-chat-low | Axonhub'), findsOneWidget);

    // Switching assistant filters topics in right pane.
    expect(find.text('Session One'), findsOneWidget);
    expect(find.text('Coder Topic'), findsNothing);
    await tester.tap(find.byKey(const Key('assistant_item_coder')));
    await tester.pumpAndSettle();
    expect(find.text('Coder Topic'), findsOneWidget);
    expect(find.text('Session One'), findsNothing);

    await tester.tap(find.byKey(const Key('topbar_params_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_params_pane')), findsOneWidget);

    // Tablet (720x900): inline panes collapsed by default, toggled via sidebar button.
    await tester.binding.setSurfaceSize(const Size(720, 900));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_assistants_pane')), findsNothing);
    expect(find.byKey(const Key('workbench_history_pane')), findsNothing);

    await tester.tap(find.byKey(const Key('topbar_sidebar_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_medium_sidebar_pane')), findsOneWidget);

    // Mobile (390x844): drawer with assistant/topic switch and bottom sheet params.
    await tester.binding.setSurfaceSize(const Size(390, 844));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('topbar_sidebar_button')));
    await tester.pumpAndSettle();
    expect(find.byType(Drawer), findsOneWidget);
    Navigator.of(tester.element(find.byType(Drawer))).pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('topbar_params_button')));
    await tester.pumpAndSettle();
    expect(find.text('话题参数'), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('Workbench executes 4 message actions and 4 composer tools end-to-end', (tester) async {
    final env = await createEnv(messages: [
      Message(
        id: 'u-init',
        conversationId: 'c1',
        role: 'user',
        blocks: const [TextBlock('Initial question')],
        createdAt: DateTime.utc(2026, 11, 17),
      ),
      Message(
        id: 'a-init',
        conversationId: 'c1',
        role: 'assistant',
        blocks: const [TextBlock('Initial answer')],
        stopReason: 'stop',
        createdAt: DateTime.utc(2026, 11, 17),
      ),
    ]);
    await tester.binding.setSurfaceSize(const Size(1280, 800));

    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: env.settings,
        providersController: env.providers,
        assistantsController: env.assistants,
        pluginsController: env.plugins,
        conversationsController: env.convs,
        chatController: env.chat,
        assistantTextBuilder: (_, _, text, _) => Text(text),
      ),
    );
    await tester.pumpAndSettle();

    // 4 message actions present for non-streaming messages.
    expect(find.byKey(const Key('msg_copy_a-init')), findsOneWidget);
    expect(find.byKey(const Key('msg_retry_a-init')), findsOneWidget);
    expect(find.byKey(const Key('msg_delete_a-init')), findsOneWidget);
    expect(find.byKey(const Key('msg_branch_a-init')), findsOneWidget);

    // Branch message creates and switches to branch.
    await tester.tap(find.byKey(const Key('msg_branch_a-init')));
    await tester.pumpAndSettle();
    expect(env.gateway.branched, isTrue);
    expect(env.convs.activeId, 'c-branched');

    // Delete message removes it.
    await tester.tap(find.byKey(const Key('msg_delete_a-init')));
    await tester.pumpAndSettle();
    expect(env.gateway.deletedMessages, ['a-init']);

    // Composer 4 tools: web search, thinking 6-level slider, MCP selector, and send.
    expect(find.byKey(const Key('composer_web_search_button')), findsOneWidget);
    expect(find.byKey(const Key('composer_attachment_button')), findsOneWidget);
    expect(find.byKey(const Key('composer_mcp_button')), findsOneWidget);
    expect(find.byKey(const Key('composer_thinking_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer_web_search_button')));
    await tester.pumpAndSettle();
    expect(env.plugins.webSearchEnabled, isTrue);

    await tester.tap(find.byKey(const Key('composer_thinking_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('thinking_effort_slider')), findsOneWidget);
    await tester.tap(find.byKey(const Key('thinking_level_xhigh')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确定'));
    await tester.pumpAndSettle();
    expect(env.chat.reasoningEffort, 'xhigh');

    await tester.tap(find.byKey(const Key('composer_mcp_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('composer_mcp_item_mcp1')));
    await tester.pumpAndSettle();
    expect(env.plugins.enabledMcpServers, hasLength(1));
    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();

    // Stream states still work cleanly.
    final streamGate = Completer<void>();
    env.gateway.onStream = ({abortTrigger}) {
      final sc = StreamController<StreamEvent>();
      abortTrigger?.then((_) {
        if (!sc.isClosed) sc.close();
      });
      streamGate.future.then((_) {
        if (sc.isClosed) return;
        sc.add(const StreamEvent(type: 'message_start', messageId: 'a1'));
        sc.add(const StreamEvent(type: 'block_start', index: 0, blockType: 'text'));
        sc.add(const StreamEvent(
          type: 'block_delta',
          index: 0,
          blockType: 'text',
          deltaType: 'text_delta',
          delta: 'Streamed chunk',
        ));
      });
      return sc.stream;
    };

    await tester.enterText(find.byKey(const Key('composer_text_field')), 'Hello');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer_send_button')));
    await tester.pump();
    expect(env.chat.runState, ChatRunState.loading);
    expect(env.gateway.lastWebSearch, isTrue);
    expect(env.gateway.lastParams?.reasoningEffort, 'xhigh');

    streamGate.complete();
    await tester.pump();
    await tester.pump();
    expect(env.chat.runState, ChatRunState.streaming);
    expect(find.byKey(const Key('composer_stop_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer_stop_button')));
    await tester.pumpAndSettle();
    expect(env.chat.runState, ChatRunState.aborted);
    expect(find.text('已终止'), findsOneWidget);
    expect(find.byType(AppSvgIcon), findsWidgets);

    await tester.binding.setSurfaceSize(null);
  });
}
