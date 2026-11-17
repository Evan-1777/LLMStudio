import 'package:flutter/material.dart';

import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import 'about_settings_tab.dart';
import 'appearance_settings_tab.dart';
import 'general_settings_tab.dart';
import 'mcp_servers_tab.dart';
import 'plugins_center_tab.dart';
import 'providers_tab.dart';

enum SettingsCategory {
  providers,
  plugins,
  general,
  appearance,
  mcp,
  about,
}

class _SettingsNavItem {
  const _SettingsNavItem({
    required this.category,
    required this.keyName,
    required this.label,
    required this.icon,
  });

  final SettingsCategory category;
  final String keyName;
  final String label;
  final String icon;
}

final List<_SettingsNavItem> _navItems = [
  _SettingsNavItem(
    category: SettingsCategory.providers,
    keyName: 'settings_nav_providers',
    label: '模型服务',
    icon: AppIcons.cpu,
  ),
  _SettingsNavItem(
    category: SettingsCategory.plugins,
    keyName: 'settings_nav_plugins',
    label: '插件中心',
    icon: AppIcons.plugin,
  ),
  _SettingsNavItem(
    category: SettingsCategory.general,
    keyName: 'settings_nav_general',
    label: '常规与连接',
    icon: AppIcons.link,
  ),
  _SettingsNavItem(
    category: SettingsCategory.appearance,
    keyName: 'settings_nav_appearance',
    label: '外观与显示',
    icon: AppIcons.sun,
  ),
  _SettingsNavItem(
    category: SettingsCategory.mcp,
    keyName: 'settings_nav_mcp',
    label: 'MCP 服务',
    icon: AppIcons.wrench,
  ),
  _SettingsNavItem(
    category: SettingsCategory.about,
    keyName: 'settings_nav_about',
    label: '关于',
    icon: AppIcons.bot,
  ),
];

class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    this.initialCategory = SettingsCategory.providers,
    this.onBack,
  });

  final SettingsCategory initialCategory;
  final VoidCallback? onBack;

  static Future<void> open(
    BuildContext context, {
    SettingsCategory initialCategory = SettingsCategory.providers,
  }) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(initialCategory: initialCategory),
      ),
    );
  }

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late SettingsCategory _selectedCategory;
  bool _compactShowDetail = false;

  @override
  void initState() {
    super.initState();
    _selectedCategory = widget.initialCategory;
  }

  void _backToWorkbench() {
    if (widget.onBack != null) {
      widget.onBack!();
      return;
    }
    Navigator.of(context).maybePop();
  }

  String _titleFor(SettingsCategory c) {
    for (final item in _navItems) {
      if (item.category == c) return item.label;
    }
    return '设置';
  }

  Widget _buildDetail(SettingsCategory category) {
    return switch (category) {
      SettingsCategory.providers => const ProvidersTab(),
      SettingsCategory.plugins => const PluginsCenterTab(),
      SettingsCategory.general => const GeneralSettingsTab(),
      SettingsCategory.appearance => const AppearanceSettingsTab(),
      SettingsCategory.mcp => const McpServersTab(),
      SettingsCategory.about => const AboutSettingsTab(),
    };
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      backgroundColor: scheme.surface,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final isCompact = MdBreakpoints.isCompact(constraints.maxWidth);

            if (isCompact) {
              if (_compactShowDetail) {
                return Column(
                  children: [
                    _CompactHeader(
                      backKey: const Key('settings_compact_back_to_nav'),
                      title: _titleFor(_selectedCategory),
                      onBack: () => setState(() => _compactShowDetail = false),
                    ),
                    const Divider(height: 1),
                    Expanded(child: _buildDetail(_selectedCategory)),
                  ],
                );
              }
              return Column(
                children: [
                  _CompactHeader(
                    backKey: const Key('settings_back_button'),
                    title: '设置',
                    onBack: _backToWorkbench,
                  ),
                  const Divider(height: 1),
                  Expanded(
                    child: _SettingsNavList(
                      selected: _selectedCategory,
                      onSelect: (category) => setState(() {
                        _selectedCategory = category;
                        _compactShowDetail = true;
                      }),
                    ),
                  ),
                ],
              );
            }

            return Row(
              children: [
                Container(
                  width: 210,
                  color: scheme.surfaceContainerLow,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(
                          MdSpacing.sm,
                          MdSpacing.md,
                          MdSpacing.md,
                          MdSpacing.sm,
                        ),
                        child: TextButton.icon(
                          key: const Key('settings_back_button'),
                          onPressed: _backToWorkbench,
                          style: TextButton.styleFrom(
                            alignment: Alignment.centerLeft,
                            padding: const EdgeInsets.symmetric(
                              horizontal: MdSpacing.md,
                              vertical: MdSpacing.sm,
                            ),
                          ),
                          icon: AppSvgIcon(
                            AppIcons.arrowLeft,
                            size: 16,
                            color: scheme.onSurface,
                          ),
                          label: Text(
                            '返回工作台',
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                      ),
                      Expanded(
                        child: _SettingsNavList(
                          selected: _selectedCategory,
                          onSelect: (category) => setState(() {
                            _selectedCategory = category;
                          }),
                        ),
                      ),
                    ],
                  ),
                ),
                const VerticalDivider(width: 1),
                Expanded(child: _buildDetail(_selectedCategory)),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _CompactHeader extends StatelessWidget {
  const _CompactHeader({
    required this.backKey,
    required this.title,
    required this.onBack,
  });

  final Key backKey;
  final String title;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 52,
      child: Row(
        children: [
          AppIconAction(
            key: backKey,
            svg: AppIcons.arrowLeft,
            tooltip: '返回',
            onPressed: onBack,
          ),
          Text(
            title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
          ),
        ],
      ),
    );
  }
}

class _SettingsNavList extends StatelessWidget {
  const _SettingsNavList({
    required this.selected,
    required this.onSelect,
  });

  final SettingsCategory selected;
  final ValueChanged<SettingsCategory> onSelect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return ListView(
      padding: const EdgeInsets.symmetric(
        horizontal: MdSpacing.sm,
        vertical: MdSpacing.sm,
      ),
      children: [
        for (final item in _navItems) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Material(
              color: selected == item.category
                  ? scheme.secondaryContainer
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(MdRadii.full),
              child: InkWell(
                key: Key(item.keyName),
                borderRadius: BorderRadius.circular(MdRadii.full),
                onTap: () => onSelect(item.category),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: MdSpacing.md,
                    vertical: 10,
                  ),
                  child: Row(
                    children: [
                      AppSvgIcon(
                        item.icon,
                        size: 18,
                        color: selected == item.category
                            ? scheme.onSecondaryContainer
                            : scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: MdSpacing.md),
                      Expanded(
                        child: Text(
                          item.label,
                          style: textTheme.bodyMedium?.copyWith(
                            fontWeight: selected == item.category
                                ? FontWeight.w600
                                : FontWeight.w400,
                            color: selected == item.category
                                ? scheme.onSecondaryContainer
                                : scheme.onSurface,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}
