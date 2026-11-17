import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/plugin_models.dart';
import '../../core/state/plugins_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class McpServersTab extends StatefulWidget {
  const McpServersTab({super.key});

  @override
  State<McpServersTab> createState() => _McpServersTabState();
}

class _McpServersTabState extends State<McpServersTab> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final ctrl = context.read<PluginsController>();
      if (ctrl.mcpServers.isEmpty && !ctrl.isLoading) {
        ctrl.refresh();
      }
    });
  }

  Future<void> _openEditor(
    BuildContext context, {
    McpServerConfig? existing,
  }) async {
    final pluginsCtrl = context.read<PluginsController>();
    final payload = await showDialog<McpServerUpsertPayload>(
      context: context,
      builder: (ctx) => _McpServerEditorDialog(existing: existing),
    );
    if (payload == null) return;
    if (existing == null) {
      await pluginsCtrl.createMcpServer(payload);
    } else {
      await pluginsCtrl.updateMcpServer(existing.id, payload);
    }
  }

  Future<void> _confirmDelete(
    BuildContext context,
    McpServerConfig server,
  ) async {
    final pluginsCtrl = context.read<PluginsController>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除 MCP 服务'),
        content: Text('确认删除「${server.name}」？'),
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
      await pluginsCtrl.deleteMcpServer(server.id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final pluginsCtrl = context.watch<PluginsController>();
    final servers = pluginsCtrl.mcpServers;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            MdSpacing.xl,
            MdSpacing.lg,
            MdSpacing.xl,
            MdSpacing.md,
          ),
          child: Row(
            children: [
              Text(
                'MCP 服务 (${servers.length})',
                style: textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              FilledButton.icon(
                key: const Key('mcp_add_server_button'),
                onPressed: () => _openEditor(context),
                icon: AppSvgIcon(
                  AppIcons.plus,
                  size: 16,
                  color: scheme.onPrimary,
                ),
                label: const Text('添加服务'),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: servers.isEmpty
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '暂无 MCP 服务配置',
                        style: textTheme.bodyMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: MdSpacing.md),
                      OutlinedButton.icon(
                        onPressed: () => _openEditor(context),
                        icon: AppSvgIcon(AppIcons.plus, size: 16),
                        label: const Text('添加 MCP 服务'),
                      ),
                    ],
                  ),
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(MdSpacing.xl),
                  itemCount: servers.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(height: MdSpacing.sm),
                  itemBuilder: (context, index) {
                    final s = servers[index];
                    final target = s.transport == 'stdio'
                        ? '${s.command} ${s.args.join(' ')}'.trim()
                        : s.endpoint;
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
                                        s.name,
                                        style: textTheme.titleSmall?.copyWith(
                                          fontWeight: FontWeight.w600,
                                        ),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    const SizedBox(width: MdSpacing.sm),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 2,
                                      ),
                                      decoration: BoxDecoration(
                                        color: scheme.secondaryContainer,
                                        borderRadius: BorderRadius.circular(
                                          MdRadii.full,
                                        ),
                                      ),
                                      child: Text(
                                        s.transport,
                                        style: textTheme.labelSmall,
                                      ),
                                    ),
                                  ],
                                ),
                                if (target.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    target,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: textTheme.bodySmall?.copyWith(
                                      color: scheme.onSurfaceVariant,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          Switch(
                            key: Key('mcp_switch_${s.id}'),
                            value: s.enabled,
                            onChanged: (v) =>
                                pluginsCtrl.toggleMcpServer(s.id, v),
                          ),
                          AppIconAction(
                            key: Key('mcp_edit_${s.id}'),
                            svg: AppIcons.edit,
                            tooltip: '编辑',
                            onPressed: () => _openEditor(context, existing: s),
                          ),
                          AppIconAction(
                            key: Key('mcp_delete_${s.id}'),
                            svg: AppIcons.trash,
                            tooltip: '删除',
                            onPressed: () => _confirmDelete(context, s),
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

class _McpServerEditorDialog extends StatefulWidget {
  const _McpServerEditorDialog({this.existing});

  final McpServerConfig? existing;

  @override
  State<_McpServerEditorDialog> createState() => _McpServerEditorDialogState();
}

class _McpServerEditorDialogState extends State<_McpServerEditorDialog> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _commandCtrl;
  late final TextEditingController _argsCtrl;
  late final TextEditingController _endpointCtrl;
  late final TextEditingController _envOrHeadersCtrl;
  late String _transport;
  late bool _enabled;
  String? _error;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _nameCtrl = TextEditingController(text: e?.name ?? '');
    _transport = e?.transport ?? 'stdio';
    _commandCtrl = TextEditingController(text: e?.command ?? '');
    _argsCtrl = TextEditingController(text: e?.args.join(' ') ?? '');
    _endpointCtrl = TextEditingController(text: e?.endpoint ?? '');
    _envOrHeadersCtrl = TextEditingController(
      text: _transport == 'stdio'
          ? (e?.env.isNotEmpty == true ? jsonEncode(e!.env) : '')
          : (e?.headers.isNotEmpty == true ? jsonEncode(e!.headers) : ''),
    );
    _enabled = e?.enabled ?? true;
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _commandCtrl.dispose();
    _argsCtrl.dispose();
    _endpointCtrl.dispose();
    _envOrHeadersCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      setState(() => _error = '名称不能为空');
      return;
    }
    if (_transport == 'stdio' && _commandCtrl.text.trim().isEmpty) {
      setState(() => _error = 'stdio 模式命令不能为空');
      return;
    }
    if (_transport != 'stdio' && _endpointCtrl.text.trim().isEmpty) {
      setState(() => _error = '远程模式端点地址不能为空');
      return;
    }

    Map<String, String> extraMap = const {};
    final rawMap = _envOrHeadersCtrl.text.trim();
    if (rawMap.isNotEmpty) {
      try {
        final decoded = jsonDecode(rawMap);
        if (decoded is! Map) {
          setState(() => _error = '环境变量 / 请求头须为 JSON 对象');
          return;
        }
        extraMap = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      } catch (_) {
        setState(() => _error = 'JSON 格式无效');
        return;
      }
    }

    final args = _argsCtrl.text
        .trim()
        .split(RegExp(r'\s+'))
        .where((s) => s.isNotEmpty)
        .toList();

    Navigator.of(context).pop(
      McpServerUpsertPayload(
        name: name,
        transport: _transport,
        command: _transport == 'stdio' ? _commandCtrl.text.trim() : '',
        args: _transport == 'stdio' ? args : const [],
        endpoint: _transport != 'stdio' ? _endpointCtrl.text.trim() : '',
        env: _transport == 'stdio' ? extraMap : const {},
        headers: _transport != 'stdio' ? extraMap : const {},
        enabled: _enabled,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.existing == null ? '添加 MCP 服务' : '编辑 MCP 服务'),
      content: SizedBox(
        width: 460,
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
                key: const Key('mcp_name_field'),
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: '服务名称'),
              ),
              const SizedBox(height: MdSpacing.sm),
              DropdownButtonFormField<String>(
                key: const Key('mcp_transport_field'),
                initialValue: _transport,
                decoration: const InputDecoration(labelText: '传输类型'),
                items: const [
                  DropdownMenuItem(value: 'stdio', child: Text('stdio')),
                  DropdownMenuItem(value: 'sse', child: Text('sse')),
                  DropdownMenuItem(
                    value: 'streamable-http',
                    child: Text('streamable-http'),
                  ),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _transport = v);
                },
              ),
              const SizedBox(height: MdSpacing.sm),
              if (_transport == 'stdio') ...[
                TextField(
                  key: const Key('mcp_command_field'),
                  controller: _commandCtrl,
                  decoration: const InputDecoration(labelText: '启动命令'),
                ),
                const SizedBox(height: MdSpacing.sm),
                TextField(
                  key: const Key('mcp_args_field'),
                  controller: _argsCtrl,
                  decoration: const InputDecoration(labelText: '参数（空格分隔）'),
                ),
              ] else
                TextField(
                  key: const Key('mcp_endpoint_field'),
                  controller: _endpointCtrl,
                  decoration: const InputDecoration(labelText: '服务地址 URL'),
                ),
              const SizedBox(height: MdSpacing.sm),
              TextField(
                controller: _envOrHeadersCtrl,
                decoration: InputDecoration(
                  labelText:
                      _transport == 'stdio' ? '环境变量 (JSON)' : '自定义请求头 (JSON)',
                ),
              ),
              const SizedBox(height: MdSpacing.xs),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('启用'),
                value: _enabled,
                onChanged: (v) => setState(() => _enabled = v),
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
          key: const Key('mcp_save_button'),
          onPressed: _submit,
          child: const Text('保存'),
        ),
      ],
    );
  }
}
