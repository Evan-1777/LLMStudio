import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/models/app_settings.dart';
import 'core/models/plugin_models.dart';
import 'core/network/gateway_client.dart';
import 'core/state/assistants_controller.dart';
import 'core/state/chat_controller.dart';
import 'core/state/conversations_controller.dart';
import 'core/state/plugins_controller.dart';
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
    this.assistantsController,
    this.pluginsController,
    this.conversationsController,
    this.chatController,
    this.onOpenSettings,
    this.assistantTextBuilder,
    this.onPickAttachments,
  });

  final SettingsController? settingsController;
  final ProvidersController? providersController;
  final AssistantsController? assistantsController;
  final PluginsController? pluginsController;
  final ConversationsController? conversationsController;
  final ChatController? chatController;
  final ValueChanged<BuildContext>? onOpenSettings;
  final AssistantTextBuilder? assistantTextBuilder;
  final Future<List<ComposerAttachment>> Function()? onPickAttachments;

  @override
  State<LlmStudioApp> createState() => _LlmStudioAppState();
}

class _LlmStudioAppState extends State<LlmStudioApp> {
  late final SettingsController _settingsCtrl;
  late final ProvidersController _providersCtrl;
  late final AssistantsController _assistantsCtrl;
  late final PluginsController _pluginsCtrl;
  late final ConversationsController _convsCtrl;
  late final ChatController _chatCtrl;
  late final bool _ownsCoreControllers;
  late final bool _ownsAssistantsCtrl;
  late final bool _ownsPluginsCtrl;

  @override
  void initState() {
    super.initState();
    _ownsCoreControllers = widget.settingsController == null;
    if (_ownsCoreControllers) {
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
    _ownsAssistantsCtrl = widget.assistantsController == null;
    _assistantsCtrl = widget.assistantsController ??
        AssistantsController(gateway: _settingsCtrl.gateway);
    _ownsPluginsCtrl = widget.pluginsController == null;
    _pluginsCtrl = widget.pluginsController ??
        PluginsController(gateway: _settingsCtrl.gateway);
  }

  @override
  void dispose() {
    if (_ownsPluginsCtrl) {
      _pluginsCtrl.dispose();
    }
    if (_ownsAssistantsCtrl) {
      _assistantsCtrl.dispose();
    }
    if (_ownsCoreControllers) {
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
        ChangeNotifierProvider.value(value: _assistantsCtrl),
        ChangeNotifierProvider.value(value: _pluginsCtrl),
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
                onPickAttachments: widget.onPickAttachments,
              ),
            ),
          );
        },
      ),
    );
  }
}
