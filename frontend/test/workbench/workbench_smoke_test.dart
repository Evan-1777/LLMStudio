import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/app.dart';
import 'package:llmstudio_frontend/core/models/app_settings.dart';
import 'package:llmstudio_frontend/core/models/assistant.dart';
import 'package:llmstudio_frontend/core/models/content_block.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
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
import 'package:shared_preferences/shared_preferences.dart';

class _MockWorkbenchGateway extends GatewayClient {
  _MockWorkbenchGateway() : super(baseUrl: 'http://localhost:8080');

  Stream<StreamEvent> Function({Future<void>? abortTrigger})? onStream;
  List<ContentBlock>? lastSentBlocks;

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
          name: 'Local',
          baseUrl: 'http://localhost:11434/v1',
          authType: 'none',
          enabled: true,
          models: [
            ModelConfig(
              id: 'm1',
              name: 'Local Model',
              apiFormat: 'openai-completions',
            ),
          ],
        ),
      ];

  @override
  Future<List<Assistant>> listAssistants() async => const [
        Assistant(id: 'default', name: '默认助手', isDefault: true),
      ];

  @override
  Future<List<SearchEnginePluginConfig>> listSearchEngines() async => const [];

  @override
  Future<List<McpServerConfig>> listMcpServers() async => const [];

  @override
  Future<List<Conversation>> listConversations() async => [
        Conversation(
          id: 'c1',
          assistantId: 'default',
          title: 'Active Thread',
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
          assistantId: 'default',
          title: 'Active Thread',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
        messages: const [],
      );

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
    lastSentBlocks = blocks;
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
        _MockWorkbenchGateway gateway,
      })> buildControllers() async {
    SharedPreferences.setMockInitialValues({});
    final gw = _MockWorkbenchGateway();
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

  testWidgets('Workbench switches panes between 480px and 1280px', (tester) async {
    final c = await buildControllers();

    await tester.binding.setSurfaceSize(const Size(480, 800));
    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: c.settings,
        providersController: c.providers,
        assistantsController: c.assistants,
        pluginsController: c.plugins,
        conversationsController: c.convs,
        chatController: c.chat,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_assistants_pane')), findsNothing);
    expect(find.byKey(const Key('workbench_history_pane')), findsNothing);

    await tester.binding.setSurfaceSize(const Size(1280, 800));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_assistants_pane')), findsOneWidget);
    expect(find.byKey(const Key('workbench_history_pane')), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('Workbench supports attachment chips, streaming, and stop abort', (tester) async {
    final c = await buildControllers();
    await tester.binding.setSurfaceSize(const Size(1280, 800));

    final streamStarted = Completer<void>();
    c.gateway.onStream = ({abortTrigger}) {
      final sc = StreamController<StreamEvent>();
      abortTrigger?.then((_) {
        if (!sc.isClosed) sc.close();
      });
      sc.add(const StreamEvent(type: 'message_start', messageId: 'a1'));
      sc.add(const StreamEvent(type: 'block_start', index: 0, blockType: 'text'));
      sc.add(const StreamEvent(
        type: 'block_delta',
        index: 0,
        blockType: 'text',
        deltaType: 'text_delta',
        delta: 'Streaming response...',
      ));
      streamStarted.complete();
      return sc.stream;
    };

    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: c.settings,
        providersController: c.providers,
        assistantsController: c.assistants,
        pluginsController: c.plugins,
        conversationsController: c.convs,
        chatController: c.chat,
        onPickAttachments: () async => const [
          ComposerAttachment(name: 'spec.md', textContent: '# Spec'),
          ComposerAttachment(
            name: 'shot.png',
            mimeType: 'image/png',
            isImage: true,
            base64Data: 'QUJD',
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(c.chat.runState, ChatRunState.empty);
    expect(find.byKey(const Key('composer_send_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer_attachment_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attachment_chip_0')), findsOneWidget);
    expect(find.byKey(const Key('attachment_chip_1')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('composer_text_field')), 'Hello');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer_send_button')));
    await streamStarted.future;
    await tester.pump();

    expect(c.gateway.lastSentBlocks, hasLength(3));
    expect(c.gateway.lastSentBlocks![0], isA<TextBlock>());
    expect(c.gateway.lastSentBlocks![1], isA<ImageBlock>());

    expect(c.chat.runState, ChatRunState.streaming);
    expect(find.text('Streaming response...'), findsOneWidget);
    expect(find.byKey(const Key('composer_stop_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer_stop_button')));
    await tester.pumpAndSettle();

    expect(c.chat.runState, ChatRunState.aborted);
    expect(find.text('已终止'), findsOneWidget);
    expect(find.byKey(const Key('composer_send_button')), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });
}
