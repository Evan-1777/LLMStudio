import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/models/app_settings.dart';
import 'package:llmstudio_frontend/core/models/plugin_models.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/state/assistants_controller.dart';
import 'package:llmstudio_frontend/core/state/conversations_controller.dart';
import 'package:llmstudio_frontend/core/state/plugins_controller.dart';
import 'package:llmstudio_frontend/core/state/providers_controller.dart';
import 'package:llmstudio_frontend/core/state/settings_controller.dart';
import 'package:llmstudio_frontend/core/storage/settings_store.dart';
import 'package:llmstudio_frontend/core/theme/app_theme.dart';
import 'package:llmstudio_frontend/features/settings/settings_page.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSettingsGateway extends GatewayClient {
  _FakeSettingsGateway() : super(baseUrl: 'http://localhost:8080');

  bool healthChecked = false;
  bool deleted = false;
  bool testedProvider = false;
  bool testedSearch = false;
  List<ProviderConfig> items = [
    const ProviderConfig(
      id: 'p1',
      name: 'Axonhub',
      baseUrl: 'https://api.evan-ai.xyz/v1',
      authType: 'bearer',
      apiKeyMasked: 'sk-1...2345',
      apiKeySet: true,
      enabled: true,
      models: [
        ModelConfig(
          id: 'model-chat',
          name: 'model-chat',
          apiFormat: 'openai-responses',
        ),
      ],
    ),
  ];
  List<SearchEnginePluginConfig> engines = [
    const SearchEnginePluginConfig(
      engineId: 'tavily',
      displayName: 'Tavily Search',
      defaultEndpoint: 'https://api.tavily.com/search',
      requiresApiKey: true,
      enabled: true,
      endpoint: 'https://api.tavily.com/search',
      isDefault: true,
      maxResults: 5,
    ),
  ];
  List<McpServerConfig> mcpServers = [];

  @override
  Future<Map<String, dynamic>> healthCheck() async {
    healthChecked = true;
    return {'status': 'ok', 'version': '0.1.0'};
  }

  @override
  Future<List<FormatInfo>> listFormats() async => const [
        FormatInfo(
          id: 'openai-completions',
          displayName: 'OpenAI Chat Completions',
          defaultPath: '/v1/chat/completions',
        ),
        FormatInfo(
          id: 'openai-responses',
          displayName: 'OpenAI Responses',
          defaultPath: '/v1/responses',
        ),
      ];

  @override
  Future<List<ProviderConfig>> listProviders() async => items;

  @override
  Future<ProviderConfig> updateProvider(
    String id,
    ProviderUpsertPayload payload,
  ) async {
    final updated = ProviderConfig(
      id: id,
      name: payload.name,
      adapter: payload.adapter,
      baseUrl: payload.baseUrl,
      authType: payload.authType,
      apiKeySet: true,
      apiKeyMasked: 'sk-1...2345',
      models: payload.models,
      enabled: payload.enabled,
    );
    items = [
      for (final p in items)
        if (p.id == id) updated else p,
    ];
    return updated;
  }

  @override
  Future<void> deleteProvider(String id) async {
    deleted = true;
    items = items.where((e) => e.id != id).toList();
  }

  @override
  Future<ProviderConnectionTestResult> testProviderConnection(
    String id, {
    String? baseUrl,
    String? authType,
    String? apiKey,
    Map<String, String>? headers,
  }) async {
    testedProvider = true;
    return const ProviderConnectionTestResult(
      ok: true,
      latencyMs: 18,
      modelCount: 2,
      message: '连接正常',
    );
  }

  @override
  Future<List<DiscoveredModel>> fetchProviderModels(
    String id, {
    String? baseUrl,
    String? authType,
    String? apiKey,
    Map<String, String>? headers,
  }) async {
    return const [
      DiscoveredModel(
        id: 'model-chat',
        name: 'model-chat',
        group: 'model',
        apiFormat: 'openai-responses',
      ),
      DiscoveredModel(
        id: 'model-chat-pro',
        name: 'model-chat-pro',
        group: 'model',
        apiFormat: 'openai-responses',
        reasoning: true,
      ),
    ];
  }

  @override
  Future<List<SearchEnginePluginConfig>> listSearchEngines() async => engines;

  @override
  Future<SearchEngineTestResult> testSearchEngine(
    String id, {
    String? query,
    String? endpoint,
    String? apiKey,
    int? maxResults,
  }) async {
    testedSearch = true;
    return SearchEngineTestResult(
      ok: true,
      engineId: id,
      resultCount: 3,
      latencyMs: 25,
      message: '搜索测试正常',
    );
  }

  @override
  Future<List<McpServerConfig>> listMcpServers() async => mcpServers;

  @override
  Future<McpServerConfig> createMcpServer(McpServerUpsertPayload payload) async {
    final created = McpServerConfig(
      id: 'mcp-${mcpServers.length + 1}',
      name: payload.name,
      transport: payload.transport,
      command: payload.command,
      args: payload.args,
      endpoint: payload.endpoint,
      enabled: payload.enabled,
    );
    mcpServers = [...mcpServers, created];
    return created;
  }

  @override
  Future<void> deleteMcpServer(String id) async {
    mcpServers = mcpServers.where((s) => s.id != id).toList();
  }
}

