import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/conversation.dart';
import '../../core/models/plugin_models.dart';
import '../../core/models/provider.dart';
import '../../core/state/providers_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class ProvidersTab extends StatefulWidget {
  const ProvidersTab({super.key});

  @override
  State<ProvidersTab> createState() => _ProvidersTabState();
}

class _ProvidersTabState extends State<ProvidersTab> {
  final TextEditingController _providerSearchCtrl = TextEditingController();
  final TextEditingController _modelSearchCtrl = TextEditingController();
  final TextEditingController _apiKeyCtrl = TextEditingController();
  final TextEditingController _baseUrlCtrl = TextEditingController();

  String? _selectedProviderId;
  bool _compactShowDetail = false;
  bool _obscureApiKey = true;
  bool _dirty = false;
  bool _saving = false;
  bool _testing = false;
  bool _fetchingModels = false;
  String? _testStatusMessage;
  bool _testStatusOk = false;
  final Set<String> _collapsedGroups = {};

  @override
  void dispose() {
    _providerSearchCtrl.dispose();
    _modelSearchCtrl.dispose();
    _apiKeyCtrl.dispose();
    _baseUrlCtrl.dispose();
    super.dispose();
  }

  void _syncSelectedProvider(List<ProviderConfig> providers) {
    if (providers.isEmpty) {
      if (_selectedProviderId != null) {
        _selectedProviderId = null;
        _apiKeyCtrl.clear();
        _baseUrlCtrl.clear();
        _dirty = false;
      }
      return;
    }
    final exists = providers.any((p) => p.id == _selectedProviderId);
    if (!exists) {
      final first = providers.first;
      _selectedProviderId = first.id;
      _loadProviderFields(first);
    }
  }

  void _loadProviderFields(ProviderConfig p) {
    _apiKeyCtrl.clear();
    _baseUrlCtrl.text = p.baseUrl;
    _dirty = false;
    _testStatusMessage = null;
    _modelSearchCtrl.clear();
  }

  void _selectProvider(ProviderConfig p, {required bool isNarrow}) {
    setState(() {
      _selectedProviderId = p.id;
      _loadProviderFields(p);
      if (isNarrow) {
        _compactShowDetail = true;
      }
    });
  }

