import 'package:flutter/widgets.dart';

import 'markdown_parser.dart';

/// Shared rendering configuration passed to registered ContentRendererPlugins.
class ContentRenderContext {
  const ContentRenderContext({
    required this.messageId,
    required this.segmentIndex,
    required this.isStreaming,
    this.defaultHtmlPreview = true,
    this.autoCollapseEnabled = true,
    this.collapseLineThreshold = 24,
    this.collapseCharThreshold = 1200,
  });

  final String messageId;
  final int segmentIndex;
  final bool isStreaming;
  final bool defaultHtmlPreview;
  final bool autoCollapseEnabled;
  final int collapseLineThreshold;
  final int collapseCharThreshold;

  String get memoryKey => '$messageId:$segmentIndex';
}

/// Extension point for rendering parsed assistant content segments.
abstract class ContentRendererPlugin {
  String get id;

  int get priority => 0;

  bool canRender(ContentSegment segment, ContentRenderContext renderContext);

  Widget build(
    BuildContext context,
    ContentSegment segment,
    ContentRenderContext renderContext,
  );
}

/// Priority-ordered registry dispatching segments to matching plugins.
class ContentRendererRegistry {
  final List<ContentRendererPlugin> _plugins = [];

  List<ContentRendererPlugin> get plugins => List.unmodifiable(_plugins);

  void register(ContentRendererPlugin plugin) {
    _plugins.removeWhere((p) => p.id == plugin.id);
    _plugins.add(plugin);
    _plugins.sort((a, b) => b.priority.compareTo(a.priority));
  }

  ContentRendererPlugin? match(
    ContentSegment segment,
    ContentRenderContext renderContext,
  ) {
    for (final plugin in _plugins) {
      if (plugin.canRender(segment, renderContext)) {
        return plugin;
      }
    }
    return null;
  }

  Widget buildSegment(
    BuildContext context,
    ContentSegment segment,
    ContentRenderContext renderContext,
  ) {
    final plugin = match(segment, renderContext);
    if (plugin != null) {
      return plugin.build(context, segment, renderContext);
    }
    return const SizedBox.shrink();
  }
}
