import 'package:flutter/material.dart';

import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import 'gateway_theme_tab.dart';
import 'providers_tab.dart';
import 'rendering_tab.dart';

class SettingsDialog extends StatelessWidget {
  const SettingsDialog({super.key});

  static Future<void> show(BuildContext context) {
    return showDialog<void>(
      context: context,
      builder: (_) => const SettingsDialog(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final size = MediaQuery.sizeOf(context);
    final isCompact = MdBreakpoints.isCompact(size.width);

    final content = DefaultTabController(
      length: 3,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              MdSpacing.lg,
              MdSpacing.sm,
              MdSpacing.sm,
              0,
            ),
            child: Row(
              children: [
                Text(
                  '设置',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                ),
                const Spacer(),
                AppIconAction(
                  key: const Key('settings_close_button'),
                  svg: AppIcons.close,
                  tooltip: '关闭',
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
          const TabBar(
            tabs: [
              Tab(text: '网关与主题'),
              Tab(text: '供应商与模型'),
              Tab(text: '内容渲染'),
            ],
          ),
          const Expanded(
            child: TabBarView(
              children: [
                GatewayThemeTab(),
                ProvidersTab(),
                RenderingTab(),
              ],
            ),
          ),
        ],
      ),
    );

    if (isCompact) {
      return Dialog.fullscreen(
        backgroundColor: scheme.surfaceContainerHighest,
        child: SafeArea(child: content),
      );
    }

    return Dialog(
      backgroundColor: scheme.surfaceContainerHighest,
      insetPadding: const EdgeInsets.all(MdSpacing.xl),
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: MdBreakpoints.settingsDialogMaxWidth,
          maxHeight: 680,
        ),
        child: content,
      ),
    );
  }
}
