import 'package:flutter/widgets.dart';

import 'code_block_plugin.dart';
import 'content_renderer.dart';
import 'html_preview_plugin.dart';
import 'markdown_parser.dart';
import 'markdown_prose_widget.dart';

class MarkdownProsePlugin extends ContentRendererPlugin {
  @override
  String get id => 'markdown-prose';

  @override
  int get priority => 0;

  @override
  bool canRender(ContentSegment segment, ContentRenderContext renderContext) =>
      segment is MarkdownProseSegment;

  @override
  Widget build(
    BuildContext context,
    ContentSegment segment,
    ContentRenderContext renderContext,
  ) {
    final prose = segment as MarkdownProseSegment;
    return MarkdownProseWidget(markdown: prose.markdown);
  }
}

/// Creates a ContentRendererRegistry pre-populated with built-in plugins:
/// HtmlPreviewPlugin (priority 20), CodeBlockPlugin (priority 10), MarkdownProsePlugin (priority 0).
ContentRendererRegistry createDefaultRendererRegistry({
  List<ContentRendererPlugin> extraPlugins = const [],
}) {
  final registry = ContentRendererRegistry();
  registry.register(HtmlPreviewPlugin());
  registry.register(CodeBlockPlugin());
  registry.register(MarkdownProsePlugin());
  for (final plugin in extraPlugins) {
    registry.register(plugin);
  }
  return registry;
}
