import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/plugin_models.dart';
import '../../core/models/provider.dart';
import '../../core/state/plugins_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class PluginsCenterTab extends StatefulWidget {
  const PluginsCenterTab({super.key});

  @override
  State<PluginsCenterTab> createState() => _PluginsCenterTabState();
}

class _PluginsCenterTabState extends State<PluginsCenterTab> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final pluginsCtrl = context.read<PluginsController>();
      if (pluginsCtrl.searchEngines.isEmpty && !pluginsCtrl.isLoading) {
        pluginsCtrl.refresh();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final pluginsCtrl = context.watch<PluginsController>();
    final providersCtrl = context.watch<ProvidersController>();
    final settingsCtrl = context.watch<SettingsController>();

    final formats = providersCtrl.formats;
    final adapters = providersCtrl.adapters.isNotEmpty
        ? providersCtrl.adapters
        : const [
            ProviderAdapterInfo(
              id: 'generic-http',
              displayName: 'Generic HTTP',
            ),
          ];

    return ListView(
      padding: const EdgeInsets.all(MdSpacing.xl),
      children: [
        _SectionHeader(
          icon: AppIcons.globe,
          title: '搜索引擎插件',
          trailing: pluginsCtrl.isLoading
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : AppIconAction(
                  svg: AppIcons.refresh,
                  size: 16,
                  tooltip: '刷新插件列表',
                  onPressed: pluginsCtrl.refresh,
                ),
        ),
        const SizedBox(height: MdSpacing.md),
        if (pluginsCtrl.searchEngines.isEmpty)
          Container(
            padding: const EdgeInsets.all(MdSpacing.lg),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: BorderRadius.circular(MdRadii.md),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: Text(
              '暂无已注册搜索引擎插件',
              style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
            ),
          )
        else
          Wrap(
            spacing: MdSpacing.md,
            runSpacing: MdSpacing.md,
            children: [
              for (final engine in pluginsCtrl.searchEngines)
                SizedBox(
                  width: 380,
                  child: _SearchEngineCard(
                    key: ValueKey('search_card_${engine.engineId}'),
                    engine: engine,
                  ),
                ),
            ],
          ),
        const SizedBox(height: MdSpacing.xl),
        const Divider(),
        const SizedBox(height: MdSpacing.lg),
        _SectionHeader(
          icon: AppIcons.preview,
          title: '内容渲染插件',
        ),
        const SizedBox(height: MdSpacing.md),
        _RenderingPluginsCard(settingsCtrl: settingsCtrl),
        const SizedBox(height: MdSpacing.xl),
        const Divider(),
        const SizedBox(height: MdSpacing.lg),
        _SectionHeader(
          icon: AppIcons.code,
          title: '协议格式与适配器',
        ),
        const SizedBox(height: MdSpacing.md),
        Wrap(
          spacing: MdSpacing.md,
          runSpacing: MdSpacing.md,
          children: [
            for (final fmt in formats)
              _FormatMetaCard(format: fmt),
            for (final adapter in adapters)
              _AdapterMetaCard(adapter: adapter),
          ],
        ),
        const SizedBox(height: MdSpacing.xl),
        const Divider(),
        const SizedBox(height: MdSpacing.lg),
        _SectionHeader(
          icon: AppIcons.plugin,
          title: '预留生态扩展槽',
        ),
        const SizedBox(height: MdSpacing.md),
        Wrap(
          spacing: MdSpacing.md,
          runSpacing: MdSpacing.md,
          children: const [
            _ReservedSlotCard(
              title: '图像生成插件',
              contract: 'ImageGenRegistry',
              status: '接口已预留',
            ),
            _ReservedSlotCard(
              title: '选择性会话同步',
              contract: 'ConversationSyncBoundary',
              status: '接口已预留',
            ),
            _ReservedSlotCard(
              title: 'MCP 工具运行时',
              contract: 'MCPClientBoundary',
              status: '已就绪配置层',
            ),
          ],
        ),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.title,
    this.trailing,
  });

  final String icon;
  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        AppSvgIcon(icon, size: 18, color: scheme.primary),
        const SizedBox(width: MdSpacing.sm),
        Text(
          title,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
        ),
        const Spacer(),
        ?trailing,
      ],
    );
  }
}