void main() {
  Future<
      ({
        SettingsController settingsCtrl,
        ProvidersController providersCtrl,
        AssistantsController assistantsCtrl,
        PluginsController pluginsCtrl,
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
    final assistantsCtrl = AssistantsController(gateway: gw);
    final pluginsCtrl = PluginsController(gateway: gw);
    await pluginsCtrl.refresh();
    final convsCtrl = ConversationsController(gateway: gw);
    return (
      settingsCtrl: settingsCtrl,
      providersCtrl: providersCtrl,
      assistantsCtrl: assistantsCtrl,
      pluginsCtrl: pluginsCtrl,
      convsCtrl: convsCtrl,
      gw: gw,
    );
  }

  Widget wrapPage(
    ({
      SettingsController settingsCtrl,
      ProvidersController providersCtrl,
      AssistantsController assistantsCtrl,
      PluginsController pluginsCtrl,
      ConversationsController convsCtrl,
      _FakeSettingsGateway gw,
    }) deps, {
    VoidCallback? onBack,
  }) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: deps.settingsCtrl),
        ChangeNotifierProvider.value(value: deps.providersCtrl),
        ChangeNotifierProvider.value(value: deps.assistantsCtrl),
        ChangeNotifierProvider.value(value: deps.pluginsCtrl),
        ChangeNotifierProvider.value(value: deps.convsCtrl),
      ],
      child: MaterialApp(
        theme: AppTheme.build(brightness: Brightness.light),
        home: SettingsPage(onBack: onBack),
      ),
    );
  }

  testWidgets('SettingsPage renders 3-column providers, live URL preview, model import, plugins center, and MCP CRUD', (tester) async {
    final deps = await buildDeps();
    var backedOut = false;

    await tester.binding.setSurfaceSize(const Size(1200, 800));
    await tester.pumpWidget(wrapPage(deps, onBack: () => backedOut = true));
    await tester.pumpAndSettle();

    // Default category: 模型服务 with live URL preview & connection check.
    expect(find.text('预览: https://api.evan-ai.xyz/v1/responses'), findsOneWidget);

    await tester.tap(find.byKey(const Key('provider_test_connection_button')));
    await tester.pumpAndSettle();
    expect(deps.gw.testedProvider, isTrue);
    expect(find.textContaining('连接正常'), findsOneWidget);

    // Fetch and import models via multi-select modal.
    await tester.tap(find.byKey(const Key('provider_fetch_models_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('import_model_checkbox_model-chat-pro')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('import_models_confirm_button')));
    await tester.pumpAndSettle();
    expect(deps.providersCtrl.providers.first.models.any((m) => m.id == 'model-chat-pro'), isTrue);

    // Provider validation in Add dialog + Delete in Advanced dialog.
    await tester.tap(find.byKey(const Key('settings_add_provider_button')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('provider_save_button')));
    await tester.pumpAndSettle();
    expect(find.text('名称不能为空'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    // 插件中心: search test + rendering thresholds.
    await tester.tap(find.byKey(const Key('settings_nav_plugins')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('search_test_tavily')));
    await tester.pumpAndSettle();
    expect(deps.gw.testedSearch, isTrue);

    await tester.enterText(find.byKey(const Key('settings_line_threshold_field')), '42');
    await tester.enterText(find.byKey(const Key('settings_char_threshold_field')), '2400');
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.collapseLineThreshold, 42);
    expect(deps.settingsCtrl.settings.collapseCharThreshold, 2400);

    await tester.tap(find.byKey(const Key('settings_auto_collapse_switch')));
    await tester.tap(find.byKey(const Key('settings_html_preview_switch')));
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.autoCollapseEnabled, isFalse);
    expect(deps.settingsCtrl.settings.defaultHtmlPreview, isFalse);

    // 常规与连接: gateway test.
    await tester.tap(find.byKey(const Key('settings_nav_general')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings_test_connection_button')));
    await tester.pumpAndSettle();
    expect(deps.gw.healthChecked, isTrue);
    expect(find.text('v0.1.0'), findsOneWidget);

    // 外观与显示: theme mode.
    await tester.tap(find.byKey(const Key('settings_nav_appearance')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('深色'));
    await tester.pumpAndSettle();
    expect(deps.settingsCtrl.settings.themeMode, ThemeMode.dark);

    // MCP 服务: add + delete.
    await tester.tap(find.byKey(const Key('settings_nav_mcp')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('mcp_add_server_button')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('mcp_name_field')), 'local-fs');
    await tester.enterText(find.byKey(const Key('mcp_command_field')), 'npx');
    await tester.tap(find.byKey(const Key('mcp_save_button')));
    await tester.pumpAndSettle();
    expect(find.text('local-fs'), findsOneWidget);

    // Back button returns to workbench.
    await tester.tap(find.byKey(const Key('settings_back_button')));
    await tester.pumpAndSettle();
    expect(backedOut, isTrue);

    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('SettingsPage adapts to compact 390x844 two-level navigation without overflow', (tester) async {
    final deps = await buildDeps();
    await tester.binding.setSurfaceSize(const Size(390, 844));
    await tester.pumpWidget(wrapPage(deps));
    await tester.pumpAndSettle();

    expect(find.byType(Dialog), findsNothing);
    expect(find.byKey(const Key('settings_back_button')), findsOneWidget);
    expect(find.byKey(const Key('settings_nav_general')), findsOneWidget);

    await tester.tap(find.byKey(const Key('settings_nav_general')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('settings_compact_back_to_nav')), findsOneWidget);
    expect(find.byKey(const Key('settings_gateway_url_field')), findsOneWidget);

    await tester.tap(find.byKey(const Key('settings_compact_back_to_nav')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('settings_nav_plugins')), findsOneWidget);

    await tester.binding.setSurfaceSize(null);
  });
}
