import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/state/settings_controller.dart';
import '../../core/theme/md_tokens.dart';

class RenderingTab extends StatefulWidget {
  const RenderingTab({super.key});

  @override
  State<RenderingTab> createState() => _RenderingTabState();
}

class _RenderingTabState extends State<RenderingTab> {
  late final TextEditingController _linesCtrl;
  late final TextEditingController _charsCtrl;

  @override
  void initState() {
    super.initState();
    final settings = context.read<SettingsController>().settings;
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
    final settingsCtrl = context.watch<SettingsController>();
    final settings = settingsCtrl.settings;

    return ListView(
      padding: const EdgeInsets.all(MdSpacing.lg),
      children: [
        SwitchListTile(
          key: const Key('settings_auto_collapse_switch'),
          contentPadding: EdgeInsets.zero,
          title: const Text('超长内容自动折叠'),
          value: settings.autoCollapseEnabled,
          onChanged: (v) => settingsCtrl.updateWith(
            (s) => s.copyWith(autoCollapseEnabled: v),
          ),
        ),
        const SizedBox(height: MdSpacing.md),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('settings_line_threshold_field'),
                controller: _linesCtrl,
                enabled: settings.autoCollapseEnabled,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: '折叠行数阈值',
                ),
                onChanged: (val) {
                  final parsed = int.tryParse(val.trim());
                  if (parsed != null && parsed >= 4 && parsed <= 200) {
                    settingsCtrl.updateWith(
                      (s) => s.copyWith(collapseLineThreshold: parsed),
                    );
                  }
                },
              ),
            ),
            const SizedBox(width: MdSpacing.lg),
            Expanded(
              child: TextField(
                key: const Key('settings_char_threshold_field'),
                controller: _charsCtrl,
                enabled: settings.autoCollapseEnabled,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: '折叠字符阈值',
                ),
                onChanged: (val) {
                  final parsed = int.tryParse(val.trim());
                  if (parsed != null && parsed >= 120 && parsed <= 20000) {
                    settingsCtrl.updateWith(
                      (s) => s.copyWith(collapseCharThreshold: parsed),
                    );
                  }
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: MdSpacing.sm),
        Slider(
          value: settings.collapseLineThreshold.toDouble().clamp(4, 200),
          min: 4,
          max: 200,
          divisions: 49,
          onChanged: settings.autoCollapseEnabled
              ? (v) {
                  final rounded = v.round();
                  _linesCtrl.text = rounded.toString();
                  settingsCtrl.updateWith(
                    (s) => s.copyWith(collapseLineThreshold: rounded),
                  );
                }
              : null,
        ),
        const SizedBox(height: MdSpacing.md),
        SwitchListTile(
          key: const Key('settings_html_preview_switch'),
          contentPadding: EdgeInsets.zero,
          title: const Text('HTML 默认预览模式'),
          value: settings.defaultHtmlPreview,
          onChanged: (v) => settingsCtrl.updateWith(
            (s) => s.copyWith(defaultHtmlPreview: v),
          ),
        ),
      ],
    );
  }
}