  Future<void> _persistProvider(
    ProviderConfig p, {
    String? name,
    String? baseUrl,
    String? authType,
    String? apiKey,
    bool clearApiKey = false,
    Map<String, String>? headers,
    List<ModelConfig>? models,
    bool? enabled,
  }) async {
    final providersCtrl = context.read<ProvidersController>();
    setState(() => _saving = true);
    try {
      await providersCtrl.updateProvider(
        p.id,
        ProviderUpsertPayload(
          name: name ?? p.name,
          adapter: p.adapter,
          baseUrl: baseUrl ??
              (_baseUrlCtrl.text.trim().isNotEmpty
                  ? _baseUrlCtrl.text.trim()
                  : p.baseUrl),
          authType: authType ?? p.authType,
          apiKey: apiKey ?? _apiKeyCtrl.text.trim(),
          clearApiKey: clearApiKey,
          headers: headers ?? p.headers,
          models: models ?? p.models,
          enabled: enabled ?? p.enabled,
        ),
      );
      if (mounted) {
        setState(() {
          if (apiKey == null) _apiKeyCtrl.clear();
          _dirty = false;
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _testConnection(ProviderConfig p) async {
    final providersCtrl = context.read<ProvidersController>();
    setState(() {
      _testing = true;
      _testStatusMessage = null;
    });
    try {
      final res = await providersCtrl.testProviderConnection(
        p.id,
        baseUrl: _baseUrlCtrl.text.trim(),
        authType: p.authType,
        apiKey: _apiKeyCtrl.text.trim(),
        headers: p.headers,
      );
      if (mounted) {
        setState(() {
          _testStatusOk = res.ok;
          _testStatusMessage =
              '${res.message} · ${res.latencyMs}ms · ${res.modelCount} 模型';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _testStatusOk = false;
          _testStatusMessage = e.toString();
        });
      }
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _openCreateProviderDialog() async {
    final providersCtrl = context.read<ProvidersController>();
    final payload = await showDialog<ProviderUpsertPayload>(
      context: context,
      builder: (ctx) => _CreateProviderDialog(formats: providersCtrl.formats),
    );
    if (payload == null) return;
    final created = await providersCtrl.createProvider(payload);
    if (!mounted) return;
    setState(() {
      _selectedProviderId = created.id;
      _loadProviderFields(created);
    });
  }

  Future<void> _openAdvancedSettings(ProviderConfig p) async {
    final providersCtrl = context.read<ProvidersController>();
    final result = await showDialog<_AdvancedProviderAction>(
      context: context,
      builder: (ctx) => _ProviderAdvancedDialog(provider: p),
    );
    if (result == null) return;
    if (result.delete) {
      await providersCtrl.deleteProvider(p.id);
      if (!mounted) return;
      setState(() {
        _compactShowDetail = false;
        _selectedProviderId = null;
      });
      return;
    }
    await _persistProvider(
      p,
      name: result.name,
      authType: result.authType,
      headers: result.headers,
      clearApiKey: result.clearApiKey,
    );
  }

  Future<void> _openModelEditor(
    ProviderConfig p, {
    ModelConfig? existing,
    int? index,
  }) async {
    final providersCtrl = context.read<ProvidersController>();
    final edited = await showDialog<ModelConfig>(
      context: context,
      builder: (ctx) => _ModelConfigDialog(
        existing: existing,
        formats: providersCtrl.formats,
      ),
    );
    if (edited == null) return;
    final nextModels = List<ModelConfig>.from(p.models);
    if (index != null && index >= 0 && index < nextModels.length) {
      nextModels[index] = edited;
    } else {
      if (nextModels.any((m) => m.id == edited.id)) return;
      nextModels.add(edited);
    }
    await _persistProvider(p, models: nextModels);
  }

  Future<void> _removeModel(ProviderConfig p, int index) async {
    final nextModels = List<ModelConfig>.from(p.models)..removeAt(index);
    await _persistProvider(p, models: nextModels);
  }

  Future<void> _fetchAndImportModels(ProviderConfig p) async {
    final providersCtrl = context.read<ProvidersController>();
    setState(() => _fetchingModels = true);
    try {
      final discovered = await providersCtrl.fetchProviderModels(
        p.id,
        baseUrl: _baseUrlCtrl.text.trim(),
        authType: p.authType,
        apiKey: _apiKeyCtrl.text.trim(),
        headers: p.headers,
      );
      if (!mounted) return;
      final selected = await showDialog<List<DiscoveredModel>>(
        context: context,
        builder: (ctx) => _ImportModelsDialog(
          providerName: p.name,
          discovered: discovered,
          existingIds: p.models.map((m) => m.id).toSet(),
        ),
      );
      if (selected == null || selected.isEmpty) return;
      final existingIds = p.models.map((m) => m.id).toSet();
      final merged = [
        ...p.models,
        for (final d in selected)
          if (!existingIds.contains(d.id)) d.toModelConfig(),
      ];
      await _persistProvider(p, models: merged);
    } catch (e) {
      if (mounted) {
        setState(() {
          _testStatusOk = false;
          _testStatusMessage = e.toString();
        });
      }
    } finally {
      if (mounted) setState(() => _fetchingModels = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final providersCtrl = context.watch<ProvidersController>();
    final providers = providersCtrl.providers;
    _syncSelectedProvider(providers);

    final selected = providers.where((p) => p.id == _selectedProviderId).firstOrNull;

    return LayoutBuilder(
      builder: (context, constraints) {
        final isNarrow = constraints.maxWidth < 560;
        if (isNarrow) {
          if (_compactShowDetail && selected != null) {
            return Column(
              children: [
                SizedBox(
                  height: 48,
                  child: Row(
                    children: [
                      AppIconAction(
                        svg: AppIcons.arrowLeft,
                        tooltip: '返回平台列表',
                        onPressed: () =>
                            setState(() => _compactShowDetail = false),
                      ),
                      Expanded(
                        child: Text(
                          selected.name,
                          style: Theme.of(context)
                              .textTheme
                              .titleSmall
                              ?.copyWith(fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                Expanded(
                  child: _buildDetailPanel(context, selected, providersCtrl),
                ),
              ],
            );
          }
          return _buildMasterList(context, providers, isNarrow: true);
        }

        return Row(
          children: [
            SizedBox(
              width: 240,
              child: _buildMasterList(context, providers, isNarrow: false),
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: selected == null
                  ? Center(
                      child: Text(
                        '请选择或添加模型平台',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    )
                  : _buildDetailPanel(context, selected, providersCtrl),
            ),
          ],
        );
      },
    );
  }

  Widget _buildMasterList(
    BuildContext context,
    List<ProviderConfig> providers, {
    required bool isNarrow,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final q = _providerSearchCtrl.text.trim().toLowerCase();
    final filtered = q.isEmpty
        ? providers
        : providers
            .where((p) =>
                p.name.toLowerCase().contains(q) ||
                p.id.toLowerCase().contains(q))
            .toList();

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(MdSpacing.md),
          child: TextField(
            key: const Key('provider_search_field'),
            controller: _providerSearchCtrl,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              isDense: true,
              hintText: '搜索模型平台...',
              prefixIcon: Padding(
                padding: const EdgeInsets.all(10),
                child: AppSvgIcon(
                  AppIcons.search,
                  size: 16,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(MdRadii.full),
                borderSide: BorderSide(color: scheme.outlineVariant),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(MdRadii.full),
                borderSide: BorderSide(color: scheme.outlineVariant),
              ),
            ),
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: MdSpacing.sm),
            itemCount: filtered.length,
            itemBuilder: (context, index) {
              final p = filtered[index];
              final isSelected = p.id == _selectedProviderId;
              final initial = p.name.trim().isNotEmpty
                  ? p.name.trim().characters.first.toUpperCase()
                  : '?';
              return Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Material(
                  color: isSelected
                      ? scheme.secondaryContainer
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(MdRadii.md),
                  child: InkWell(
                    key: Key('provider_list_item_${p.id}'),
                    borderRadius: BorderRadius.circular(MdRadii.md),
                    onTap: () => _selectProvider(p, isNarrow: isNarrow),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: MdSpacing.sm,
                        vertical: 9,
                      ),
                      child: Row(
                        children: [
                          CircleAvatar(
                            radius: 13,
                            backgroundColor: isSelected
                                ? scheme.primary
                                : scheme.surfaceContainerHigh,
                            child: Text(
                              initial,
                              style: textTheme.labelSmall?.copyWith(
                                color: isSelected
                                    ? scheme.onPrimary
                                    : scheme.onSurfaceVariant,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          const SizedBox(width: MdSpacing.sm),
                          Expanded(
                            child: Text(
                              p.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: textTheme.bodyMedium?.copyWith(
                                fontWeight: isSelected
                                    ? FontWeight.w600
                                    : FontWeight.w400,
                              ),
                            ),
                          ),
                          if (p.enabled)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: scheme.primaryContainer,
                                borderRadius:
                                    BorderRadius.circular(MdRadii.full),
                              ),
                              child: Text(
                                'ON',
                                style: textTheme.labelSmall?.copyWith(
                                  color: scheme.onPrimaryContainer,
                                  fontWeight: FontWeight.w600,
                                  fontSize: 10,
                                ),
                              ),
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
        Padding(
          padding: const EdgeInsets.all(MdSpacing.md),
          child: SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              key: const Key('settings_add_provider_button'),
              onPressed: _openCreateProviderDialog,
              icon: AppSvgIcon(AppIcons.plus, size: 16),
              label: const Text('添加'),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDetailPanel(
    BuildContext context,
    ProviderConfig p,
    ProvidersController providersCtrl,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final previewUrl = buildProviderEndpointPreview(
      baseUrl: _baseUrlCtrl.text,
      models: p.models,
      formats: providersCtrl.formats,
    );

    final modelQ = _modelSearchCtrl.text.trim().toLowerCase();
    final indexedModels = <(int, ModelConfig)>[];
    for (var i = 0; i < p.models.length; i++) {
      final m = p.models[i];
      if (modelQ.isEmpty ||
          m.id.toLowerCase().contains(modelQ) ||
          m.name.toLowerCase().contains(modelQ)) {
        indexedModels.add((i, m));
      }
    }

    final groups = <String, List<(int, ModelConfig)>>{};
    for (final entry in indexedModels) {
      final g = _deriveModelGroup(entry.$2.id);
      groups.putIfAbsent(g, () => []).add(entry);
    }

    return ListView(
      padding: const EdgeInsets.all(MdSpacing.xl),
      children: [
        Row(
          children: [
            Text(
              p.name,
              style: textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: MdSpacing.xs),
            AppIconAction(
              key: const Key('provider_advanced_settings_button'),
              svg: AppIcons.settings,
              size: 16,
              tooltip: '高级设置',
              onPressed: () => _openAdvancedSettings(p),
            ),
            const Spacer(),
            if (_dirty)
              Padding(
                padding: const EdgeInsets.only(right: MdSpacing.sm),
                child: FilledButton.tonal(
                  key: const Key('provider_save_config_button'),
                  onPressed: _saving ? null : () => _persistProvider(p),
                  child: const Text('保存'),
                ),
              ),
            Switch(
              key: Key('provider_enable_switch_${p.id}'),
              value: p.enabled,
              onChanged: _saving
                  ? null
                  : (v) => _persistProvider(p, enabled: v),
            ),
          ],
        ),
        const SizedBox(height: MdSpacing.md),
        Text(
          'API 密钥',
          style: textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: MdSpacing.xs),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('provider_apikey_field'),
                controller: _apiKeyCtrl,
                obscureText: _obscureApiKey,
                onChanged: (_) => setState(() => _dirty = true),
                onEditingComplete: () => _persistProvider(p),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: p.authType == 'none'
                      ? '当前鉴权模式无需密钥'
                      : (p.apiKeySet
                          ? '已保存 (${p.apiKeyMasked})，留空保持不变'
                          : '输入 API 密钥'),
                  suffixIcon: AppIconAction(
                    key: const Key('provider_toggle_apikey_visibility'),
                    svg: _obscureApiKey ? AppIcons.eye : AppIcons.eyeOff,
                    size: 16,
                    tooltip: _obscureApiKey ? '显示' : '隐藏',
                    onPressed: () =>
                        setState(() => _obscureApiKey = !_obscureApiKey),
                  ),
                ),
              ),
            ),
            const SizedBox(width: MdSpacing.sm),
            OutlinedButton(
              key: const Key('provider_test_connection_button'),
              onPressed: _testing ? null : () => _testConnection(p),
              child: Text(_testing ? '检测中...' : '检测'),
            ),
          ],
        ),
        if (_testStatusMessage != null) ...[
          const SizedBox(height: MdSpacing.xs),
          Text(
            _testStatusMessage!,
            style: textTheme.bodySmall?.copyWith(
              color: _testStatusOk ? scheme.primary : scheme.error,
            ),
          ),
        ],
        const SizedBox(height: MdSpacing.lg),
        Text(
          'API 地址',
          style: textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: MdSpacing.xs),
        TextField(
          key: const Key('provider_baseurl_field'),
          controller: _baseUrlCtrl,
          onChanged: (_) => setState(() => _dirty = true),
          onEditingComplete: () => _persistProvider(p),
          decoration: const InputDecoration(
            isDense: true,
            hintText: 'https://api.example.com/v1',
          ),
        ),
        const SizedBox(height: MdSpacing.xs),
        Text(
          '预览: ${previewUrl.isEmpty ? '-' : previewUrl}',
          key: const Key('provider_url_preview'),
          style: textTheme.bodySmall?.copyWith(
            color: scheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: MdSpacing.xl),
        Wrap(
          spacing: MdSpacing.sm,
          runSpacing: MdSpacing.sm,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              '模型',
              style: textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(MdRadii.full),
              ),
              child: Text(
                '${p.models.length}',
                style: textTheme.labelSmall,
              ),
            ),
            SizedBox(
              width: 180,
              child: TextField(
                key: const Key('provider_model_search_field'),
                controller: _modelSearchCtrl,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  isDense: true,
                  hintText: '过滤模型...',
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: MdSpacing.sm,
                    vertical: 6,
                  ),
                ),
              ),
            ),
            OutlinedButton.icon(
              key: const Key('provider_fetch_models_button'),
              onPressed:
                  _fetchingModels ? null : () => _fetchAndImportModels(p),
              icon: AppSvgIcon(AppIcons.refresh, size: 15),
              label: Text(_fetchingModels ? '获取中...' : '获取模型列表'),
            ),
            AppIconAction(
              key: const Key('provider_add_model_button'),
              svg: AppIcons.plus,
              tooltip: '手动添加模型',
              onPressed: () => _openModelEditor(p),
            ),
          ],
        ),
        const SizedBox(height: MdSpacing.md),
        if (groups.isEmpty)
          Container(
            padding: const EdgeInsets.all(MdSpacing.lg),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(MdRadii.md),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Text(
              p.models.isEmpty ? '暂无模型，可点击「获取模型列表」或「+」添加' : '无匹配模型',
              style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          )
        else
          for (final entry in groups.entries) ...[
            _buildModelGroupCard(context, p, entry.key, entry.value),
            const SizedBox(height: MdSpacing.sm),
          ],
      ],
    );
  }

  Widget _buildModelGroupCard(
    BuildContext context,
    ProviderConfig p,
    String group,
    List<(int, ModelConfig)> items,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final isCollapsed = _collapsedGroups.contains(group);

    return Container(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(MdRadii.md),
            onTap: () => setState(() {
              if (isCollapsed) {
                _collapsedGroups.remove(group);
              } else {
                _collapsedGroups.add(group);
              }
            }),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: MdSpacing.md,
                vertical: MdSpacing.sm,
              ),
              child: Row(
                children: [
                  AppSvgIcon(
                    isCollapsed ? AppIcons.chevronRight : AppIcons.chevronDown,
                    size: 16,
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: MdSpacing.xs),
                  Text(
                    group,
                    style: textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: MdSpacing.xs),
                  Text(
                    '(${items.length})',
                    style: textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (!isCollapsed) ...[
            const Divider(height: 1),
            for (var i = 0; i < items.length; i++) ...[
              if (i > 0) const Divider(height: 1),
              _buildModelRow(context, p, items[i].$1, items[i].$2),
            ],
          ],
        ],
      ),
    );
  }

  Widget _buildModelRow(
    BuildContext context,
    ProviderConfig p,
    int modelIndex,
    ModelConfig m,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final initial = m.name.trim().isNotEmpty
        ? m.name.trim().characters.first.toUpperCase()
        : 'M';

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: MdSpacing.md,
        vertical: MdSpacing.xs,
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 12,
            backgroundColor: scheme.surfaceContainerHigh,
            child: Text(
              initial,
              style: textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
          ),
          const SizedBox(width: MdSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  m.name.isNotEmpty ? m.name : m.id,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: textTheme.bodyMedium,
                ),
                if (m.name != m.id)
                  Text(
                    m.id,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          if (m.inputModalities.contains('image'))
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: AppSvgIcon(
                AppIcons.image,
                size: 15,
                color: scheme.primary,
                semanticsLabel: '视觉支持',
              ),
            ),
          if (m.reasoning)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: AppSvgIcon(
                AppIcons.lightbulb,
                size: 15,
                color: scheme.tertiary,
                semanticsLabel: '推理模型',
              ),
            ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(MdRadii.full),
            ),
            child: Text(
              m.apiFormat,
              style: textTheme.labelSmall?.copyWith(fontSize: 10),
            ),
          ),
          AppIconAction(
            key: Key('model_settings_${m.id}'),
            svg: AppIcons.settings,
            size: 16,
            tooltip: '模型配置',
            onPressed: () =>
                _openModelEditor(p, existing: m, index: modelIndex),
          ),
          AppIconAction(
            key: Key('remove_model_${m.id}'),
            svg: AppIcons.close,
            size: 15,
            tooltip: '移除模型',
            onPressed: () => _removeModel(p, modelIndex),
          ),
        ],
      ),
    );
  }
}

/// Computes the deterministic preview endpoint URL for a provider and its first model.
String buildProviderEndpointPreview({
  required String baseUrl,
  required List<ModelConfig> models,
  required List<FormatInfo> formats,
}) {
  var baseTrim = baseUrl.trim();
  if (baseTrim.isEmpty) return '';
  while (baseTrim.endsWith('/')) {
    baseTrim = baseTrim.substring(0, baseTrim.length - 1);
  }

  var targetPath = '/v1/chat/completions';
  if (models.isNotEmpty) {
    final first = models.first;
    if (first.compat.pathOverride.trim().isNotEmpty) {
      targetPath = first.compat.pathOverride.trim();
    } else {
      targetPath = _defaultPathForFormat(first.apiFormat, formats);
    }
    if (first.id.isNotEmpty) {
      targetPath = targetPath.replaceAll('{model}', first.id);
    }
  }

  if (!targetPath.startsWith('/')) {
    targetPath = '/$targetPath';
  }
  for (final prefix in const ['/v1', '/v1beta']) {
    if (baseTrim.endsWith(prefix) && targetPath.startsWith('$prefix/')) {
      targetPath = targetPath.substring(prefix.length);
      break;
    }
  }
  return '$baseTrim$targetPath';
}

String _defaultPathForFormat(String formatId, List<FormatInfo> formats) {
  for (final f in formats) {
    if (f.id == formatId && f.defaultPath.isNotEmpty) {
      return f.defaultPath;
    }
  }
  return switch (formatId) {
    'openai-responses' => '/v1/responses',
    'anthropic-messages' => '/v1/messages',
    'google-generative-ai' => '/v1beta/models/{model}:streamGenerateContent',
    _ => '/v1/chat/completions',
  };
}

String _deriveModelGroup(String id) {
  final slashIdx = id.indexOf('/');
  if (slashIdx > 0) {
    return id.substring(0, slashIdx).trim();
  }
  final dashIdx = id.indexOf('-');
  if (dashIdx > 0) {
    return id.substring(0, dashIdx).trim();
  }
  return 'other';
}

class _CreateProviderDialog extends StatefulWidget {
  const _CreateProviderDialog({required this.formats});

  final List<FormatInfo> formats;

  @override
  State<_CreateProviderDialog> createState() => _CreateProviderDialogState();
}

class _CreateProviderDialogState extends State<_CreateProviderDialog> {
  final _nameCtrl = TextEditingController();
  final _baseUrlCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  String _authType = 'bearer';
  String? _error;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _baseUrlCtrl.dispose();
    _apiKeyCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _nameCtrl.text.trim();
    final baseUrl = _baseUrlCtrl.text.trim();
    final parsed = Uri.tryParse(baseUrl);
    if (name.isEmpty) {
      setState(() => _error = '名称不能为空');
      return;
    }
    if (parsed == null || !parsed.hasScheme || parsed.host.isEmpty) {
      setState(() => _error = '请输入有效的 Base URL');
      return;
    }
    Navigator.of(context).pop(
      ProviderUpsertPayload(
        name: name,
        adapter: 'generic-http',
        baseUrl: baseUrl,
        authType: _authType,
        apiKey: _apiKeyCtrl.text.trim(),
        models: const [],
        enabled: true,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: const Text('添加模型平台'),
      content: SizedBox(
        width: 440,
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
                key: const Key('provider_name_field'),
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: '名称'),
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                key: const Key('provider_add_baseurl_field'),
                controller: _baseUrlCtrl,
                decoration: const InputDecoration(
                  labelText: 'Base URL',
                  hintText: 'https://api.openai.com/v1',
                ),
              ),
              const SizedBox(height: MdSpacing.sm),
              DropdownButtonFormField<String>(
                initialValue: _authType,
                decoration: const InputDecoration(labelText: '鉴权方式'),
                items: const [
                  DropdownMenuItem(value: 'bearer', child: Text('bearer')),
                  DropdownMenuItem(value: 'x-api-key', child: Text('x-api-key')),
                  DropdownMenuItem(value: 'query-key', child: Text('query-key')),
                  DropdownMenuItem(
                    value: 'header-key',
                    child: Text('header-key'),
                  ),
                  DropdownMenuItem(value: 'none', child: Text('none')),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _authType = v);
                },
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                key: const Key('provider_add_apikey_field'),
                controller: _apiKeyCtrl,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'API Key'),
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
          key: const Key('provider_save_button'),
          onPressed: _submit,
          child: const Text('保存'),
        ),
      ],
    );
  }
}

class _AdvancedProviderAction {
  const _AdvancedProviderAction({
    this.delete = false,
    this.name,
    this.authType,
    this.headers,
    this.clearApiKey = false,
  });

  final bool delete;
  final String? name;
  final String? authType;
  final Map<String, String>? headers;
  final bool clearApiKey;
}

class _ProviderAdvancedDialog extends StatefulWidget {
  const _ProviderAdvancedDialog({required this.provider});

  final ProviderConfig provider;

  @override
  State<_ProviderAdvancedDialog> createState() =>
      _ProviderAdvancedDialogState();
}

class _ProviderAdvancedDialogState extends State<_ProviderAdvancedDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _headersCtrl;
  late String _authType;
  bool _clearApiKey = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(text: widget.provider.name);
    _authType = widget.provider.authType;
    _headersCtrl = TextEditingController(
      text: widget.provider.headers.isEmpty
          ? ''
          : jsonEncode(widget.provider.headers),
    );
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _headersCtrl.dispose();
    super.dispose();
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除供应商'),
        content: Text('确认删除「${widget.provider.name}」？'),
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
    if (confirmed == true && mounted) {
      Navigator.of(context).pop(const _AdvancedProviderAction(delete: true));
    }
  }

  void _save() {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '名称不能为空');
      return;
    }
    Map<String, String> headers = const {};
    final raw = _headersCtrl.text.trim();
    if (raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is! Map) {
          setState(() => _error = '自定义请求头须为 JSON 对象');
          return;
        }
        headers = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      } catch (_) {
        setState(() => _error = '请求头 JSON 格式无效');
        return;
      }
    }
    Navigator.of(context).pop(
      _AdvancedProviderAction(
        name: name,
        authType: _authType,
        headers: headers,
        clearApiKey: _clearApiKey,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: const Text('供应商高级设置'),
      content: SizedBox(
        width: 440,
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
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: '平台名称'),
              ),
              const SizedBox(height: MdSpacing.sm),
              DropdownButtonFormField<String>(
                initialValue: _authType,
                decoration: const InputDecoration(labelText: '鉴权方式 (Auth Type)'),
                items: const [
                  DropdownMenuItem(value: 'bearer', child: Text('bearer')),
                  DropdownMenuItem(value: 'x-api-key', child: Text('x-api-key')),
                  DropdownMenuItem(value: 'query-key', child: Text('query-key')),
                  DropdownMenuItem(
                    value: 'header-key',
                    child: Text('header-key'),
                  ),
                  DropdownMenuItem(value: 'none', child: Text('none')),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _authType = v);
                },
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                controller: _headersCtrl,
                decoration: const InputDecoration(
                  labelText: '自定义请求头 (JSON)',
                ),
              ),
              if (widget.provider.apiKeySet) ...[
                const SizedBox(height: MdSpacing.xs),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('清空已保存密钥'),
                  value: _clearApiKey,
                  onChanged: (v) => setState(() => _clearApiKey = v ?? false),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: Key('delete_provider_${widget.provider.id}'),
          style: TextButton.styleFrom(foregroundColor: scheme.error),
          onPressed: _confirmDelete,
          child: const Text('删除供应商'),
        ),
        const Spacer(),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _save,
          child: const Text('保存'),
        ),
      ],
    );
  }
}

