import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/models/app_settings.dart';
import 'core/network/gateway_client.dart';
import 'core/state/chat_controller.dart';
import 'core/state/conversations_controller.dart';
import 'core/state/providers_controller.dart';
import 'core/state/settings_controller.dart';
import 'core/storage/settings_store.dart';
import 'core/theme/app_theme.dart';
import 'features/workbench/chat_canvas.dart';
import 'features/workbench/workbench_shell.dart';

class LlmStudioApp extends StatefulWidget {
  const LlmStudioApp({
    super.key,
    this.settingsController,
    this.providersController,
    this.conversationsController,
    this.chatController,
    this.onOpenSettings,
    this.assistantTextBuilder,
  });

  final SettingsController? settingsController;
  final ProvidersController? providersController;
  final ConversationsController? conversationsController;
  final ChatController? chatController;
  final ValueChanged<BuildContext>? onOpenSettings;
  final AssistantTextBuilder? assistantTextBuilder;

  @override
  State<LlmStudioApp> createState() => _LlmStudioAppState();
}

class _LlmStudioAppState extends State<LlmStudioApp> {
  late final SettingsController _settingsCtrl;
  late final ProvidersController _providersCtrl;
  late final ConversationsController _convsCtrl;
  late final ChatController _chatCtrl;
  late final bool _ownsControllers;

  @override
  void initState() {
    super.initState();
    _ownsControllers = widget.settingsController == null;
    if (_ownsControllers) {
      final store = SettingsStore();
      final gateway = GatewayClient(baseUrl: AppSettings.defaultBaseUrl());
      _settingsCtrl = SettingsController(store: store, gateway: gateway);
      _providersCtrl = ProvidersController(gateway: gateway);
      _convsCtrl = ConversationsController(gateway: gateway);
      _chatCtrl = ChatController(
        gateway: gateway,
        onConversationUpdated: _convsCtrl.upsertLocal,
      );
      _settingsCtrl.load();
    } else {
      _settingsCtrl = widget.settingsController!;
      _providersCtrl = widget.providersController!;
      _convsCtrl = widget.conversationsController!;
      _chatCtrl = widget.chatController!;
    }
  }

  @override
  void dispose() {
    if (_ownsControllers) {
      _chatCtrl.dispose();
      _convsCtrl.dispose();
      _providersCtrl.dispose();
      _settingsCtrl.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: _settingsCtrl),
        ChangeNotifierProvider.value(value: _providersCtrl),
        ChangeNotifierProvider.value(value: _convsCtrl),
        ChangeNotifierProvider.value(value: _chatCtrl),
      ],
      child: Consumer<SettingsController>(
        builder: (context, settingsCtrl, _) {
          final settings = settingsCtrl.settings;
          final seed = Color(settings.seedColorValue);
          return MaterialApp(
            title: 'LLMStudio',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.build(brightness: Brightness.light, seedColor: seed),
            darkTheme:
                AppTheme.build(brightness: Brightness.dark, seedColor: seed),
            themeMode: settings.themeMode,
            home: Builder(
              builder: (ctx) => WorkbenchShell(
                onOpenSettings: widget.onOpenSettings != null
                    ? () => widget.onOpenSettings!(ctx)
                    : null,
                assistantTextBuilder: widget.assistantTextBuilder,
              ),
            ),
          );
        },
      ),
    );
  }
}
