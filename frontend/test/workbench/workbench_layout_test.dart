import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/app.dart';
import 'package:llmstudio_frontend/core/models/app_settings.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
import 'package:llmstudio_frontend/core/models/message.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
import 'package:llmstudio_frontend/core/models/stream_event.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/state/chat_controller.dart';
import 'package:llmstudio_frontend/core/state/conversations_controller.dart';
import 'package:llmstudio_frontend/core/state/providers_controller.dart';
import 'package:llmstudio_frontend/core/state/settings_controller.dart';
import 'package:llmstudio_frontend/core/storage/settings_store.dart';
import 'package:llmstudio_frontend/core/theme/app_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _LayoutFakeGateway extends GatewayClient {
  _LayoutFakeGateway() : super(baseUrl: 'http://localhost:8080');

  List<Message> initialMessages = const [];
  Stream<StreamEvent> Function({Future<void>? abortTrigger})? onStream;

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(id: 'openai-completions', displayName: 'OpenAI'),
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
  Future<List<Conversation>> listConversations() async => [
        Conversation(
          id: 'c1',
          title: 'Session One',
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
          title: 'Session One',
          providerId: 'p1',
          modelId: 'm1',
          createdAt: DateTime.utc(2026, 11, 17),
          updatedAt: DateTime.utc(2026, 11, 17),
        ),
        messages: initialMessages,
      );

  @override
  Stream<StreamEvent> streamChat({
    required String conversationId,
    String? text,
    String? providerId,
    String? modelId,
    GenerationParams? params,
    String? regenerateMessageId,
    Future<void>? abortTrigger,
  }) =>
      onStream!(abortTrigger: abortTrigger);
}

void main() {
  Future<
      ({
        SettingsController settings,
        ProvidersController providers,
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
    final convs = ConversationsController(gateway: gw);
    final chat = ChatController(
      gateway: gw,
      onConversationUpdated: convs.upsertLocal,
    );
    return (
      settings: settings,
      providers: providers,
      convs: convs,
      chat: chat,
      gateway: gw,
    );
  }

  testWidgets('Workbench adapts layout cleanly at 1280x800, 720x900, and 390x844', (tester) async {
    final env = await createEnv();

    // Desktop (1280x800): inline sidebar shown, params toggle reveals inline inspector.
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: env.settings,
        providersController: env.providers,
        conversationsController: env.convs,
        chatController: env.chat,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_sidebar_pane')), findsOneWidget);
    expect(find.byKey(const Key('workbench_params_pane')), findsNothing);

    await tester.tap(find.byKey(const Key('topbar_params_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_params_pane')), findsOneWidget);

    // Tablet (720x900): sidebar collapsed by default, toggled via sidebar button; params opens sheet.
    await tester.binding.setSurfaceSize(const Size(720, 900));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_sidebar_pane')), findsNothing);
    expect(find.byKey(const Key('workbench_params_pane')), findsNothing);

    await tester.tap(find.byKey(const Key('topbar_sidebar_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_sidebar_pane')), findsOneWidget);

    // Mobile (390x844): drawer sidebar and bottom sheet params without overflow.
    await tester.binding.setSurfaceSize(const Size(390, 844));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workbench_sidebar_pane')), findsNothing);

    await tester.tap(find.byKey(const Key('topbar_sidebar_button')));
    await tester.pumpAndSettle();
    expect(find.byType(Drawer), findsOneWidget);
    Navigator.of(tester.element(find.byType(Drawer))).pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('topbar_params_button')));
    await tester.pumpAndSettle();
    expect(find.text('会话参数'), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('Workbench renders five states, uses AppSvgIcon actions, and omits onboarding noise', (tester) async {
    final env = await createEnv();
    await tester.binding.setSurfaceSize(const Size(1280, 800));

    await tester.pumpWidget(
      LlmStudioApp(
        settingsController: env.settings,
        providersController: env.providers,
        conversationsController: env.convs,
        chatController: env.chat,
      ),
    );
    await tester.pumpAndSettle();

    // Empty state: zero onboarding/welcome text, actions rendered with AppSvgIcon.
    expect(env.chat.runState, ChatRunState.empty);
    expect(find.textContaining('欢迎使用'), findsNothing);
    expect(find.textContaining('开始提问'), findsNothing);
    expect(find.byType(AppSvgIcon), findsWidgets);

    // Loading -> Streaming -> Aborted -> Error -> Retry.
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

    await tester.enterText(find.byType(TextField).last, 'Hello');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer_send_button')));
    await tester.pump();
    expect(env.chat.runState, ChatRunState.loading);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);

    streamGate.complete();
    await tester.pump();
    await tester.pump();
    expect(env.chat.runState, ChatRunState.streaming);
    expect(find.text('Streamed chunk'), findsOneWidget);
    expect(find.byKey(const Key('composer_stop_button')), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer_stop_button')));
    await tester.pumpAndSettle();
    expect(env.chat.runState, ChatRunState.aborted);
    expect(find.text('已终止'), findsOneWidget);

    // Error state & retry button.
    env.gateway.onStream = ({abortTrigger}) async* {
      yield const StreamEvent(
        type: 'error',
        error: StreamError(code: 'UPSTREAM_ERROR', message: 'Upstream down'),
      );
    };
    await tester.enterText(find.byType(TextField).last, 'Trigger error');
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer_send_button')));
    await tester.pumpAndSettle();
    expect(env.chat.runState, ChatRunState.error);
    expect(find.text('Upstream down'), findsOneWidget);
    expect(find.byKey(const Key('chat_retry_button')), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });
}
