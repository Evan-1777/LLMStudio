import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/state/assistants_controller.dart';
import '../../core/state/conversations_controller.dart';
import '../../core/state/plugins_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class GeneralSettingsTab extends StatefulWidget {
  const GeneralSettingsTab({super.key});

  @override
  State<GeneralSettingsTab> createState() => _GeneralSettingsTabState();
}

class _GeneralSettingsTabState extends State<GeneralSettingsTab> {
  late final TextEditingController _urlCtrl;
  late final TextEditingController _tokenCtrl;
  bool _obscureToken = true;
  bool _saving = false;
  String? _urlError;

  @override
  void initState() {
    super.initState();
    final settings = context.read<SettingsController>().settings;
    _urlCtrl = TextEditingController(text: settings.gatewayBaseUrl);
    _tokenCtrl = TextEditingController(text: settings.accessToken);
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _tokenCtrl.dispose();
    super.dispose();
  }

  String? _validateUrl(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty || trimmed == '/') return null;
    final parsed = Uri.tryParse(trimmed);
    if (parsed == null || !parsed.hasScheme || parsed.host.isEmpty) {
      return '无效网关地址';
    }
    return null;
  }

  Future<void> _saveGateway() async {
    final err = _validateUrl(_urlCtrl.text);
    setState(() => _urlError = err);
    if (err != null) return;

    setState(() => _saving = true);
    try {
      final settingsCtrl = context.read<SettingsController>();
      final providersCtrl = context.read<ProvidersController>();
      final convsCtrl = context.read<ConversationsController>();
      final assistantsCtrl = context.read<AssistantsController>();
      final pluginsCtrl = context.read<PluginsController>();
      final nextUrl = _urlCtrl.text.trim().isEmpty ? '/' : _urlCtrl.text.trim();
      await settingsCtrl.updateWith(
        (s) => s.copyWith(
          gatewayBaseUrl: nextUrl,
          accessToken: _tokenCtrl.text.trim(),
        ),
      );
      await Future.wait([
        providersCtrl.refresh(),
        convsCtrl.refresh(),
        assistantsCtrl.refresh(),
        pluginsCtrl.refresh(),
      ]);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final settingsCtrl = context.watch<SettingsController>();
    final settings = settingsCtrl.settings;

    return Align(
      alignment: Alignment.topLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 680),
        child: ListView(
          padding: const EdgeInsets.all(MdSpacing.xl),
          children: [
            Text(
              '网关连接',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
            ),
            const SizedBox(height: MdSpacing.md),
            TextField(
              key: const Key('settings_gateway_url_field'),
              controller: _urlCtrl,
              decoration: InputDecoration(
                labelText: 'Gateway Base URL',
                errorText: _urlError,
              ),
            ),
            const SizedBox(height: MdSpacing.md),
            TextField(
              key: const Key('settings_access_token_field'),
              controller: _tokenCtrl,
              obscureText: _obscureToken,
              decoration: InputDecoration(
                labelText: 'Access Token',
                suffixIcon: AppIconAction(
                  key: const Key('settings_toggle_token_visibility'),
                  svg: _obscureToken ? AppIcons.eye : AppIcons.eyeOff,
                  size: 18,
                  tooltip: _obscureToken ? '显示' : '隐藏',
                  onPressed: () =>
                      setState(() => _obscureToken = !_obscureToken),
                ),
              ),
            ),
            const SizedBox(height: MdSpacing.md),
            Wrap(
              spacing: MdSpacing.sm,
              runSpacing: MdSpacing.sm,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton.icon(
                  key: const Key('settings_test_connection_button'),
                  onPressed: settingsCtrl.connectionStatus ==
                          ConnectionCheckStatus.checking
                      ? null
                      : () => settingsCtrl.testConnection(
                            overrideBaseUrl: _urlCtrl.text.trim(),
                            overrideToken: _tokenCtrl.text.trim(),
                          ),
                  icon: AppSvgIcon(
                    AppIcons.link,
                    size: 16,
                    color: scheme.primary,
                  ),
                  label: const Text('连通性测试'),
                ),
                FilledButton(
                  key: const Key('settings_save_gateway_button'),
                  onPressed: _saving ? null : _saveGateway,
                  child: const Text('保存连接'),
                ),
                if (settingsCtrl.connectionStatus == ConnectionCheckStatus.ok)
                  Chip(
                    avatar: AppSvgIcon(
                      AppIcons.check,
                      size: 14,
                      color: scheme.primary,
                    ),
                    label: Text(settingsCtrl.connectionMessage),
                  ),
                if (settingsCtrl.connectionStatus ==
                    ConnectionCheckStatus.failed)
                  Chip(
                    backgroundColor: scheme.errorContainer,
                    avatar: AppSvgIcon(
                      AppIcons.warning,
                      size: 14,
                      color: scheme.onErrorContainer,
                    ),
                    label: Text(
                      '连接失败',
                      style: TextStyle(color: scheme.onErrorContainer),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: MdSpacing.xl),
            const Divider(),
            const SizedBox(height: MdSpacing.md),
            SwitchListTile(
              key: const Key('settings_enter_to_send_switch'),
              contentPadding: EdgeInsets.zero,
              title: const Text('Enter 发送'),
              value: settings.enterToSend,
              onChanged: (v) => settingsCtrl.updateWith(
                (s) => s.copyWith(enterToSend: v),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
