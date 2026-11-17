import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/models/app_settings.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/state/conversations_controller.dart';
import 'package:llmstudio_frontend/core/state/providers_controller.dart';
import 'package:llmstudio_frontend/core/state/settings_controller.dart';
import 'package:llmstudio_frontend/core/storage/settings_store.dart';
import 'package:llmstudio_frontend/core/theme/app_theme.dart';
import 'package:llmstudio_frontend/features/settings/settings_dialog.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSettingsGateway extends GatewayClient {
  _FakeSettingsGateway() : super(baseUrl: 'http://localhost:8080');

  bool healthChecked = false;
  bool deleted = false;
  List<ProviderConfig> items = [
    const ProviderConfig(
      id: 'p1',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      authType: 'bearer',
      apiKeyMasked: 'sk-1...2345',
      apiKeySet: true,
      enabled: true,
      models: [
        ModelConfig(id: 'gpt-4o', name: 'GPT-4o', apiFormat: 'openai-completions'),
      ],
    ),
  ];

  @override
  Future<Map<String, dynamic>> healthCheck() async {
    healthChecked = true;
    return {'status': 'ok', 'version': '0.1.0'};
  }

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(id: 'openai-completions', displayName: 'OpenAI Completions'),
      ];

  @override
  Future<List<ProviderConfig>> listProviders() async => items;

  @override
  Future<void> deleteProvider(String id) async {
    deleted = true;
    items = items.where((e) => e.id != id).toList();
  }
}

void main() {
  Future<
      ({
        SettingsController settingsCtrl,
        ProvidersController providersCtrl,
        ConversationsController convsCtrl,
        _FakeSettingsGateway gw,
      })> buildDeps() async {
    SharedPreferences.setMockInitialValues({});
    final gw = _FakeSettingsGateway();
    final settingsCtrl = SettingsController(
      store: SettingsStore(),
      gateway: gw,
      initialSettings: AppSettings.defaults(),
    );
    await settingsCtrl.load();
    final providersCtrl = ProvidersController(gateway: gw);
    await providersCtrl.refresh();
    final convsCtrl = ConversationsController(gateway: gw);
    return (
      settingsCtrl: settingsCtrl,
      providersCtrl: providersCtrl,
      convsCtrl: convsCtrl,
      gw: gw,
    );
  }

  testWidgets('SettingsDialog switches tabs, tests gateway, persists rendering thresholds, and confirms delete', (tester) async {
    final deps = await buildDeps();

    await tester.binding.setSurfaceSize(const Size(1200, 800));
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: deps.settingsCtrl),
          ChangeNotifierProvider.value(value: deps.providersCtrl),
          ChangeNotifierProvider.value(value: deps.convsCtrl),
        ],
        child: MaterialApp(
          theme: AppTheme.build(brightness: Brightness.light),
          home: const Scaffold(body: SettingsDialog()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Tab 1: Gateway & Theme
    await tester.tap(find.byKey(const Key('settings_toggle_token_visibility')));
    await tester.tap(find.byKey(const Key('settings_test_connection_button')));
    await tester.pumpAndSettle();
    expect(deps.gw.healthChecked, isTrue);
    expect(find.text('v0.1.0'), findsOneWidget);

    await tester.tap(find.text('深色'));
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.themeMode, ThemeMode.dark);

    // Tab 3: Rendering thresholds & switches
    await tester.tap(find.text('内容渲染'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('settings_line_threshold_field')),
      '42',
    );
    await tester.enterText(
      find.byKey(const Key('settings_char_threshold_field')),
      '2400',
    );
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.collapseLineThreshold, 42);
    expect(deps.settingsCtrl.settings.collapseCharThreshold, 2400);

    await tester.tap(find.byKey(const Key('settings_auto_collapse_switch')));
    await tester.tap(find.byKey(const Key('settings_html_preview_switch')));
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.autoCollapseEnabled, isFalse);
    expect(deps.settingsCtrl.settings.defaultHtmlPreview, isFalse);

    // Tab 2: Providers validation & delete confirmation
    await tester.tap(find.text('供应商与模型'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('settings_add_provider_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('provider_save_button')));
    await tester.pumpAndSettle();
    expect(find.text('名称不能为空'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('delete_provider_p1')));
    await tester.pumpAndSettle();
    expect(find.text('删除供应商'), findsOneWidget);
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();
    expect(deps.gw.deleted, isTrue);

    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('SettingsDialog renders full-screen on compact mobile viewport without overflow', (tester) async {
    final deps = await buildDeps();
    await tester.binding.setSurfaceSize(const Size(390, 844));
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider.value(value: deps.settingsCtrl),
          ChangeNotifierProvider.value(value: deps.providersCtrl),
          ChangeNotifierProvider.value(value: deps.convsCtrl),
        ],
        child: MaterialApp(
          theme: AppTheme.build(brightness: Brightness.light),
          home: const Scaffold(body: SettingsDialog()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(Dialog), findsOneWidget);
    expect(find.text('网关与主题'), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });
}
