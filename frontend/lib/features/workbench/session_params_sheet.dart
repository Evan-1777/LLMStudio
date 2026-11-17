import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/conversation.dart';
import '../../core/state/chat_controller.dart';
import '../../core/state/conversations_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class SessionParamsSheet extends StatefulWidget {
  const SessionParamsSheet({
    super.key,
    this.onClose,
  });

  final VoidCallback? onClose;

  @override
  State<SessionParamsSheet> createState() => _SessionParamsSheetState();
}

class _SessionParamsSheetState extends State<SessionParamsSheet> {
  final TextEditingController _systemPromptCtrl = TextEditingController();
  final TextEditingController _maxTokensCtrl = TextEditingController();
  String? _loadedConvId;
  double? _temperature;
  bool _saving = false;

  @override
  void dispose() {
    _systemPromptCtrl.dispose();
    _maxTokensCtrl.dispose();
    super.dispose();
  }

  void _syncFromConversation(Conversation? conv) {
    if (conv == null) {
      if (_loadedConvId != null) {
        _loadedConvId = null;
        _systemPromptCtrl.clear();
        _maxTokensCtrl.clear();
        _temperature = null;
      }
      return;
    }
    if (_loadedConvId == conv.id) return;
    _loadedConvId = conv.id;
    _systemPromptCtrl.text = conv.systemPrompt;
    _temperature = conv.params.temperature;
    _maxTokensCtrl.text = conv.params.maxTokens?.toString() ?? '';
  }

  Future<void> _applyChanges(Conversation conv) async {
    setState(() => _saving = true);
    try {
      final parsedMax = int.tryParse(_maxTokensCtrl.text.trim());
      await context.read<ConversationsController>().patchConversation(
            conv.id,
            systemPrompt: _systemPromptCtrl.text,
            params: GenerationParams(
              temperature: _temperature,
              maxTokens: parsedMax != null && parsedMax > 0 ? parsedMax : null,
              reasoningEffort: conv.params.reasoningEffort,
            ),
            clearNullParams: true,
          );
      if (!mounted) return;
      await context.read<ChatController>().loadConversation(conv.id);
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  Future<void> _resetParams(Conversation conv) async {
    setState(() {
      _temperature = null;
      _maxTokensCtrl.clear();
    });
    await _applyChanges(conv);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final convsCtrl = context.watch<ConversationsController>();
    final conv = convsCtrl.activeConversation;
    _syncFromConversation(conv);

    return Container(
      color: scheme.surfaceContainer,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              MdSpacing.lg,
              MdSpacing.md,
              MdSpacing.sm,
              MdSpacing.sm,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '话题参数',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ),
                if (widget.onClose != null)
                  AppIconAction(
                    svg: AppIcons.close,
                    tooltip: '关闭',
                    onPressed: widget.onClose,
                  ),
              ],
            ),
          ),
          const Divider(height: 1),
          if (conv == null)
            const Expanded(child: SizedBox.shrink())
          else
            Expanded(
              child: ListView(
                padding: const EdgeInsets.all(MdSpacing.lg),
                children: [
                  Text(
                    '系统提示词覆盖',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                  const SizedBox(height: MdSpacing.xs),
                  TextField(
                    key: const Key('session_system_prompt_field'),
                    controller: _systemPromptCtrl,
                    maxLines: 5,
                    minLines: 3,
                    decoration: const InputDecoration(
                      hintText: '留空继承助手预设',
                    ),
                  ),
                  const SizedBox(height: MdSpacing.lg),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Temperature',
                          style: Theme.of(context).textTheme.labelMedium,
                        ),
                      ),
                      Text(
                        _temperature == null
                            ? '默认'
                            : _temperature!.toStringAsFixed(2),
                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                              color: scheme.primary,
                            ),
                      ),
                    ],
                  ),
                  Slider(
                    value: (_temperature ?? 0.7).clamp(0.0, 2.0),
                    min: 0.0,
                    max: 2.0,
                    divisions: 40,
                    onChanged: (v) => setState(() => _temperature = v),
                  ),
                  const SizedBox(height: MdSpacing.md),
                  Text(
                    'Max Tokens',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                  const SizedBox(height: MdSpacing.xs),
                  TextField(
                    key: const Key('session_max_tokens_field'),
                    controller: _maxTokensCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      isDense: true,
                      hintText: '默认',
                    ),
                  ),
                  const SizedBox(height: MdSpacing.xl),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppIconAction(
                        svg: AppIcons.refresh,
                        tooltip: '重置参数',
                        onPressed: _saving ? null : () => _resetParams(conv),
                      ),
                      const SizedBox(width: MdSpacing.sm),
                      FilledButton(
                        onPressed: _saving ? null : () => _applyChanges(conv),
                        child: const Text('应用'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
