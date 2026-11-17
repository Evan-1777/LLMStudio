import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:llmstudio_frontend/core/theme/app_theme.dart';
import 'package:llmstudio_frontend/rendering/builtin_plugins.dart';
import 'package:llmstudio_frontend/rendering/content_renderer.dart';
import 'package:llmstudio_frontend/rendering/markdown_parser.dart';

void main() {
  test('parseAssistantContent segments prose, fenced code blocks, and standalone raw HTML structures', () {
    const input = '''
# Overview

Inline `<div>not-raw</div>` and prose mentioning <script> or <div> stays prose.

```html
<div class="box">Fenced HTML</div>
```

~~~python
print("tilde fence")
~~~

<!DOCTYPE html>
<html>
  <body><p>Full doc</p></body>
</html>

<svg width="24" height="24">
  <circle cx="12" cy="12" r="10"/>
</svg>

<table>
  <tr><td>Cell</td></tr>
</table>

<form action="/submit"><input type="text"/></form>

<style>.card { color: red; }</style>

Closing paragraph.
''';

    final segments = parseAssistantContent(input);
    expect(segments.whereType<RawHtmlSegment>().length, 5);
    expect(segments.whereType<CodeBlockSegment>().length, 2);
    expect(segments.whereType<MarkdownProseSegment>().length, 2);

    final codeBlocks = segments.whereType<CodeBlockSegment>().toList();
    expect(codeBlocks[0].language, 'html');
    expect(codeBlocks[0].isClosed, isTrue);
    expect(codeBlocks[1].language, 'python');
    expect(codeBlocks[1].isClosed, isTrue);

    final rawHtmls = segments.whereType<RawHtmlSegment>().toList();
    expect(rawHtmls.every((s) => s.isClosed), isTrue);
    expect(rawHtmls[0].html, contains('<!DOCTYPE html>'));
    expect(rawHtmls[1].html, contains('<svg'));
    expect(rawHtmls[2].html, contains('<table>'));
    expect(rawHtmls[3].html, contains('<form'));
    expect(rawHtmls[4].html, contains('<style>'));
  });

  test('parseAssistantContent maintains stable unclosed segments during streaming and ignores single-line prose tags', () {
    const streamingFence = '''
Intro text

```dart
void main() {
''';
    final fenceSegs = parseAssistantContent(streamingFence, isStreaming: true);
    expect(fenceSegs, hasLength(2));
    expect((fenceSegs[1] as CodeBlockSegment).isClosed, isFalse);

    const streamingHtml = '<section>\n  <h1>Streaming';
    final htmlSegs = parseAssistantContent(streamingHtml, isStreaming: true);
    expect(htmlSegs, hasLength(1));
    expect((htmlSegs[0] as RawHtmlSegment).isClosed, isFalse);

    const proseLine = '<div> is a generic container element in HTML.';
    final proseSegs = parseAssistantContent(proseLine, isStreaming: false);
    expect(proseSegs, hasLength(1));
    expect(proseSegs[0], isA<MarkdownProseSegment>());
  });

  testWidgets('MarkdownProsePlugin renders H1-H6, lists, quotes, rules, pipe tables, and inline formatting', (tester) async {
    final registry = createDefaultRendererRegistry();
    const md = '''
# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Paragraph with **bold**, *italic*, ~~strike~~, `inlineCode`, and [docs](https://example.com).

- Bullet A
  - Nested Bullet B
1. First Step
2. Second Step

> Quoted guidance

---

| Key | Val |
| --- | --- |
| Alpha | 100 |
''';

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.build(brightness: Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            child: SelectionArea(
              child: Builder(
                builder: (ctx) => registry.buildSegment(
                  ctx,
                  const MarkdownProseSegment(md),
                  const ContentRenderContext(
                    messageId: 'm1',
                    segmentIndex: 0,
                    isStreaming: false,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Heading 1'), findsOneWidget);
    expect(find.textContaining('Heading 6'), findsOneWidget);
    expect(find.textContaining('Bullet A'), findsOneWidget);
    expect(find.textContaining('First Step'), findsOneWidget);
    expect(find.textContaining('Quoted guidance'), findsOneWidget);
    expect(find.text('Alpha'), findsOneWidget);
    expect(find.text('100'), findsOneWidget);
  });
}
