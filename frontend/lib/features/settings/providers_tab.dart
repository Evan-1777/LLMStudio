import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/provider.dart';
import '../../core/state/providers_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class ProvidersTab extends StatelessWidget {
  const ProvidersTab({super.key});

  Future<void> _openEditor(
    BuildContext context, {
    ProviderConfig? existing,
  }) async {
    final providersCtrl = context.read<ProvidersController>();
    final result = await showDialog<ProviderUpsertPayload>(
      context: context,
      builder: (ctx) => _ProviderEditorDialog(
        existing: existing,
        formats: providersCtrl.formats,
      ),
    );
    if (result == null) return;
    if (existing == null) {
      await providersCtrl.createProvider(result);
    } else {
      await providersCtrl.updateProvider(existing.id, result);
    }
  }

  Future<void> _confirmDelete(
    BuildContext context,
    ProviderConfig provider,
  ) async {
    final providersCtrl = context.read<ProvidersController>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除供应商'),
        content: Text('确认删除「${provider.name}」？'),
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
      await providersCtrl.deleteProvider(provider.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final providersCtrl = context.watch<ProvidersController>();
    final providers = providersCtrl.providers;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            MdSpacing.lg,
            MdSpacing.md,
            MdSpacing.md,
            MdSpacing.sm,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '${providers.length} 个供应商',
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                ),
              ),
              AppIconAction(
                key: const Key('settings_add_provider_button'),
                svg: AppIcons.plus,
                tooltip: '新增供应商',
                onPressed: () => _openEditor(context),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(MdSpacing.md),
            itemCount: providers.length,
            separatorBuilder: (_, _) => const SizedBox(height: MdSpacing.sm),
            itemBuilder: (context, index) {
              final p = providers[index];
              final keyLabel = p.authType == 'none'
                  ? '无密钥'
                  : (p.apiKeySet ? p.apiKeyMasked : '未配置密钥');
              return Container(
                padding: const EdgeInsets.all(MdSpacing.md),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(MdRadii.md),
                  border: Border.all(color: scheme.outlineVariant),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Flexible(
                                child: Text(
                                  p.name,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleSmall
                                      ?.copyWith(fontWeight: FontWeight.w600),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              const SizedBox(width: MdSpacing.sm),
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 6,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: p.apiKeySet || p.authType == 'none'
                                      ? scheme.secondaryContainer
                                      : scheme.surfaceContainerHigh,
                                  borderRadius:
                                      BorderRadius.circular(MdRadii.full),
                                ),
                                child: Text(
                                  keyLabel,
                                  style: Theme.of(context).textTheme.labelSmall,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '${p.baseUrl} · ${p.models.length} 模型',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style:
                                Theme.of(context).textTheme.bodySmall?.copyWith(
                                      color: scheme.onSurfaceVariant,
                                    ),
                          ),
                        ],
                      ),
                    ),
                    Switch(
                      value: p.enabled,
                      onChanged: (val) => providersCtrl.updateProvider(
                        p.id,
                        ProviderUpsertPayload(
                          name: p.name,
                          adapter: p.adapter,
                          baseUrl: p.baseUrl,
                          authType: p.authType,
                          headers: p.headers,
                          models: p.models,
                          enabled: val,
                        ),
                      ),
                    ),
                    AppIconAction(
                      key: Key('edit_provider_${p.id}'),
                      svg: AppIcons.edit,
                      tooltip: '编辑',
                      onPressed: () => _openEditor(context, existing: p),
                    ),
                    AppIconAction(
                      key: Key('delete_provider_${p.id}'),
                      svg: AppIcons.trash,
                      tooltip: '删除',
                      onPressed: () => _confirmDelete(context, p),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ModelDraft {
  _ModelDraft({
    required this.idCtrl,
    required this.nameCtrl,
    required this.apiFormat,
    required this.reasoning,
    required this.maxTokensFieldCtrl,
    required this.thinkingFormatCtrl,
    required this.reasoningEffortFieldCtrl,
    required this.pathOverrideCtrl,
    required this.extraHeadersCtrl,
    required this.extraBodyCtrl,
    required this.supportsDeveloperRole,
    required this.supportsStreamOptions,
  });

  final TextEditingController idCtrl;
  final TextEditingController nameCtrl;
  String apiFormat;
  bool reasoning;
  final TextEditingController maxTokensFieldCtrl;
  final TextEditingController thinkingFormatCtrl;
  final TextEditingController reasoningEffortFieldCtrl;
  final TextEditingController pathOverrideCtrl;
  final TextEditingController extraHeadersCtrl;
  final TextEditingController extraBodyCtrl;
  bool? supportsDeveloperRole;
  bool? supportsStreamOptions;

  factory _ModelDraft.fromModel(ModelConfig m, String defaultFormat) {
    return _ModelDraft(
      idCtrl: TextEditingController(text: m.id),
      nameCtrl: TextEditingController(text: m.name),
      apiFormat: m.apiFormat.isNotEmpty ? m.apiFormat : defaultFormat,
      reasoning: m.reasoning,
      maxTokensFieldCtrl: TextEditingController(text: m.compat.maxTokensField),
      thinkingFormatCtrl: TextEditingController(text: m.compat.thinkingFormat),
      reasoningEffortFieldCtrl:
          TextEditingController(text: m.compat.reasoningEffortField),
      pathOverrideCtrl: TextEditingController(text: m.compat.pathOverride),
      extraHeadersCtrl: TextEditingController(
        text: m.compat.extraHeaders.isEmpty
            ? ''
            : jsonEncode(m.compat.extraHeaders),
      ),
      extraBodyCtrl: TextEditingController(
        text: m.compat.extraBody.isEmpty ? '' : jsonEncode(m.compat.extraBody),
      ),
      supportsDeveloperRole: m.compat.supportsDeveloperRole,
      supportsStreamOptions: m.compat.supportsStreamOptions,
    );
  }

  void dispose() {
    idCtrl.dispose();
    nameCtrl.dispose();
    maxTokensFieldCtrl.dispose();
    thinkingFormatCtrl.dispose();
    reasoningEffortFieldCtrl.dispose();
    pathOverrideCtrl.dispose();
    extraHeadersCtrl.dispose();
    extraBodyCtrl.dispose();
  }
}

class _ProviderEditorDialog extends StatefulWidget {
  const _ProviderEditorDialog({
    required this.existing,
    required this.formats,
  });

  final ProviderConfig? existing;
  final List<FormatInfo> formats;

  @override
  State<_ProviderEditorDialog> createState() => _ProviderEditorDialogState();
}

class _ProviderEditorDialogState extends State<_ProviderEditorDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _baseUrlCtrl;
  late final TextEditingController _apiKeyCtrl;
  late String _authType;
  late bool _enabled;
  bool _clearApiKey = false;
  late final List<_ModelDraft> _models;
  String? _validationError;

  String get _defaultFormat =>
      widget.formats.isNotEmpty ? widget.formats.first.id : 'openai-completions';

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _nameCtrl = TextEditingController(text: e?.name ?? '');
    _baseUrlCtrl = TextEditingController(text: e?.baseUrl ?? '');
    _apiKeyCtrl = TextEditingController();
    _authType = e?.authType ?? 'bearer';
    _enabled = e?.enabled ?? true;
    _models = [
      for (final m in (e?.models ?? const <ModelConfig>[]))
        _ModelDraft.fromModel(m, _defaultFormat),
    ];
    if (_models.isEmpty) {
      _models.add(
        _ModelDraft.fromModel(
          ModelConfig(id: '', name: '', apiFormat: _defaultFormat),
          _defaultFormat,
        ),
      );
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    for (final m in _models) {
      m.dispose();
    }
    super.dispose();
  }

  void _submit() {
    final name = _nameCtrl.text.trim();
    final baseUrl = _baseUrlCtrl.text.trim();
    final parsedUrl = Uri.tryParse(baseUrl);
    if (name.isEmpty) {
      setState(() => _validationError = '名称不能为空');
      return;
    }
    if (parsedUrl == null || !parsedUrl.hasScheme || parsedUrl.host.isEmpty) {
      setState(() => _validationError = '请输入有效的 Base URL');
      return;
    }

    final compiledModels = <ModelConfig>[];
    for (final draft in _models) {
      final id = draft.idCtrl.text.trim();
      if (id.isEmpty) {
        setState(() => _validationError = '模型 ID 不能为空');
        return;
      }

      Map<String, String> extraHeaders = const {};
      if (draft.extraHeadersCtrl.text.trim().isNotEmpty) {
        try {
          final decoded = jsonDecode(draft.extraHeadersCtrl.text.trim());
          if (decoded is! Map) {
            setState(() => _validationError = 'extraHeaders 须为 JSON 对象');
            return;
          }
          extraHeaders =
              decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
        } catch (_) {
          setState(() => _validationError = 'extraHeaders JSON 格式无效');
          return;
        }
      }

      Map<String, dynamic> extraBody = const {};
      if (draft.extraBodyCtrl.text.trim().isNotEmpty) {
        try {
          final decoded = jsonDecode(draft.extraBodyCtrl.text.trim());
          if (decoded is! Map<String, dynamic>) {
            setState(() => _validationError = 'extraBody 须为 JSON 对象');
            return;
          }
          extraBody = decoded;
        } catch (_) {
          setState(() => _validationError = 'extraBody JSON 格式无效');
          return;
        }
      }

      compiledModels.add(
        ModelConfig(
          id: id,
          name: draft.nameCtrl.text.trim().isEmpty
              ? id
              : draft.nameCtrl.text.trim(),
          apiFormat: draft.apiFormat,
          reasoning: draft.reasoning,
          compat: CompatConfig(
            maxTokensField: draft.maxTokensFieldCtrl.text.trim(),
            thinkingFormat: draft.thinkingFormatCtrl.text.trim(),
            reasoningEffortField: draft.reasoningEffortFieldCtrl.text.trim(),
            pathOverride: draft.pathOverrideCtrl.text.trim(),
            supportsDeveloperRole: draft.supportsDeveloperRole,
            supportsStreamOptions: draft.supportsStreamOptions,
            extraHeaders: extraHeaders,
            extraBody: extraBody,
          ),
        ),
      );
    }

    Navigator.of(context).pop(
      ProviderUpsertPayload(
        name: name,
        adapter: widget.existing?.adapter ?? 'generic-http',
        baseUrl: baseUrl,
        authType: _authType,
        apiKey: _apiKeyCtrl.text.trim(),
        clearApiKey: _clearApiKey,
        headers: widget.existing?.headers ?? const {},
        models: compiledModels,
        enabled: _enabled,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final formatItems = widget.formats.isEmpty
        ? const [
            FormatInfo(id: 'openai-completions', displayName: 'OpenAI Completions'),
          ]
        : widget.formats;

    return AlertDialog(
      title: Text(widget.existing == null ? '新增供应商' : '编辑供应商'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_validationError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: MdSpacing.sm),
                  child: Text(
                    _validationError!,
                    style: TextStyle(color: scheme.error),
                  ),
                ),
              TextField(
                key: const Key('provider_name_field'),
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: '名称'),
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                key: const Key('provider_baseurl_field'),
                controller: _baseUrlCtrl,
                decoration: const InputDecoration(labelText: 'Base URL'),
              ),
              const SizedBox(height: MdSpacing.sm),
              DropdownButtonFormField<String>(
                initialValue: _authType,
                decoration: const InputDecoration(labelText: 'Auth Type'),
                items: const [
                  DropdownMenuItem(value: 'bearer', child: Text('bearer')),
                  DropdownMenuItem(value: 'x-api-key', child: Text('x-api-key')),
                  DropdownMenuItem(value: 'query-key', child: Text('query-key')),
                  DropdownMenuItem(value: 'header-key', child: Text('header-key')),
                  DropdownMenuItem(value: 'none', child: Text('none')),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _authType = v);
                },
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                key: const Key('provider_apikey_field'),
                controller: _apiKeyCtrl,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: widget.existing?.apiKeySet == true
                      ? 'API Key（留空保持不变）'
                      : 'API Key',
                ),
              ),
              if (widget.existing?.apiKeySet == true)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('清空已保存密钥'),
                  value: _clearApiKey,
                  onChanged: (v) => setState(() => _clearApiKey = v ?? false),
                ),
              const SizedBox(height: MdSpacing.md),
              Row(
                children: [
                  Text('模型', style: Theme.of(context).textTheme.titleSmall),
                  const Spacer(),
                  AppIconAction(
                    svg: AppIcons.plus,
                    tooltip: '添加模型',
                    onPressed: () => setState(() {
                      _models.add(
                        _ModelDraft.fromModel(
                          ModelConfig(
                            id: '',
                            name: '',
                            apiFormat: _defaultFormat,
                          ),
                          _defaultFormat,
                        ),
                      );
                    }),
                  ),
                ],
              ),
              for (var i = 0; i < _models.length; i++)
                _buildModelCard(i, _models[i], formatItems),
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
          key: const Key('provider_save_button'),
          onPressed: _submit,
          child: const Text('保存'),
        ),
      ],
    );
  }

  Widget _buildModelCard(
    int index,
    _ModelDraft draft,
    List<FormatInfo> formatItems,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final selectedFmt = formatItems.any((f) => f.id == draft.apiFormat)
        ? draft.apiFormat
        : formatItems.first.id;

    return Padding(
      padding: const EdgeInsets.only(top: MdSpacing.sm),
      child: Material(
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(MdRadii.sm),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.all(MdSpacing.sm),
          child: Column(
            children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: draft.idCtrl,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: 'Model ID',
                  ),
                ),
              ),
              const SizedBox(width: MdSpacing.sm),
              Expanded(
                child: TextField(
                  controller: draft.nameCtrl,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: '显示名称',
                  ),
                ),
              ),
              if (_models.length > 1)
                AppIconAction(
                  svg: AppIcons.trash,
                  size: 16,
                  tooltip: '移除模型',
                  onPressed: () => setState(() {
                    _models.removeAt(index).dispose();
                  }),
                ),
            ],
          ),
          const SizedBox(height: MdSpacing.sm),
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: selectedFmt,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: 'API Format',
                  ),
                  items: [
                    for (final f in formatItems)
                      DropdownMenuItem(value: f.id, child: Text(f.displayName)),
                  ],
                  onChanged: (v) {
                    if (v != null) setState(() => draft.apiFormat = v);
                  },
                ),
              ),
              const SizedBox(width: MdSpacing.sm),
              FilterChip(
                label: const Text('Reasoning'),
                selected: draft.reasoning,
                onSelected: (v) => setState(() => draft.reasoning = v),
              ),
            ],
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text(
              '兼容配置',
              style: Theme.of(context).textTheme.labelMedium,
            ),
            children: [
              TextField(
                controller: draft.maxTokensFieldCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'maxTokensField',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: draft.thinkingFormatCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'thinkingFormat',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: draft.reasoningEffortFieldCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'reasoningEffortField',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: draft.pathOverrideCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'pathOverride',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<bool?>(
                      initialValue: draft.supportsDeveloperRole,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'supportsDeveloperRole',
                      ),
                      items: const [
                        DropdownMenuItem(value: null, child: Text('默认')),
                        DropdownMenuItem(value: true, child: Text('true')),
                        DropdownMenuItem(value: false, child: Text('false')),
                      ],
                      onChanged: (v) =>
                          setState(() => draft.supportsDeveloperRole = v),
                    ),
                  ),
                  const SizedBox(width: MdSpacing.xs),
                  Expanded(
                    child: DropdownButtonFormField<bool?>(
                      initialValue: draft.supportsStreamOptions,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'supportsStreamOptions',
                      ),
                      items: const [
                        DropdownMenuItem(value: null, child: Text('默认')),
                        DropdownMenuItem(value: true, child: Text('true')),
                        DropdownMenuItem(value: false, child: Text('false')),
                      ],
                      onChanged: (v) =>
                          setState(() => draft.supportsStreamOptions = v),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: draft.extraHeadersCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'extraHeaders (JSON)',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: draft.extraBodyCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'extraBody (JSON)',
                ),
              ),
            ],
          ),
        ],
      ),
        ),
      ),
    );
  }
}
