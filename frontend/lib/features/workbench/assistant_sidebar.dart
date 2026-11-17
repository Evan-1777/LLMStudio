import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/assistant.dart';
import '../../core/models/conversation.dart';
import '../../core/state/assistants_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class AssistantSidebar extends StatelessWidget {
  const AssistantSidebar({
    super.key,
    required this.onSelectAssistant,
    this.onCloseDrawer,
  });

  final ValueChanged<String> onSelectAssistant;
  final VoidCallback? onCloseDrawer;

  Future<void> _openEditor(
    BuildContext context, {
    Assistant? existing,
  }) async {
    final assistantsCtrl = context.read<AssistantsController>();
    final providersCtrl = context.read<ProvidersController>();
    final payload = await showDialog<AssistantUpsertPayload>(
      context: context,
      builder: (ctx) => _AssistantEditorDialog(
        existing: existing,
        modelOptions: providersCtrl.availableModels,
      ),
    );
    if (payload == null) return;
    if (existing == null) {
      final created = await assistantsCtrl.createAssistant(payload);
      onSelectAssistant(created.id);
    } else {
      await assistantsCtrl.updateAssistant(existing.id, payload);
    }
  }

  Future<void> _confirmDelete(BuildContext context, Assistant assistant) async {
    final assistantsCtrl = context.read<AssistantsController>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除助手'),
        content: Text('确认删除助手「${assistant.name}」？其话题将自动归入默认助手。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await assistantsCtrl.deleteAssistant(assistant.id);
      onSelectAssistant(assistantsCtrl.activeAssistantId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final assistantsCtrl = context.watch<AssistantsController>();
    final assistants = assistantsCtrl.assistants;

    return Container(
      color: scheme.surfaceContainerLow,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              MdSpacing.md,
              MdSpacing.md,
              MdSpacing.md,
              MdSpacing.sm,
            ),
            child: OutlinedButton.icon(
              key: const Key('add_assistant_button'),
              onPressed: () => _openEditor(context),
              icon: AppSvgIcon(AppIcons.plus, size: 16),
              label: const Text('添加助手'),
            ),
          ),
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(
                horizontal: MdSpacing.sm,
                vertical: MdSpacing.xs,
              ),
              itemCount: assistants.length,
              itemBuilder: (context, index) {
                final a = assistants[index];
                final isSelected = a.id == assistantsCtrl.activeAssistantId;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Material(
                    color: isSelected
                        ? scheme.secondaryContainer
                        : Colors.transparent,
                    borderRadius: BorderRadius.circular(MdRadii.md),
                    child: InkWell(
                      key: Key('assistant_item_${a.id}'),
                      borderRadius: BorderRadius.circular(MdRadii.md),
                      onTap: () {
                        onSelectAssistant(a.id);
                        onCloseDrawer?.call();
                      },
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(
                          MdSpacing.md,
                          MdSpacing.sm,
                          MdSpacing.xs,
                          MdSpacing.sm,
                        ),
                        child: Row(
                          children: [
                            AppSvgIcon(
                              AppIcons.bot,
                              size: 16,
                              color: isSelected
                                  ? scheme.onSecondaryContainer
                                  : scheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: MdSpacing.sm),
                            Expanded(
                              child: Text(
                                a.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: textTheme.bodyMedium?.copyWith(
                                  fontWeight: isSelected
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                  color: isSelected
                                      ? scheme.onSecondaryContainer
                                      : scheme.onSurface,
                                ),
                              ),
                            ),
                            PopupMenuButton<String>(
                              key: Key('assistant_menu_${a.id}'),
                              tooltip: '助手操作',
                              icon: AppSvgIcon(
                                AppIcons.sliders,
                                size: 14,
                                color: scheme.onSurfaceVariant,
                              ),
                              onSelected: (action) {
                                if (action == 'edit') {
                                  _openEditor(context, existing: a);
                                } else if (action == 'delete') {
                                  _confirmDelete(context, a);
                                }
                              },
                              itemBuilder: (ctx) => [
                                const PopupMenuItem(
                                  value: 'edit',
                                  child: Text('编辑助手'),
                                ),
                                if (!a.isDefault)
                                  const PopupMenuItem(
                                    value: 'delete',
                                    child: Text('删除助手'),
                                  ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _AssistantEditorDialog extends StatefulWidget {
  const _AssistantEditorDialog({
    this.existing,
    required this.modelOptions,
  });

  final Assistant? existing;
  final List<ModelOption> modelOptions;

  @override
  State<_AssistantEditorDialog> createState() => _AssistantEditorDialogState();
}

class _AssistantEditorDialogState extends State<_AssistantEditorDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _promptCtrl;
  late final TextEditingController _maxTokensCtrl;
  String _selectedModelKey = '';
  double? _temperature;
  String? _error;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _nameCtrl = TextEditingController(text: e?.name ?? '');
    _promptCtrl = TextEditingController(text: e?.systemPrompt ?? '');
    _maxTokensCtrl = TextEditingController(
      text: e?.params.maxTokens?.toString() ?? '',
    );
    _temperature = e?.params.temperature;
    if (e != null &&
        e.defaultProviderId.isNotEmpty &&
        e.defaultModelId.isNotEmpty) {
      final candidate = '${e.defaultProviderId}::${e.defaultModelId}';
      if (widget.modelOptions
          .any((o) => '${o.provider.id}::${o.model.id}' == candidate)) {
        _selectedModelKey = candidate;
      }
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _promptCtrl.dispose();
    _maxTokensCtrl.dispose();
    super.dispose();
  }

  void _save() {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '助手名称不能为空');
      return;
    }
    var providerId = '';
    var modelId = '';
    if (_selectedModelKey.isNotEmpty) {
      final parts = _selectedModelKey.split('::');
      if (parts.length == 2) {
        providerId = parts[0];
        modelId = parts[1];
      }
    }
    final maxTok = int.tryParse(_maxTokensCtrl.text.trim());
    Navigator.of(context).pop(
      AssistantUpsertPayload(
        name: name,
        systemPrompt: _promptCtrl.text,
        defaultProviderId: providerId,
        defaultModelId: modelId,
        params: GenerationParams(
          temperature: _temperature,
          maxTokens: maxTok != null && maxTok > 0 ? maxTok : null,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.existing == null ? '添加助手' : '编辑助手'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: MdSpacing.sm),
                  child: Text(_error!, style: TextStyle(color: scheme.error)),
                ),
              TextField(
                key: const Key('assistant_name_field'),
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: '助手名称'),
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                key: const Key('assistant_prompt_field'),
                controller: _promptCtrl,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: '预设 System Prompt',
                ),
              ),
              const SizedBox(height: MdSpacing.sm),
              if (widget.modelOptions.isNotEmpty)
                DropdownButtonFormField<String>(
                  initialValue: _selectedModelKey,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: '默认模型',
                  ),
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('跟随工作台默认'),
                    ),
                    for (final opt in widget.modelOptions)
                      DropdownMenuItem(
                        value: '${opt.provider.id}::${opt.model.id}',
                        child: Text(
                          '${opt.model.name} | ${opt.provider.name}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (v) => setState(() => _selectedModelKey = v ?? ''),
                ),
              const SizedBox(height: MdSpacing.md),
              Row(
                children: [
                  Text(
                    'Temperature',
                    style: Theme.of(context).textTheme.labelMedium,
                  ),
                  const Spacer(),
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
              TextField(
                key: const Key('assistant_max_tokens_field'),
                controller: _maxTokensCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'Max Tokens（留空默认）',
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const Key('assistant_save_button'),
          onPressed: _save,
          child: const Text('保存'),
        ),
      ],
    );
  }
}