class _ModelConfigDialog extends StatefulWidget {
  const _ModelConfigDialog({
    this.existing,
    required this.formats,
  });

  final ModelConfig? existing;
  final List<FormatInfo> formats;

  @override
  State<_ModelConfigDialog> createState() => _ModelConfigDialogState();
}

class _ModelConfigDialogState extends State<_ModelConfigDialog> {
  late final TextEditingController _idCtrl;
  late final TextEditingController _nameCtrl;
  late final TextEditingController _maxTokensCtrl;
  late final TextEditingController _maxTokensFieldCtrl;
  late final TextEditingController _thinkingFormatCtrl;
  late final TextEditingController _reasoningEffortFieldCtrl;
  late final TextEditingController _pathOverrideCtrl;
  late final TextEditingController _extraHeadersCtrl;
  late final TextEditingController _extraBodyCtrl;
  late String _apiFormat;
  late bool _reasoning;
  late bool _vision;
  bool? _supportsDeveloperRole;
  bool? _supportsStreamOptions;
  String? _error;

  @override
  void initState() {
    super.initState();
    final m = widget.existing;
    final defaultFmt = widget.formats.isNotEmpty
        ? widget.formats.first.id
        : 'openai-completions';
    _idCtrl = TextEditingController(text: m?.id ?? '');
    _nameCtrl = TextEditingController(text: m?.name ?? '');
    _maxTokensCtrl = TextEditingController(
      text: (m?.maxTokens ?? 0) > 0 ? m!.maxTokens.toString() : '',
    );
    _apiFormat =
        (m != null && m.apiFormat.isNotEmpty) ? m.apiFormat : defaultFmt;
    _reasoning = m?.reasoning ?? false;
    _vision = m?.inputModalities.contains('image') ?? false;
    _maxTokensFieldCtrl =
        TextEditingController(text: m?.compat.maxTokensField ?? '');
    _thinkingFormatCtrl =
        TextEditingController(text: m?.compat.thinkingFormat ?? '');
    _reasoningEffortFieldCtrl =
        TextEditingController(text: m?.compat.reasoningEffortField ?? '');
    _pathOverrideCtrl =
        TextEditingController(text: m?.compat.pathOverride ?? '');
    _extraHeadersCtrl = TextEditingController(
      text: (m?.compat.extraHeaders.isNotEmpty == true)
          ? jsonEncode(m!.compat.extraHeaders)
          : '',
    );
    _extraBodyCtrl = TextEditingController(
      text: (m?.compat.extraBody.isNotEmpty == true)
          ? jsonEncode(m!.compat.extraBody)
          : '',
    );
    _supportsDeveloperRole = m?.compat.supportsDeveloperRole;
    _supportsStreamOptions = m?.compat.supportsStreamOptions;
  }

