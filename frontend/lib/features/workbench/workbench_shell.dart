import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/state/chat_controller.dart';
import '../../core/state/conversations_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import '../settings/settings_dialog.dart';
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
  });

  final VoidCallback? onOpenSettings;
  final AssistantTextBuilder? assistantTextBuilder;

  @override
  State<WorkbenchShell> createState() => _WorkbenchShellState();
}

class _WorkbenchShellState extends State<WorkbenchShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  bool _desktopSidebarOpen = true;
  bool _mediumSidebarOpen = false;
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
    final convsCtrl = context.read<ConversationsController>();
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
      convsCtrl.refresh(),
    ]);
    if (!mounted) return;
    final activeId = convsCtrl.activeId;
    if (activeId != null) {
      await chatCtrl.loadConversation(activeId);
    }
  }

  Future<void> _createNewConversation() async {
    final providersCtrl = context.read<ProvidersController>();
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();

    final fallback = providersCtrl.defaultModel();
    final providerId = _draftProviderId.isNotEmpty
        ? _draftProviderId
        : (fallback?.provider.id ?? '');
    final modelId =
        _draftModelId.isNotEmpty ? _draftModelId : (fallback?.model.id ?? '');

    final conv = await convsCtrl.createConversation(
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

  Future<void> _handleSend(String text) async {
    final providersCtrl = context.read<ProvidersController>();
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();

    var conv = convsCtrl.activeConversation;
    final fallback = providersCtrl.defaultModel();
    final activeProviderId = (conv?.providerId.isNotEmpty == true)
        ? conv!.providerId
        : (_draftProviderId.isNotEmpty
            ? _draftProviderId
            : (fallback?.provider.id ?? ''));
    final activeModelId = (conv?.modelId.isNotEmpty == true)
        ? conv!.modelId
        : (_draftModelId.isNotEmpty
            ? _draftModelId
            : (fallback?.model.id ?? ''));

    if (activeProviderId.isEmpty || activeModelId.isEmpty) return;

    if (conv == null) {
      conv = await convsCtrl.createConversation(
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

  void _toggleSidebar(WindowSizeClass sizeClass) {
    if (sizeClass == WindowSizeClass.compact) {
      _scaffoldKey.currentState?.openDrawer();
      return;
    }
    setState(() {
      if (sizeClass == WindowSizeClass.medium) {
        _mediumSidebarOpen = !_mediumSidebarOpen;
      } else {
        _desktopSidebarOpen = !_desktopSidebarOpen;
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

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final convsCtrl = context.watch<ConversationsController>();
    final providersCtrl = context.watch<ProvidersController>();
    final chatCtrl = context.watch<ChatController>();
    final activeConv = convsCtrl.activeConversation;

    final fallback = providersCtrl.defaultModel();
    final selectedProviderId = (activeConv?.providerId.isNotEmpty == true)
        ? activeConv!.providerId
        : (_draftProviderId.isNotEmpty
            ? _draftProviderId
            : (fallback?.provider.id ?? ''));
    final selectedModelId = (activeConv?.modelId.isNotEmpty == true)
        ? activeConv!.modelId
        : (_draftModelId.isNotEmpty
            ? _draftModelId
            : (fallback?.model.id ?? ''));

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
              final showInlineSidebar = switch (sizeClass) {
                WindowSizeClass.compact => false,
                WindowSizeClass.medium => _mediumSidebarOpen,
                WindowSizeClass.expanded => _desktopSidebarOpen,
              };
              final showInlineParams =
                  sizeClass == WindowSizeClass.expanded && _paramsOpen;
              final openSettings =
                  widget.onOpenSettings ?? () => SettingsDialog.show(context);

              return Scaffold(
                key: _scaffoldKey,
                backgroundColor: scheme.surface,
                drawer: sizeClass == WindowSizeClass.compact
                    ? Drawer(
                        width: MdBreakpoints.sidebarWidth,
                        child: SafeArea(
                          child: ConversationSidebar(
                            onSelectConversation: _selectConversation,
                            onCreateConversation: _createNewConversation,
                            onOpenSettings: openSettings,
                            onCloseDrawer: () => Navigator.of(context).pop(),
                          ),
                        ),
                      )
                    : null,
                body: SafeArea(
                  child: Row(
                    children: [
                      if (showInlineSidebar)
                        SizedBox(
                          key: const Key('workbench_sidebar_pane'),
                          width: MdBreakpoints.sidebarWidth,
                          child: ConversationSidebar(
                            onSelectConversation: _selectConversation,
                            onCreateConversation: _createNewConversation,
                            onOpenSettings: openSettings,
                          ),
                        ),
                      if (showInlineSidebar) const VerticalDivider(width: 1),
                      Expanded(
                        child: Column(
                          children: [
                            _WorkbenchTopBar(
                              title: activeConv?.title ?? 'LLMStudio',
                              onToggleSidebar: () => _toggleSidebar(sizeClass),
                              onNewConversation: _createNewConversation,
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
                                          onRegenerate: (msgId) =>
                                              chatCtrl.regenerate(
                                            msgId,
                                            providerId: selectedProviderId,
                                            modelId: selectedModelId,
                                          ),
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
                                          onSelectModel: _handleSelectModel,
                                          onSend: _handleSend,
                                          onStop: chatCtrl.stopStreaming,
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
                      if (showInlineParams) const VerticalDivider(width: 1),
                      if (showInlineParams)
                        SizedBox(
                          key: const Key('workbench_params_pane'),
                          width: MdBreakpoints.inspectorWidth,
                          child: SessionParamsSheet(
                            onClose: () => setState(() => _paramsOpen = false),
                          ),
                        ),
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
    required this.title,
    required this.onToggleSidebar,
    required this.onNewConversation,
    required this.onToggleParams,
    this.onOpenSettings,
  });

  final String title;
  final VoidCallback onToggleSidebar;
  final VoidCallback onNewConversation;
  final VoidCallback onToggleParams;
  final VoidCallback? onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      height: 56,
      color: scheme.surface,
      padding: const EdgeInsets.symmetric(horizontal: MdSpacing.sm),
      child: Row(
        children: [
          AppIconAction(
            key: const Key('topbar_sidebar_button'),
            svg: AppIcons.sidebar,
            tooltip: '会话列表',
            onPressed: onToggleSidebar,
          ),
          const SizedBox(width: MdSpacing.xs),
          Expanded(
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          AppIconAction(
            key: const Key('topbar_new_chat_button'),
            svg: AppIcons.plus,
            tooltip: '新建会话',
            onPressed: onNewConversation,
          ),
          AppIconAction(
            key: const Key('topbar_params_button'),
            svg: AppIcons.sliders,
            tooltip: '会话参数',
            onPressed: onToggleParams,
          ),
          if (onOpenSettings != null)
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
