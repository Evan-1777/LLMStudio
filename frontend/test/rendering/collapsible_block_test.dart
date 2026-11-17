import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/theme/app_theme.dart';
import 'package:llmstudio_frontend/rendering/builtin_plugins.dart';
import 'package:llmstudio_frontend/rendering/collapsible_block_container.dart';
import 'package:llmstudio_frontend/rendering/content_renderer.dart';
import 'package:llmstudio_frontend/rendering/markdown_parser.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(
        theme: AppTheme.build(brightness: Brightness.light),
        home: Scaffold(body: SingleChildScrollView(child: child)),
      );

  testWidgets('HtmlPreviewPlugin skips sandbox on unclosed streaming and toggles Preview/Source when closed', (tester) async {
    final registry = createDefaultRendererRegistry();

    await tester.pumpWidget(
      wrap(
        Builder(
          builder: (ctx) => registry.buildSegment(
            ctx,
            const RawHtmlSegment(html: '<div>streaming...</div>', isClosed: false),
            const ContentRenderContext(
              messageId: 'm1',
              segmentIndex: 0,
              isStreaming: true,
              defaultHtmlPreview: true,
            ),
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('html_sandbox_stub')), findsNothing);
    expect(find.byKey(const Key('html_source_view')), findsOneWidget);

    await tester.pumpWidget(
      wrap(
        Builder(
          builder: (ctx) => registry.buildSegment(
            ctx,
            const CodeBlockSegment(
              language: 'html',
              code: '<div>Closed HTML</div>',
              isClosed: true,
            ),
            const ContentRenderContext(
              messageId: 'm1',
              segmentIndex: 1,
              isStreaming: false,
              defaultHtmlPreview: true,
            ),
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('html_sandbox_stub')), findsOneWidget);

    await tester.tap(find.byKey(const Key('html_toggle_mode_button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('html_sandbox_stub')), findsNothing);
    expect(find.byKey(const Key('html_source_view')), findsOneWidget);
  });

  testWidgets('CollapsibleBlockContainer respects line and char thresholds, manual toggle, and setting recalculation', (tester) async {
    final registry = createDefaultRendererRegistry();
    final longByLines = List.generate(30, (i) => 'line_$i').join('\n');
    final longByChars = 'const payload = "${'x' * 1300}";';
    const shortCode = 'print("short");';

    // Short block defaults expanded.
    await tester.pumpWidget(
      wrap(
        Builder(
          builder: (ctx) => registry.buildSegment(
            ctx,
            const CodeBlockSegment(language: 'dart', code: shortCode, isClosed: true),
            const ContentRenderContext(
              messageId: 'm2',
              segmentIndex: 0,
              isStreaming: false,
              autoCollapseEnabled: true,
              collapseLineThreshold: 24,
              collapseCharThreshold: 1200,
            ),
          ),
        ),
      ),
    );
    expect(find.textContaining('print("short");'), findsOneWidget);

    // Long by char threshold defaults collapsed.
    await tester.pumpWidget(
      wrap(
        Builder(
          builder: (ctx) => registry.buildSegment(
            ctx,
            CodeBlockSegment(language: 'js', code: longByChars, isClosed: true),
            const ContentRenderContext(
              messageId: 'm2',
              segmentIndex: 1,
              isStreaming: false,
              autoCollapseEnabled: true,
              collapseLineThreshold: 24,
              collapseCharThreshold: 1200,
            ),
          ),
        ),
      ),
    );
    expect(find.text('1 行 · ${longByChars.length} 字符'), findsOneWidget);

    // Long by line threshold collapses then expands manually, and remembers state across BlockExpansionScope.
    final memory = BlockExpansionMemory();
    await tester.pumpWidget(
      wrap(
        BlockExpansionScope(
          memory: memory,
          child: Builder(
            builder: (ctx) => registry.buildSegment(
              ctx,
              CodeBlockSegment(language: 'dart', code: longByLines, isClosed: true),
              const ContentRenderContext(
                messageId: 'm3',
                segmentIndex: 0,
                isStreaming: false,
                autoCollapseEnabled: true,
                collapseLineThreshold: 24,
                collapseCharThreshold: 1200,
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('line_29'), findsNothing);

    await tester.tap(find.byKey(const Key('collapse_toggle_m3:0')));
    await tester.pumpAndSettle();
    expect(find.textContaining('line_29'), findsOneWidget);

    // Changing threshold recalculates default collapsed state immediately.
    await tester.pumpWidget(
      wrap(
        BlockExpansionScope(
          memory: memory,
          child: Builder(
            builder: (ctx) => registry.buildSegment(
              ctx,
              CodeBlockSegment(language: 'dart', code: longByLines, isClosed: true),
              const ContentRenderContext(
                messageId: 'm3',
                segmentIndex: 0,
                isStreaming: false,
                autoCollapseEnabled: true,
                collapseLineThreshold: 10,
                collapseCharThreshold: 1200,
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('line_29'), findsNothing);

    // Disabling autoCollapseEnabled expands RawHtmlSegment immediately.
    await tester.pumpWidget(
      wrap(
        Builder(
          builder: (ctx) => registry.buildSegment(
            ctx,
            RawHtmlSegment(html: '<div>\n$longByLines\n</div>', isClosed: true),
            const ContentRenderContext(
              messageId: 'm4',
              segmentIndex: 0,
              isStreaming: false,
              autoCollapseEnabled: false,
              collapseLineThreshold: 24,
              collapseCharThreshold: 1200,
            ),
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('html_sandbox_stub')), findsOneWidget);
  });
}
