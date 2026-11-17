import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/models/plugin_models.dart';
import '../../core/state/assistants_controller.dart';
import '../../core/state/chat_controller.dart';
import '../../core/state/conversations_controller.dart';
import '../../core/state/plugins_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import '../settings/settings_page.dart';
import 'assistant_sidebar.dart';
import 'chat_canvas.dart';
import 'composer_bar.dart';
import 'conversation_sidebar.dart';
import 'session_params_sheet.dart';

class NewConversationIntent extends Intent {
  const NewConversationIntent();
}

class EscapeWorkbenchIntent extends Intent {
  const EscapeWorkbenchIntent();
}

class WorkbenchShell extends StatefulWidget {
  const WorkbenchShell({
    super.key,
    this.onOpenSettings,
    this.assistantTextBuilder,
    this.onPickAttachments,
  });

  final VoidCallback? onOpenSettings;
  final AssistantTextBuilder? assistantTextBuilder;
  final AttachmentPickerCallback? onPickAttachments;

  @override
  State<WorkbenchShell> createState() => _WorkbenchShellState();
}

class _WorkbenchShellState extends State<WorkbenchShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  bool _desktopPanesOpen = true;
  bool _mediumSidebarOpen = false;
  int _compactNavTab = 0; // 0: 助手, 1: 话题
  bool _paramsOpen = false;
  String _draftProviderId = '';
  String _draftModelId = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    final settingsCtrl = context.read<SettingsController>();
    final providersCtrl = context.read<ProvidersController>();
    final assistantsCtrl = context.read<AssistantsController>();
    final convsCtrl = context.read<ConversationsController>();
    final pluginsCtrl = context.read<PluginsController>();
    final chatCtrl = context.read<ChatController>();
    await settingsCtrl.load();
    if (!mounted) return;

    // Avoid firing unauthenticated /api/v1 requests before the user configures a token.
    if (settingsCtrl.settings.accessToken.trim().isEmpty) {
      try {
        final health = await settingsCtrl.gateway.healthCheck();
        if (!mounted) return;
        if (health['authRequired'] == true) {
          return;
        }
      } catch (_) {
        // Proceed with standard refresh when healthCheck fails or is stubbed.
      }
    }

    await Future.wait([
      providersCtrl.refresh(),
      assistantsCtrl.refresh(),
      convsCtrl.refresh(),
      pluginsCtrl.refresh(),
    ]);
    if (!mounted) return;
    convsCtrl.setActiveAssistantId(assistantsCtrl.activeAssistantId);
    final activeId = convsCtrl.activeId;
    if (activeId != null) {
      await chatCtrl.loadConversation(activeId);
    }
  }

  Future<void> _selectAssistant(String assistantId) async {
    final assistantsCtrl = context.read<AssistantsController>();
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();

    assistantsCtrl.selectAssistant(assistantId);
    convsCtrl.setActiveAssistantId(assistantId);
    final nextId = convsCtrl.activeId;
    if (nextId != null) {
      await chatCtrl.loadConversation(nextId);
    } else {
      chatCtrl.clearSession();
    }
  }

  (String, String) _resolveTargetModel(
    ProvidersController providersCtrl,
    AssistantsController assistantsCtrl,
    ConversationsController convsCtrl,
  ) {
    final conv = convsCtrl.activeConversation;
    final activeAssistant = assistantsCtrl.activeAssistant;
    final fallback = providersCtrl.defaultModel();

    final providerId = (conv?.providerId.isNotEmpty == true)
        ? conv!.providerId
        : (_draftProviderId.isNotEmpty
            ? _draftProviderId
            : (activeAssistant.defaultProviderId.isNotEmpty
                ? activeAssistant.defaultProviderId
                : (fallback?.provider.id ?? '')));

    final modelId = (conv?.modelId.isNotEmpty == true)
        ? conv!.modelId
        : (_draftModelId.isNotEmpty
            ? _draftModelId
            : (activeAssistant.defaultModelId.isNotEmpty
                ? activeAssistant.defaultModelId
                : (fallback?.model.id ?? '')));

    return (providerId, modelId);
  }

  Future<void> _createNewConversation() async {
    final providersCtrl = context.read<ProvidersController>();
    final assistantsCtrl = context.read<AssistantsController>();
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();

    final activeAssistant = assistantsCtrl.activeAssistant;
    final fallback = providersCtrl.defaultModel();
    final providerId = _draftProviderId.isNotEmpty
        ? _draftProviderId
        : (activeAssistant.defaultProviderId.isNotEmpty
            ? activeAssistant.defaultProviderId
            : (fallback?.provider.id ?? ''));
    final modelId = _draftModelId.isNotEmpty
        ? _draftModelId
        : (activeAssistant.defaultModelId.isNotEmpty
            ? activeAssistant.defaultModelId
            : (fallback?.model.id ?? ''));

    final conv = await convsCtrl.createConversation(
      assistantId: assistantsCtrl.activeAssistantId,
      providerId: providerId,
      modelId: modelId,
    );
    if (!mounted) return;
    await chatCtrl.loadConversation(conv.id);
  }

  Future<void> _selectConversation(String id) async {
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();
    convsCtrl.setActiveId(id);
    await chatCtrl.loadConversation(id);
  }

  Future<void> _handleSend(
    String text,
    List<ComposerAttachment> attachments,
  ) async {
    final providersCtrl = context.read<ProvidersController>();
    final assistantsCtrl = context.read<AssistantsController>();
    final convsCtrl = context.read<ConversationsController>();
    final pluginsCtrl = context.read<PluginsController>();
    final chatCtrl = context.read<ChatController>();

    var conv = convsCtrl.activeConversation;
    final (activeProviderId, activeModelId) =
        _resolveTargetModel(providersCtrl, assistantsCtrl, convsCtrl);

    if (activeProviderId.isEmpty || activeModelId.isEmpty) return;

    if (conv == null) {
      conv = await convsCtrl.createConversation(
        assistantId: assistantsCtrl.activeAssistantId,
        providerId: activeProviderId,
        modelId: activeModelId,
      );
      if (!mounted) return;
      await chatCtrl.loadConversation(conv.id);
      if (!mounted) return;
    }

    await chatCtrl.sendMessage(
      text,
      providerId: activeProviderId,
      modelId: activeModelId,
      attachments: attachments,
      webSearch: pluginsCtrl.webSearchEnabled,
      searchEngineId: pluginsCtrl.selectedSearchEngineId,
    );
  }

  Future<void> _handleSelectModel(String providerId, String modelId) async {
    setState(() {
      _draftProviderId = providerId;
      _draftModelId = modelId;
    });
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();
    final conv = convsCtrl.activeConversation;
    if (conv != null) {
      await convsCtrl.patchConversation(
        conv.id,
        providerId: providerId,
        modelId: modelId,
      );
      if (!mounted) return;
      await chatCtrl.loadConversation(conv.id);
    }
  }

  Future<void> _handleBranchMessage(String messageId) async {
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();
    final conv = convsCtrl.activeConversation;
    if (conv == null) return;
    final detail = await convsCtrl.branchFromMessage(conv.id, messageId);
    if (!mounted) return;
    chatCtrl.applyBranchedDetail(detail);
  }

  void _toggleSidebar(WindowSizeClass sizeClass) {
    if (sizeClass == WindowSizeClass.compact) {
      _scaffoldKey.currentState?.openDrawer();
      return;
    }
    setState(() {
      if (sizeClass == WindowSizeClass.medium) {
        _mediumSidebarOpen = !_mediumSidebarOpen;
      } else {
        _desktopPanesOpen = !_desktopPanesOpen;
      }
    });
  }

  void _toggleParams(WindowSizeClass sizeClass) {
    if (sizeClass != WindowSizeClass.expanded) {
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (ctx) => SizedBox(
          height: MediaQuery.of(ctx).size.height * 0.78,
          child: SessionParamsSheet(
            onClose: () => Navigator.of(ctx).pop(),
          ),
        ),
      );
      return;
    }
    setState(() => _paramsOpen = !_paramsOpen);
  }

  void _handleEscape() {
    final chatCtrl = context.read<ChatController>();
    if (chatCtrl.isBusy) {
      chatCtrl.stopStreaming();
      return;
    }
    if (_scaffoldKey.currentState?.isDrawerOpen == true) {
      Navigator.of(context).pop();
      return;
    }
    if (_paramsOpen || _mediumSidebarOpen) {
      setState(() {
        _paramsOpen = false;
        _mediumSidebarOpen = false;
      });
    }
  }

  Widget _buildTabbedDrawerContent({VoidCallback? onCloseDrawer}) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      color: scheme.surfaceContainerLow,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              MdSpacing.md,
              MdSpacing.sm,
              MdSpacing.md,
              0,
            ),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 0, label: Text('助手')),
                ButtonSegment(value: 1, label: Text('话题')),
              ],
              selected: {_compactNavTab},
              onSelectionChanged: (val) =>
                  setState(() => _compactNavTab = val.first),
            ),
          ),
          Expanded(
            child: _compactNavTab == 0
                ? AssistantSidebar(
                    onSelectAssistant: _selectAssistant,
                    onCloseDrawer: onCloseDrawer,
                  )
                : ConversationSidebar(
                    onSelectConversation: _selectConversation,
                    onCreateConversation: _createNewConversation,
                    onCloseDrawer: onCloseDrawer,
                  ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final assistantsCtrl = context.watch<AssistantsController>();
    final convsCtrl = context.watch<ConversationsController>();
    final providersCtrl = context.watch<ProvidersController>();
    final pluginsCtrl = context.watch<PluginsController>();
    final chatCtrl = context.watch<ChatController>();

    final (selectedProviderId, selectedModelId) =
        _resolveTargetModel(providersCtrl, assistantsCtrl, convsCtrl);

    return Shortcuts(
      shortcuts: {
        LogicalKeySet(LogicalKeyboardKey.control, LogicalKeyboardKey.keyN):
            const NewConversationIntent(),
        LogicalKeySet(LogicalKeyboardKey.meta, LogicalKeyboardKey.keyN):
            const NewConversationIntent(),
        LogicalKeySet(LogicalKeyboardKey.escape): const EscapeWorkbenchIntent(),
      },
      child: Actions(
        actions: {
          NewConversationIntent: CallbackAction<NewConversationIntent>(
            onInvoke: (_) {
              _createNewConversation();
              return null;
            },
          ),
          EscapeWorkbenchIntent: CallbackAction<EscapeWorkbenchIntent>(
            onInvoke: (_) {
              _handleEscape();
              return null;
            },
          ),
        },
        child: Focus(
          autofocus: true,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final sizeClass = MdBreakpoints.classify(constraints.maxWidth);
              final showExpandedPanes =
                  sizeClass == WindowSizeClass.expanded && _desktopPanesOpen;
              final showMediumPane =
                  sizeClass == WindowSizeClass.medium && _mediumSidebarOpen;
              final showInlineParams =
                  sizeClass == WindowSizeClass.expanded && _paramsOpen;
              final openSettings =
                  widget.onOpenSettings ?? () => SettingsPage.open(context);

              return Scaffold(
                key: _scaffoldKey,
                backgroundColor: scheme.surface,
                drawer: sizeClass == WindowSizeClass.compact
                    ? Drawer(
                        width: MdBreakpoints.sidebarWidth,
                        child: SafeArea(
                          child: _buildTabbedDrawerContent(
                            onCloseDrawer: () => Navigator.of(context).pop(),
                          ),
                        ),
                      )
                    : null,
                body: SafeArea(
                  child: Row(
                    children: [
                      if (showExpandedPanes) ...[
                        SizedBox(
                          key: const Key('workbench_assistants_pane'),
                          width: 220,
                          child: AssistantSidebar(
                            onSelectAssistant: _selectAssistant,
                          ),
                        ),
                        const VerticalDivider(width: 1),
                      ],
                      if (showMediumPane) ...[
                        SizedBox(
                          key: const Key('workbench_medium_sidebar_pane'),
                          width: 260,
                          child: _buildTabbedDrawerContent(),
                        ),
                        const VerticalDivider(width: 1),
                      ],
                      Expanded(
                        child: Column(
                          children: [
                            _WorkbenchTopBar(
                              assistantName:
                                  assistantsCtrl.activeAssistant.name,
                              selectedProviderId: selectedProviderId,
                              selectedModelId: selectedModelId,
                              onSelectModel: _handleSelectModel,
                              onToggleSidebar: () => _toggleSidebar(sizeClass),
                              onToggleParams: () => _toggleParams(sizeClass),
                              onOpenSettings: openSettings,
                            ),
                            const Divider(height: 1),
                            Expanded(
                              child: Center(
                                child: ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: MdBreakpoints.maxReadableWidth,
                                  ),
                                  child: Column(
                                    children: [
                                      Expanded(
                                        child: ChatCanvas(
                                          onRetry: () => chatCtrl.retry(
                                            providerId: selectedProviderId,
                                            modelId: selectedModelId,
                                          ),
                                          onRetryMessage: (msgId) =>
                                              chatCtrl.retryMessage(
                                            msgId,
                                            providerId: selectedProviderId,
                                            modelId: selectedModelId,
                                            webSearch:
                                                pluginsCtrl.webSearchEnabled,
                                            searchEngineId: pluginsCtrl
                                                .selectedSearchEngineId,
                                          ),
                                          onDeleteMessage:
                                              chatCtrl.deleteMessage,
                                          onBranchMessage: _handleBranchMessage,
                                          onOpenSettings: openSettings,
                                          assistantTextBuilder:
                                              widget.assistantTextBuilder,
                                        ),
                                      ),
                                      Padding(
                                        padding: const EdgeInsets.fromLTRB(
                                          MdSpacing.lg,
                                          MdSpacing.xs,
                                          MdSpacing.lg,
                                          MdSpacing.lg,
                                        ),
                                        child: ComposerBar(
                                          selectedProviderId:
                                              selectedProviderId,
                                          selectedModelId: selectedModelId,
                                          onSend: _handleSend,
                                          onStop: chatCtrl.stopStreaming,
                                          onPickAttachments:
                                              widget.onPickAttachments,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (showInlineParams) ...[
                        const VerticalDivider(width: 1),
                        SizedBox(
                          key: const Key('workbench_params_pane'),
                          width: MdBreakpoints.inspectorWidth,
                          child: SessionParamsSheet(
                            onClose: () => setState(() => _paramsOpen = false),
                          ),
                        ),
                      ],
                      if (showExpandedPanes) ...[
                        const VerticalDivider(width: 1),
                        SizedBox(
                          key: const Key('workbench_history_pane'),
                          width: 260,
                          child: ConversationSidebar(
                            onSelectConversation: _selectConversation,
                            onCreateConversation: _createNewConversation,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

class _WorkbenchTopBar extends StatelessWidget {
  const _WorkbenchTopBar({
    required this.assistantName,
    required this.selectedProviderId,
    required this.selectedModelId,
    required this.onSelectModel,
    required this.onToggleSidebar,
    required this.onToggleParams,
    required this.onOpenSettings,
  });

  final String assistantName;
  final String selectedProviderId;
  final String selectedModelId;
  final void Function(String providerId, String modelId) onSelectModel;
  final VoidCallback onToggleSidebar;
  final VoidCallback onToggleParams;
  final VoidCallback onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final providersCtrl = context.watch<ProvidersController>();
    final options = providersCtrl.availableModels;
    final currentOption = providersCtrl.resolveModel(
          selectedProviderId,
          selectedModelId,
        ) ??
        providersCtrl.defaultModel();

    final modelLabel = currentOption != null
        ? '${currentOption.model.name} | ${currentOption.provider.name}'
        : '选择模型';

    return Container(
      height: 56,
      color: scheme.surface,
      padding: const EdgeInsets.symmetric(horizontal: MdSpacing.sm),
      child: Row(
        children: [
          AppIconAction(
            key: const Key('topbar_sidebar_button'),
            svg: AppIcons.sidebar,
            tooltip: '切换侧栏',
            onPressed: onToggleSidebar,
          ),
          const SizedBox(width: MdSpacing.xs),
          Flexible(
            flex: 0,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Text(
                assistantName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: AppSvgIcon(
              AppIcons.chevronRight,
              size: 14,
              color: scheme.onSurfaceVariant,
            ),
          ),
          Expanded(
            child: Align(
              alignment: Alignment.centerLeft,
              child: PopupMenuButton<ModelOption>(
                key: const Key('topbar_model_selector'),
                tooltip: '切换供应商与模型',
                enabled: options.isNotEmpty,
                onSelected: (opt) =>
                    onSelectModel(opt.provider.id, opt.model.id),
                itemBuilder: (ctx) => [
                  for (final opt in options)
                    PopupMenuItem<ModelOption>(
                      value: opt,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (currentOption != null &&
                              opt.provider.id == currentOption.provider.id &&
                              opt.model.id == currentOption.model.id)
                            Padding(
                              padding: const EdgeInsets.only(right: 6),
                              child: AppSvgIcon(
                                AppIcons.check,
                                size: 14,
                                color: scheme.primary,
                              ),
                            ),
                          Flexible(
                            child: Text(
                              '${opt.model.name} | ${opt.provider.name}',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: MdSpacing.md,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerLow,
                    borderRadius: BorderRadius.circular(MdRadii.full),
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      AppSvgIcon(
                        AppIcons.cpu,
                        size: 14,
                        color: scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          modelLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: textTheme.labelMedium,
                        ),
                      ),
                      const SizedBox(width: 4),
                      AppSvgIcon(
                        AppIcons.chevronDown,
                        size: 14,
                        color: scheme.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          AppIconAction(
            key: const Key('topbar_params_button'),
            svg: AppIcons.sliders,
            tooltip: '话题参数',
            onPressed: onToggleParams,
          ),
          AppIconAction(
            key: const Key('topbar_settings_button'),
            svg: AppIcons.settings,
            tooltip: '设置',
            onPressed: onOpenSettings,
          ),
        ],
      ),
    );
  }
}