class _SearchEngineCard extends StatefulWidget {
  const _SearchEngineCard({super.key, required this.engine});

  final SearchEnginePluginConfig engine;

  @override
  State<_SearchEngineCard> createState() => _SearchEngineCardState();
}

class _SearchEngineCardState extends State<_SearchEngineCard> {
  late final TextEditingController _endpointCtrl;
  late final TextEditingController _apiKeyCtrl;
  late final TextEditingController _maxResultsCtrl;
  bool _saving = false;
  bool _testing = false;
  String? _statusMsg;
  bool _statusIsError = false;

  @override
  void initState() {
    super.initState();
    _endpointCtrl = TextEditingController(text: widget.engine.endpoint);
    _apiKeyCtrl = TextEditingController();
    _maxResultsCtrl =
        TextEditingController(text: widget.engine.maxResults.toString());
  }

  @override
  void didUpdateWidget(covariant _SearchEngineCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.engine.endpoint != widget.engine.endpoint &&
        _endpointCtrl.text != widget.engine.endpoint) {
      _endpointCtrl.text = widget.engine.endpoint;
    }
    if (oldWidget.engine.maxResults != widget.engine.maxResults) {
      _maxResultsCtrl.text = widget.engine.maxResults.toString();
    }
  }

  @override
  void dispose() {
    _endpointCtrl.dispose();
    _apiKeyCtrl.dispose();
    _maxResultsCtrl.dispose();
    super.dispose();
  }

  Future<void> _save({bool? enabledOverride, bool? defaultOverride}) async {
    final pluginsCtrl = context.read<PluginsController>();
    final maxRes = int.tryParse(_maxResultsCtrl.text.trim());
    setState(() {
      _saving = true;
      _statusMsg = null;
    });
    try {
      await pluginsCtrl.updateSearchEngine(
        widget.engine.engineId,
        enabled: enabledOverride ?? widget.engine.enabled,
        endpoint: _endpointCtrl.text.trim(),
        apiKey: _apiKeyCtrl.text.trim(),
        maxResults: maxRes,
        isDefault: defaultOverride,
      );
      _apiKeyCtrl.clear();
      if (mounted) {
        setState(() {
          _statusMsg = '已保存';
          _statusIsError = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _statusMsg = e.toString();
          _statusIsError = true;
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _test() async {
    final pluginsCtrl = context.read<PluginsController>();
    final maxRes = int.tryParse(_maxResultsCtrl.text.trim());
    setState(() {
      _testing = true;
      _statusMsg = null;
    });
    try {
      final res = await pluginsCtrl.testSearchEngine(
        widget.engine.engineId,
        endpoint: _endpointCtrl.text.trim(),
        apiKey: _apiKeyCtrl.text.trim(),
        maxResults: maxRes,
      );
      if (mounted) {
        setState(() {
          _statusMsg = '${res.message} · ${res.resultCount} 条 · ${res.latencyMs}ms';
          _statusIsError = !res.ok;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _statusMsg = e.toString();
          _statusIsError = true;
        });
      }
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final e = widget.engine;

    return Container(
      padding: const EdgeInsets.all(MdSpacing.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(
          color: e.isDefault ? scheme.primary : scheme.outlineVariant,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          e.displayName.isNotEmpty ? e.displayName : e.engineId,
                          style: textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (e.isDefault) ...[
                          const SizedBox(width: MdSpacing.xs),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: scheme.primaryContainer,
                              borderRadius: BorderRadius.circular(MdRadii.full),
                            ),
                            child: Text(
                              '默认',
                              style: textTheme.labelSmall?.copyWith(
                                color: scheme.onPrimaryContainer,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                    Text(
                      e.engineId,
                      style: textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              if (!e.isDefault)
                TextButton(
                  onPressed: _saving ? null : () => _save(defaultOverride: true),
                  child: const Text('设为默认'),
                ),
              Switch(
                key: Key('search_enable_${e.engineId}'),
                value: e.enabled,
                onChanged: _saving ? null : (v) => _save(enabledOverride: v),
              ),
            ],
          ),
          const SizedBox(height: MdSpacing.sm),
          TextField(
            key: Key('search_endpoint_${e.engineId}'),
            controller: _endpointCtrl,
            decoration: const InputDecoration(
              isDense: true,
              labelText: '端点地址',
            ),
          ),
          const SizedBox(height: MdSpacing.sm),
          Row(
            children: [
              Expanded(
                flex: 3,
                child: TextField(
                  key: Key('search_apikey_${e.engineId}'),
                  controller: _apiKeyCtrl,
                  obscureText: true,
                  decoration: InputDecoration(
                    isDense: true,
                    labelText: e.apiKeySet
                        ? 'API 密钥 (${e.apiKeyMasked})'
                        : (e.requiresApiKey ? 'API 密钥（必填）' : 'API 密钥（可选）'),
                  ),
                ),
              ),
              const SizedBox(width: MdSpacing.sm),
              Expanded(
                child: TextField(
                  controller: _maxResultsCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: '条数',
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: MdSpacing.sm),
          Row(
            children: [
              OutlinedButton(
                key: Key('search_test_${e.engineId}'),
                onPressed: _testing ? null : _test,
                child: Text(_testing ? '测试中...' : '测试'),
              ),
              const SizedBox(width: MdSpacing.sm),
              FilledButton.tonal(
                key: Key('search_save_${e.engineId}'),
                onPressed: _saving ? null : () => _save(),
                child: const Text('保存'),
              ),
              if (_statusMsg != null) ...[
                const SizedBox(width: MdSpacing.sm),
                Expanded(
                  child: Text(
                    _statusMsg!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.bodySmall?.copyWith(
                      color: _statusIsError ? scheme.error : scheme.primary,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _RenderingPluginsCard extends StatefulWidget {
  const _RenderingPluginsCard({required this.settingsCtrl});

  final SettingsController settingsCtrl;

  @override
  State<_RenderingPluginsCard> createState() => _RenderingPluginsCardState();
}

class _RenderingPluginsCardState extends State<_RenderingPluginsCard> {
  late final TextEditingController _linesCtrl;
  late final TextEditingController _charsCtrl;

  @override
  void initState() {
    super.initState();
    final settings = widget.settingsCtrl.settings;
    _linesCtrl =
        TextEditingController(text: settings.collapseLineThreshold.toString());
    _charsCtrl =
        TextEditingController(text: settings.collapseCharThreshold.toString());
  }

  @override
  void dispose() {
    _linesCtrl.dispose();
    _charsCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final settings = context.watch<SettingsController>().settings;

    return Material(
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(MdRadii.md),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(MdSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
          Wrap(
            spacing: MdSpacing.sm,
            runSpacing: MdSpacing.xs,
            children: const [
              Chip(label: Text('HtmlPreviewPlugin')),
              Chip(label: Text('CodeBlockPlugin')),
              Chip(label: Text('MarkdownProsePlugin')),
            ],
          ),
          const SizedBox(height: MdSpacing.sm),
          SwitchListTile(
            key: const Key('settings_html_preview_switch'),
            contentPadding: EdgeInsets.zero,
            title: const Text('HTML 默认预览模式'),
            value: settings.defaultHtmlPreview,
            onChanged: (v) => widget.settingsCtrl.updateWith(
              (s) => s.copyWith(defaultHtmlPreview: v),
            ),
          ),
          SwitchListTile(
            key: const Key('settings_auto_collapse_switch'),
            contentPadding: EdgeInsets.zero,
            title: const Text('超长内容自动折叠'),
            value: settings.autoCollapseEnabled,
            onChanged: (v) => widget.settingsCtrl.updateWith(
              (s) => s.copyWith(autoCollapseEnabled: v),
            ),
          ),
          const SizedBox(height: MdSpacing.sm),
          Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('settings_line_threshold_field'),
                  controller: _linesCtrl,
                  enabled: settings.autoCollapseEnabled,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: '折叠行数阈值',
                  ),
                  onChanged: (val) {
                    final parsed = int.tryParse(val.trim());
                    if (parsed != null && parsed >= 4 && parsed <= 200) {
                      widget.settingsCtrl.updateWith(
                        (s) => s.copyWith(collapseLineThreshold: parsed),
                      );
                    }
                  },
                ),
              ),
              const SizedBox(width: MdSpacing.md),
              Expanded(
                child: TextField(
                  key: const Key('settings_char_threshold_field'),
                  controller: _charsCtrl,
                  enabled: settings.autoCollapseEnabled,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: '折叠字符阈值',
                  ),
                  onChanged: (val) {
                    final parsed = int.tryParse(val.trim());
                    if (parsed != null && parsed >= 120 && parsed <= 20000) {
                      widget.settingsCtrl.updateWith(
                        (s) => s.copyWith(collapseCharThreshold: parsed),
                      );
                    }
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: MdSpacing.xs),
          Row(
            children: [
              Text(
                '行数滑块 (${settings.collapseLineThreshold})',
                style: textTheme.labelMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              Expanded(
                child: Slider(
                  value: settings.collapseLineThreshold
                      .toDouble()
                      .clamp(4, 200),
                  min: 4,
                  max: 200,
                  divisions: 49,
                  onChanged: settings.autoCollapseEnabled
                      ? (v) {
                          final rounded = v.round();
                          _linesCtrl.text = rounded.toString();
                          widget.settingsCtrl.updateWith(
                            (s) => s.copyWith(collapseLineThreshold: rounded),
                          );
                        }
                      : null,
                ),
              ),
            ],
          ),
        ],
      ),
      ),
    );
  }
}

class _FormatMetaCard extends StatelessWidget {
  const _FormatMetaCard({required this.format});

  final FormatInfo format;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      width: 280,
      padding: const EdgeInsets.all(MdSpacing.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  format.displayName,
                  style: textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: scheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(MdRadii.full),
                ),
                child: Text('协议', style: textTheme.labelSmall),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            format.id,
            style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
          if (format.defaultPath.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              format.defaultPath,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: textTheme.labelSmall?.copyWith(color: scheme.primary),
            ),
          ],
          if (format.defaultCompat.thinkingFormat.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              '思考映射: ${format.defaultCompat.thinkingFormat} · ${format.defaultCompat.maxTokensField}',
              style: textTheme.labelSmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _AdapterMetaCard extends StatelessWidget {
  const _AdapterMetaCard({required this.adapter});

  final ProviderAdapterInfo adapter;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      width: 280,
      padding: const EdgeInsets.all(MdSpacing.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  adapter.displayName,
                  style: textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: scheme.tertiaryContainer,
                  borderRadius: BorderRadius.circular(MdRadii.full),
                ),
                child: Text(
                  '适配器',
                  style: textTheme.labelSmall?.copyWith(
                    color: scheme.onTertiaryContainer,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            adapter.id,
            style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _ReservedSlotCard extends StatelessWidget {
  const _ReservedSlotCard({
    required this.title,
    required this.contract,
    required this.status,
  });

  final String title;
  final String contract;
  final String status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      width: 260,
      padding: const EdgeInsets.all(MdSpacing.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(MdRadii.full),
                ),
                child: Text(status, style: textTheme.labelSmall),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            contract,
            style: textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
