import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/md_tokens.dart';

class AppearanceSettingsTab extends StatelessWidget {
  const AppearanceSettingsTab({super.key});

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
              '主题模式',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
            ),
            const SizedBox(height: MdSpacing.sm),
            Align(
              alignment: Alignment.centerLeft,
              child: SegmentedButton<ThemeMode>(
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
            ),
            const SizedBox(height: MdSpacing.xl),
            Text(
              '主题色',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
            ),
            const SizedBox(height: MdSpacing.md),
            Wrap(
              spacing: MdSpacing.md,
              runSpacing: MdSpacing.md,
              children: [
                for (final color in AppTheme.presetSeedColors)
                  InkWell(
                    onTap: () => settingsCtrl.updateWith(
                      (s) => s.copyWith(seedColorValue: color.toARGB32()),
                    ),
                    borderRadius: BorderRadius.circular(MdRadii.full),
                    child: Container(
                      width: 36,
                      height: 36,
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
          ],
        ),
      ),
    );
  }
}
