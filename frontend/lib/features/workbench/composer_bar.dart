import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/models/plugin_models.dart';
import '../../core/state/chat_controller.dart';
import '../../core/state/plugins_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import 'attachment_picker.dart';

typedef ComposerSendCallback = void Function(
  String text,
  List<ComposerAttachment> attachments,
);

typedef AttachmentPickerCallback = Future<List<ComposerAttachment>> Function();

class ComposerBar extends StatefulWidget {
  const ComposerBar({
    super.key,
    required this.selectedProviderId,
    required this.selectedModelId,
    required this.onSend,
    required this.onStop,
    this.onPickAttachments,
  });

  final String selectedProviderId;
  final String selectedModelId;
  final ComposerSendCallback onSend;
  final VoidCallback onStop;
  final AttachmentPickerCallback? onPickAttachments;

  @override
  State<ComposerBar> createState() => _ComposerBarState();
}

class _ComposerBarState extends State<ComposerBar> {
  final TextEditingController _textCtrl = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  final List<ComposerAttachment> _attachments = [];

  @override
  void initState() {
    super.initState();
    _focusNode.onKeyEvent = _handleKeyEvent;
  }

  @override
  void dispose() {
    _textCtrl.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey != LogicalKeyboardKey.enter &&
        event.logicalKey != LogicalKeyboardKey.numpadEnter) {
      return KeyEventResult.ignored;
    }

    if (_textCtrl.value.composing.isValid &&
        !_textCtrl.value.composing.isCollapsed) {
      return KeyEventResult.ignored;
    }

    final enterToSend = context.read<SettingsController>().settings.enterToSend;
    final keys = HardwareKeyboard.instance.logicalKeysPressed;
    final shiftHeld = keys.contains(LogicalKeyboardKey.shiftLeft) ||
        keys.contains(LogicalKeyboardKey.shiftRight);
    final ctrlOrMetaHeld = keys.contains(LogicalKeyboardKey.controlLeft) ||
        keys.contains(LogicalKeyboardKey.controlRight) ||
        keys.contains(LogicalKeyboardKey.metaLeft) ||
        keys.contains(LogicalKeyboardKey.metaRight);

    final shouldSend = enterToSend ? !shiftHeld : ctrlOrMetaHeld;
    if (!shouldSend) return KeyEventResult.ignored;