  @override
  void dispose() {
    _idCtrl.dispose();
    _nameCtrl.dispose();
    _maxTokensCtrl.dispose();
    _maxTokensFieldCtrl.dispose();
    _thinkingFormatCtrl.dispose();
    _reasoningEffortFieldCtrl.dispose();
    _pathOverrideCtrl.dispose();
    _extraHeadersCtrl.dispose();
    _extraBodyCtrl.dispose();
    super.dispose();
  }

  void _save() {
    final id = _idCtrl.text.trim();
    if (id.isEmpty) {
      setState(() => _error = '模型 ID 不能为空');
      return;
    }

    Map<String, String> extraHeaders = const {};
    if (_extraHeadersCtrl.text.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(_extraHeadersCtrl.text.trim());
        if (decoded is! Map) {
          setState(() => _error = 'extraHeaders 须为 JSON 对象');
          return;
        }
        extraHeaders =
            decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      } catch (_) {
        setState(() => _error = 'extraHeaders JSON 格式无效');
        return;
      }
    }

    Map<String, dynamic> extraBody = const {};
    if (_extraBodyCtrl.text.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(_extraBodyCtrl.text.trim());
        if (decoded is! Map<String, dynamic>) {
          setState(() => _error = 'extraBody 须为 JSON 对象');
          return;
        }
        extraBody = decoded;
      } catch (_) {
        setState(() => _error = 'extraBody JSON 格式无效');
        return;
      }
    }

    final maxTok = int.tryParse(_maxTokensCtrl.text.trim()) ?? 0;
    final modalities = _vision ? const ['text', 'image'] : const ['text'];

    Navigator.of(context).pop(
      ModelConfig(
        id: id,
        name: _nameCtrl.text.trim().isEmpty ? id : _nameCtrl.text.trim(),
        apiFormat: _apiFormat,
        contextWindow: widget.existing?.contextWindow ?? 0,
        maxTokens: maxTok,
        reasoning: _reasoning,
        inputModalities: modalities,
        compat: CompatConfig(
          maxTokensField: _maxTokensFieldCtrl.text.trim(),
          thinkingFormat: _thinkingFormatCtrl.text.trim(),
          reasoningEffortField: _reasoningEffortFieldCtrl.text.trim(),
          pathOverride: _pathOverrideCtrl.text.trim(),
          supportsDeveloperRole: _supportsDeveloperRole,
          supportsStreamOptions: _supportsStreamOptions,
          extraHeaders: extraHeaders,
          extraBody: extraBody,
        ),
        defaultParams: widget.existing?.defaultParams ??
            const GenerationParams(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final formatItems = widget.formats.isEmpty
        ? const [
            FormatInfo(
              id: 'openai-completions',
              displayName: 'OpenAI Chat Completions',
            ),
            FormatInfo(
              id: 'openai-responses',
              displayName: 'OpenAI Responses',
            ),
            FormatInfo(
              id: 'anthropic-messages',
              displayName: 'Anthropic Messages',
            ),
            FormatInfo(
              id: 'google-generative-ai',
              displayName: 'Google Generative AI',
            ),
          ]
        : widget.formats;

    final selectedFmt = formatItems.any((f) => f.id == _apiFormat)
        ? _apiFormat
        : formatItems.first.id;

    return AlertDialog(
      title: Text(widget.existing == null ? '添加模型' : '模型配置'),
      content: SizedBox(
        width: 520,
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
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('model_id_field'),
                      controller: _idCtrl,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'Model ID',
                      ),
                    ),
                  ),
                  const SizedBox(width: MdSpacing.sm),
                  Expanded(
                    child: TextField(
                      key: const Key('model_name_field'),
                      controller: _nameCtrl,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: '显示名称',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: MdSpacing.sm),
              Row(
                children: [
                  Expanded(
                    flex: 2,
                    child: DropdownButtonFormField<String>(
                      key: const Key('model_format_field'),
                      initialValue: selectedFmt,
                      isExpanded: true,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'API Format',
                      ),
                      items: [
                        for (final f in formatItems)
                          DropdownMenuItem(
                            value: f.id,
                            child: Text(f.displayName),
                          ),
                      ],
                      onChanged: (v) {
                        if (v != null) setState(() => _apiFormat = v);
                      },
                    ),
                  ),
                  const SizedBox(width: MdSpacing.sm),
                  Expanded(
                    child: TextField(
                      controller: _maxTokensCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        isDense: true,
                        labelText: 'Max Tokens',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: MdSpacing.sm),
              Wrap(
                spacing: MdSpacing.sm,
                children: [
                  FilterChip(
                    label: const Text('Reasoning'),
                    selected: _reasoning,
                    onSelected: (v) => setState(() => _reasoning = v),
                  ),
                  FilterChip(
                    label: const Text('视觉输入'),
                    selected: _vision,
                    onSelected: (v) => setState(() => _vision = v),
                  ),
                ],
              ),
              const SizedBox(height: MdSpacing.sm),
              const Divider(),
              const SizedBox(height: MdSpacing.xs),
              Text(
                '协议兼容覆盖',
                style: Theme.of(context).textTheme.labelMedium,
              ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                controller: _maxTokensFieldCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'maxTokensField',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: _thinkingFormatCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'thinkingFormat',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: _reasoningEffortFieldCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'reasoningEffortField',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: _pathOverrideCtrl,
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
                      initialValue: _supportsDeveloperRole,
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
                          setState(() => _supportsDeveloperRole = v),
                    ),
                  ),
                  const SizedBox(width: MdSpacing.xs),
                  Expanded(
                    child: DropdownButtonFormField<bool?>(
                      initialValue: _supportsStreamOptions,
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
                          setState(() => _supportsStreamOptions = v),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: _extraHeadersCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'extraHeaders (JSON)',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              TextField(
                controller: _extraBodyCtrl,
                decoration: const InputDecoration(
                  isDense: true,
                  labelText: 'extraBody (JSON)',
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
          key: const Key('model_config_save_button'),
          onPressed: _save,
          child: const Text('保存'),
        ),
      ],
    );
  }
}

class _ImportModelsDialog extends StatefulWidget {
  const _ImportModelsDialog({
    required this.providerName,
    required this.discovered,
    required this.existingIds,
  });

  final String providerName;
  final List<DiscoveredModel> discovered;
  final Set<String> existingIds;

  @override
  State<_ImportModelsDialog> createState() => _ImportModelsDialogState();
}

class _ImportModelsDialogState extends State<_ImportModelsDialog> {
  final TextEditingController _searchCtrl = TextEditingController();
  final Set<String> _selectedIds = {};

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final q = _searchCtrl.text.trim().toLowerCase();
    final filtered = q.isEmpty
        ? widget.discovered
        : widget.discovered
            .where((m) =>
                m.id.toLowerCase().contains(q) ||
                m.name.toLowerCase().contains(q) ||
                m.group.toLowerCase().contains(q))
            .toList();

    final groups = <String, List<DiscoveredModel>>{};
    for (final m in filtered) {
      groups.putIfAbsent(m.group, () => []).add(m);
    }

    return AlertDialog(
      title: Text('导入模型 · ${widget.providerName}'),
      content: SizedBox(
        width: 520,
        height: 440,
        child: Column(
          children: [
            TextField(
              key: const Key('import_models_search_field'),
              controller: _searchCtrl,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜索远端模型...',
                prefixIcon: Padding(
                  padding: const EdgeInsets.all(10),
                  child: AppSvgIcon(AppIcons.search, size: 16),
                ),
              ),
            ),
            const SizedBox(height: MdSpacing.sm),
            Expanded(
              child: groups.isEmpty
                  ? Center(
                      child: Text(
                        '未发现可用模型',
                        style: textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  : ListView(
                      children: [
                        for (final entry in groups.entries) ...[
                          Padding(
                            padding: const EdgeInsets.symmetric(
                              vertical: MdSpacing.xs,
                            ),
                            child: Text(
                              '${entry.key} (${entry.value.length})',
                              style: textTheme.labelLarge?.copyWith(
                                color: scheme.primary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          for (final m in entry.value)
                            CheckboxListTile(
                              key: Key('import_model_checkbox_${m.id}'),
                              dense: true,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: widget.existingIds.contains(m.id) ||
                                  _selectedIds.contains(m.id),
                              onChanged: widget.existingIds.contains(m.id)
                                  ? null
                                  : (checked) => setState(() {
                                        if (checked == true) {
                                          _selectedIds.add(m.id);
                                        } else {
                                          _selectedIds.remove(m.id);
                                        }
                                      }),
                              title: Text(m.name),
                              subtitle: Text(
                                widget.existingIds.contains(m.id)
                                    ? '${m.id} · 已添加'
                                    : '${m.id} · ${m.apiFormat}',
                              ),
                            ),
                        ],
                      ],
                    ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const Key('import_models_confirm_button'),
          onPressed: _selectedIds.isEmpty
              ? null
              : () => Navigator.of(context).pop(
                    widget.discovered
                        .where((m) => _selectedIds.contains(m.id))
                        .toList(),
                  ),
          child: Text('确认导入 (${_selectedIds.length})'),
        ),
      ],
    );
  }
}
