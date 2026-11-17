import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/theme/app_icons.dart';
import 'package:llmstudio_frontend/core/theme/app_theme.dart';
import 'package:llmstudio_frontend/core/theme/md_tokens.dart';

void main() {
  test('MdBreakpoints classifies compact, medium, and expanded widths', () {
    expect(MdBreakpoints.classify(390), WindowSizeClass.compact);
    expect(MdBreakpoints.classify(599), WindowSizeClass.compact);
    expect(MdBreakpoints.classify(600), WindowSizeClass.medium);
    expect(MdBreakpoints.classify(839), WindowSizeClass.medium);
    expect(MdBreakpoints.classify(840), WindowSizeClass.expanded);
    expect(MdBreakpoints.classify(1280), WindowSizeClass.expanded);
  });

  test('AppTheme builds Material 3 light and dark themes without shadows', () {
    final light = AppTheme.build(brightness: Brightness.light);
    final dark = AppTheme.build(brightness: Brightness.dark);

    expect(light.useMaterial3, isTrue);
    expect(dark.useMaterial3, isTrue);
    expect(light.colorScheme.brightness, Brightness.light);
    expect(dark.colorScheme.brightness, Brightness.dark);
    expect(light.cardTheme.elevation, 0);
    expect(dark.cardTheme.elevation, 0);
  });

  testWidgets('AppSvgIcon renders tinted SVG with semantic label', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.build(brightness: Brightness.light),
        home: Scaffold(
          body: Row(
            children: [
              AppSvgIcon(AppIcons.send, semanticsLabel: 'Send'),
              AppSvgIcon(AppIcons.stop, semanticsLabel: 'Stop'),
              AppSvgIcon(AppIcons.settings, semanticsLabel: 'Settings'),
            ],
          ),
        ),
      ),
    );

    expect(find.bySemanticsLabel('Send'), findsOneWidget);
    expect(find.bySemanticsLabel('Stop'), findsOneWidget);
    expect(find.bySemanticsLabel('Settings'), findsOneWidget);
  });
}