    _submit();
    return KeyEventResult.handled;
  }

  void _submit() {
    final chatCtrl = context.read<ChatController>();
    if (chatCtrl.isBusy) return;
    final text = _textCtrl.text.trim();
    if (text.isEmpty && _attachments.isEmpty) return;
    final atts = List<ComposerAttachment>.from(_attachments);
    _textCtrl.clear();
    setState(() => _attachments.clear());
    widget.onSend(text, atts);
  }

  Future<void> _pickAttachments() async {
    final picker = widget.onPickAttachments ?? pickComposerAttachments;
    final picked = await picker();
    if (!mounted || picked.isEmpty) return;
    setState(() => _attachments.addAll(picked));
  }

  Future<void> _openMcpDialog(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => const _McpToolSelectorDialog(),
    );
  }

  Future<void> _openThinkingDialog(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => const _ThinkingEffortDialog(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final chatCtrl = context.watch<ChatController>();
    final providersCtrl = context.watch<ProvidersController>();
    final pluginsCtrl = context.watch<PluginsController>();
    final isBusy = chatCtrl.isBusy;
    final currentOption = providersCtrl.resolveModel(
          widget.selectedProviderId,
          widget.selectedModelId,
        ) ??
        providersCtrl.defaultModel();

    final searchEngines = pluginsCtrl.searchEngines;
    final activeEngine = pluginsCtrl.selectedSearchEngine;
    final webSearchOn = pluginsCtrl.webSearchEnabled;
    final thinkingOn = chatCtrl.reasoningEffort != 'none';
    final enabledMcpCount = pluginsCtrl.enabledMcpServers.length;

    return Container(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(MdRadii.xl),
      ),
      padding: const EdgeInsets.fromLTRB(
        MdSpacing.lg,
        MdSpacing.sm,
        MdSpacing.sm,
        MdSpacing.sm,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_attachments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: MdSpacing.xs),
              child: Wrap(
                spacing: MdSpacing.xs,
                runSpacing: MdSpacing.xs,
                children: [
                  for (var i = 0; i < _attachments.length; i++)
                    InputChip(
                      key: Key('attachment_chip_$i'),
                      avatar: AppSvgIcon(
                        _attachments[i].isImage
                            ? AppIcons.image
                            : AppIcons.folder,
                        size: 14,
                        color: scheme.onSurfaceVariant,
                      ),
                      label: Text(
                        _attachments[i].name,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onDeleted: () => setState(() => _attachments.removeAt(i)),
                    ),
                ],
              ),
            ),
          TextField(
            key: const Key('composer_text_field'),
            controller: _textCtrl,
            focusNode: _focusNode,
            minLines: 1,
            maxLines: 7,
            textInputAction: TextInputAction.newline,
            decoration: const InputDecoration(
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: EdgeInsets.symmetric(vertical: MdSpacing.xs),
            ),
          ),
          const SizedBox(height: MdSpacing.xs),
          Row(
            children: [
              // 1. Web Search toggle + engine dropdown
              Container(
                decoration: BoxDecoration(
                  color: webSearchOn
                      ? scheme.primaryContainer
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(MdRadii.full),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppIconAction(
                      key: const Key('composer_web_search_button'),
                      svg: AppIcons.globe,
                      size: 18,
                      tooltip: webSearchOn ? '关闭联网搜索' : '开启联网搜索',
                      color: webSearchOn
                          ? scheme.onPrimaryContainer
                          : scheme.onSurfaceVariant,
                      onPressed: pluginsCtrl.toggleWebSearch,
                    ),
                    PopupMenuButton<String>(
                      key: const Key('composer_search_engine_selector'),
                      tooltip: '选择搜索引擎',
                      padding: EdgeInsets.zero,
                      onSelected: pluginsCtrl.selectSearchEngine,
                      itemBuilder: (ctx) {
                        final items = searchEngines.isNotEmpty
                            ? searchEngines
                            : const [
                                SearchEnginePluginConfig(
                                  engineId: 'tavily',
                                  displayName: 'Tavily Search',
                                  isDefault: true,
                                ),
                                SearchEnginePluginConfig(
                                  engineId: 'searxng',
                                  displayName: 'SearXNG',
                                ),
                              ];
                        return [
                          for (final e in items)
                            PopupMenuItem<String>(
                              value: e.engineId,
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (e.engineId ==
                                      (activeEngine?.engineId ?? 'tavily'))
                                    Padding(
                                      padding: const EdgeInsets.only(right: 6),
                                      child: AppSvgIcon(
                                        AppIcons.check,
                                        size: 14,
                                        color: scheme.primary,
                                      ),
                                    ),
                                  Text(
                                    e.displayName.isNotEmpty
                                        ? e.displayName
                                        : e.engineId,
                                  ),
                                ],
                              ),
                            ),
                        ];
                      },
                      child: Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: AppSvgIcon(
                          AppIcons.chevronDown,
                          size: 14,
                          color: webSearchOn
                              ? scheme.onPrimaryContainer
                              : scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // 2. Attachment upload
              AppIconAction(
                key: const Key('composer_attachment_button'),
                svg: AppIcons.attachment,
                size: 18,
                tooltip: '上传附件',
                onPressed: _pickAttachments,
              ),
              // 3. MCP tools selector
              AppIconAction(
                key: const Key('composer_mcp_button'),
                svg: AppIcons.wrench,
                size: 18,
                tooltip: enabledMcpCount > 0
                    ? 'MCP 工具 ($enabledMcpCount 已启用)'
                    : 'MCP 工具',
                color: enabledMcpCount > 0 ? scheme.primary : null,
                onPressed: () => _openMcpDialog(context),
              ),
              // 4. 6-level thinking effort slider
              AppIconAction(
                key: const Key('composer_thinking_button'),
                svg: AppIcons.lightbulb,
                size: 18,
                tooltip: '思考强度 (${chatCtrl.reasoningEffort})',
                color: thinkingOn ? scheme.primary : null,
                backgroundColor:
                    thinkingOn ? scheme.primaryContainer : null,
                onPressed: () => _openThinkingDialog(context),
              ),
              const Spacer(),
              if (isBusy)
                AppIconAction(
                  key: const Key('composer_stop_button'),
                  svg: AppIcons.stop,
                  tooltip: '停止生成',
                  color: scheme.onPrimary,
                  backgroundColor: scheme.primary,
                  onPressed: widget.onStop,
                )
              else
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _textCtrl,
                  builder: (context, val, _) {
                    final canSend = (val.text.trim().isNotEmpty ||
                            _attachments.isNotEmpty) &&
                        currentOption != null;
                    return AppIconAction(
                      key: const Key('composer_send_button'),
                      svg: AppIcons.send,
                      tooltip: '发送',
                      color: canSend
                          ? scheme.onPrimary
                          : scheme.onSurface.withValues(alpha: 0.38),
                      backgroundColor:
                          canSend ? scheme.primary : scheme.surfaceContainer,
                      onPressed: canSend ? _submit : null,
                    );
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _McpToolSelectorDialog extends StatelessWidget {
  const _McpToolSelectorDialog();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final pluginsCtrl = context.watch<PluginsController>();
    final servers = pluginsCtrl.mcpServers;

    return AlertDialog(
      key: const Key('mcp_selector_dialog'),
      title: const Text('MCP 工具选择'),
      content: SizedBox(
        width: 380,
        child: servers.isEmpty
            ? Text(
                '暂无已配置的 MCP 服务，请前往设置页添加',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
              )
            : SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final s in servers)
                      CheckboxListTile(
                        key: Key('composer_mcp_item_${s.id}'),
                        dense: true,
                        value: s.enabled,
                        onChanged: (v) {
                          if (v != null) {
                            pluginsCtrl.toggleMcpServer(s.id, v);
                          }
                        },
                        title: Text(s.name),
                        subtitle: Text(s.transport),
                      ),
                  ],
                ),
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('完成'),
        ),
      ],
    );
  }
}

class _ThinkingEffortDialog extends StatelessWidget {
  const _ThinkingEffortDialog();

  static const Map<String, String> _labels = {
    'none': '关闭',
    'low': '低',
    'medium': '中',
    'high': '高',
    'xhigh': '极高',
    'max': '最大',
  };

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final chatCtrl = context.watch<ChatController>();
    final levels = ChatController.reasoningEffortLevels;
    final currentIdx = levels.indexOf(chatCtrl.reasoningEffort).clamp(0, 5);

    return AlertDialog(
      key: const Key('thinking_effort_dialog'),
      title: Text('思考强度 · ${_labels[levels[currentIdx]] ?? levels[currentIdx]}'),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Slider(
              key: const Key('thinking_effort_slider'),
              value: currentIdx.toDouble(),
              min: 0,
              max: 5,
              divisions: 5,
              label: _labels[levels[currentIdx]],
              onChanged: (v) {
                final idx = v.round().clamp(0, levels.length - 1);
                chatCtrl.setReasoningEffort(levels[idx]);
              },
            ),
            const SizedBox(height: MdSpacing.xs),
            Wrap(
              spacing: MdSpacing.xs,
              runSpacing: MdSpacing.xs,
              children: [
                for (var i = 0; i < levels.length; i++)
                  ChoiceChip(
                    key: Key('thinking_level_${levels[i]}'),
                    label: Text(_labels[levels[i]] ?? levels[i]),
                    selected: i == currentIdx,
                    selectedColor: scheme.primaryContainer,
                    onSelected: (_) => chatCtrl.setReasoningEffort(levels[i]),
                  ),
              ],
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('确定'),
        ),
      ],
    );
  }
}
