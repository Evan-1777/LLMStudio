import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/state/conversations_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/md_tokens.dart';

class GatewayThemeTab extends StatefulWidget {
  const GatewayThemeTab({super.key});

  @override
  State<GatewayThemeTab> createState() => _GatewayThemeTabState();
}

class _GatewayThemeTabState extends State<GatewayThemeTab> {
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

    return ListView(
      padding: const EdgeInsets.all(MdSpacing.lg),
      children: [
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
              onPressed: () => setState(() => _obscureToken = !_obscureToken),
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
              onPressed:
                  settingsCtrl.connectionStatus == ConnectionCheckStatus.checking
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
            if (settingsCtrl.connectionStatus == ConnectionCheckStatus.failed)
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
        const SizedBox(height: MdSpacing.lg),
        Text(
          '主题模式',
          style: Theme.of(context).textTheme.labelMedium,
        ),
        const SizedBox(height: MdSpacing.sm),
        SegmentedButton<ThemeMode>(
          segments: [
            ButtonSegment(
              value: ThemeMode.system,
              icon: AppSvgIcon(AppIcons.monitor, size: 16),
              label: const Text('系统'),
            ),
            ButtonSegment(
              value: ThemeMode.light,
              icon: AppSvgIcon(AppIcons.sun, size: 16),
              label: const Text('浅色'),
            ),
            ButtonSegment(
              value: ThemeMode.dark,
              icon: AppSvgIcon(AppIcons.moon, size: 16),
              label: const Text('深色'),
            ),
          ],
          selected: {settings.themeMode},
          onSelectionChanged: (val) => settingsCtrl.updateWith(
            (s) => s.copyWith(themeMode: val.first),
          ),
        ),
        const SizedBox(height: MdSpacing.lg),
        Text(
          '主题色',
          style: Theme.of(context).textTheme.labelMedium,
        ),
        const SizedBox(height: MdSpacing.sm),
        Wrap(
          spacing: MdSpacing.md,
          children: [
            for (final color in AppTheme.presetSeedColors)
              InkWell(
                onTap: () => settingsCtrl.updateWith(
                  (s) => s.copyWith(seedColorValue: color.toARGB32()),
                ),
                borderRadius: BorderRadius.circular(MdRadii.full),
                child: Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: settings.seedColorValue == color.toARGB32()
                          ? scheme.onSurface
                          : Colors.transparent,
                      width: 2,
                    ),
                  ),
                  child: settings.seedColorValue == color.toARGB32()
                      ? Center(
                          child: AppSvgIcon(
                            AppIcons.check,
                            size: 16,
                            color: Colors.white,
                          ),
                        )
                      : null,
                ),
              ),
          ],
        ),
        const SizedBox(height: MdSpacing.lg),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Enter 发送'),
          value: settings.enterToSend,
          onChanged: (v) => settingsCtrl.updateWith(
            (s) => s.copyWith(enterToSend: v),
          ),
        ),
      ],
    );
  }
}
