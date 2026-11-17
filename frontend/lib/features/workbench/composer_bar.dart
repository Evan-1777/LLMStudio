import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/state/chat_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class ComposerBar extends StatefulWidget {
  const ComposerBar({
    super.key,
    required this.selectedProviderId,
    required this.selectedModelId,
    required this.onSelectModel,
    required this.onSend,
    required this.onStop,
  });

  final String selectedProviderId;
  final String selectedModelId;
  final void Function(String providerId, String modelId) onSelectModel;
  final ValueChanged<String> onSend;
  final VoidCallback onStop;

  @override
  State<ComposerBar> createState() => _ComposerBarState();
}

class _ComposerBarState extends State<ComposerBar> {
  final TextEditingController _textCtrl = TextEditingController();
  final FocusNode _focusNode = FocusNode();

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

    // Do not intercept Enter while IME composition is active.
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
    if (text.isEmpty) return;
    _textCtrl.clear();
    widget.onSend(text);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final chatCtrl = context.watch<ChatController>();
    final providersCtrl = context.watch<ProvidersController>();
    final isBusy = chatCtrl.isBusy;
    final options = providersCtrl.availableModels;
    final currentOption = providersCtrl.resolveModel(
          widget.selectedProviderId,
          widget.selectedModelId,
        ) ??
        providersCtrl.defaultModel();

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
        children: [
          TextField(
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
              if (options.isNotEmpty && currentOption != null)
                Flexible(
                  child: PopupMenuButton<ModelOption>(
                    tooltip: '切换模型',
                    onSelected: (opt) =>
                        widget.onSelectModel(opt.provider.id, opt.model.id),
                    itemBuilder: (ctx) => [
                      for (final opt in options)
                        PopupMenuItem<ModelOption>(
                          value: opt,
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (opt.provider.id == currentOption.provider.id &&
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
                                  '${opt.provider.name} · ${opt.model.name}',
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
                        color: scheme.surfaceContainer,
                        borderRadius: BorderRadius.circular(MdRadii.full),
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
                              currentOption.model.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.labelMedium,
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
                    final canSend = val.text.trim().isNotEmpty &&
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
