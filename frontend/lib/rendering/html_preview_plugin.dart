import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/theme/app_icons.dart';
import '../core/theme/md_tokens.dart';
import 'collapsible_block_container.dart';
import 'content_renderer.dart';
import 'html_sandbox_adapter.dart';
import 'markdown_parser.dart';

class HtmlPreviewPlugin extends ContentRendererPlugin {
  @override
  String get id => 'html-preview';

  @override
  int get priority => 20;

  @override
  bool canRender(ContentSegment segment, ContentRenderContext renderContext) {
    if (segment is RawHtmlSegment) return true;
    if (segment is CodeBlockSegment) {
      final lang = segment.language.toLowerCase();
      return lang == 'html' || lang == 'htm';
    }
    return false;
  }

  @override
  Widget build(
    BuildContext context,
    ContentSegment segment,
    ContentRenderContext renderContext,
  ) {
    final String html;
    final bool isClosed;
    final String badge;
    if (segment is RawHtmlSegment) {
      html = segment.html;
      isClosed = segment.isClosed;
      badge = 'HTML';
    } else {
      final code = segment as CodeBlockSegment;
      html = code.code;
      isClosed = code.isClosed;
      badge = code.language.isEmpty ? 'HTML' : code.language.toUpperCase();
    }

    return _HtmlPreviewCard(
      html: html,
      isClosed: isClosed,
      badge: badge,
      renderContext: renderContext,
    );
  }
}

class _HtmlPreviewCard extends StatefulWidget {
  const _HtmlPreviewCard({
    required this.html,
    required this.isClosed,
    required this.badge,
    required this.renderContext,
  });

  final String html;
  final bool isClosed;
  final String badge;
  final ContentRenderContext renderContext;

  @override
  State<_HtmlPreviewCard> createState() => _HtmlPreviewCardState();
}

class _HtmlPreviewCardState extends State<_HtmlPreviewCard> {
  late bool _showPreview = widget.renderContext.defaultHtmlPreview;
  bool _copied = false;

  @override
  void didUpdateWidget(covariant _HtmlPreviewCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.renderContext.defaultHtmlPreview !=
        widget.renderContext.defaultHtmlPreview) {
      _showPreview = widget.renderContext.defaultHtmlPreview;
    }
  }

  Future<void> _copySource() async {
    await Clipboard.setData(ClipboardData(text: widget.html));
    if (!mounted) return;
    setState(() => _copied = true);
    await Future<void>.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _copied = false);
  }

  void _openFullscreen(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (ctx) => Dialog.fullscreen(
        child: Scaffold(
          appBar: AppBar(
            title: Text(widget.badge),
            leading: AppIconAction(
              svg: AppIcons.close,
              tooltip: '关闭',
              onPressed: () => Navigator.of(ctx).pop(),
            ),
          ),
          body: Padding(
            padding: const EdgeInsets.all(MdSpacing.md),
            child: HtmlSandboxView(
              html: widget.html,
              fillAvailable: true,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final canMountSandbox = widget.isClosed && _showPreview;
    final body = canMountSandbox
        ? HtmlSandboxView(html: widget.html)
        : Text(
            widget.html,
            key: const Key('html_source_view'),
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  height: 1.45,
                ),
          );

    return CollapsibleBlockContainer(
      memoryKey: widget.renderContext.memoryKey,
      badge: widget.badge,
      rawContent: widget.html,
      autoCollapseEnabled: widget.renderContext.autoCollapseEnabled,
      lineThreshold: widget.renderContext.collapseLineThreshold,
      charThreshold: widget.renderContext.collapseCharThreshold,
      actions: [
        if (widget.isClosed)
          AppIconAction(
            key: const Key('html_toggle_mode_button'),
            svg: _showPreview ? AppIcons.code : AppIcons.preview,
            size: 16,
            tooltip: _showPreview ? '查看源码' : '预览渲染',
            padding: const EdgeInsets.all(4),
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => setState(() => _showPreview = !_showPreview),
          ),
        AppIconAction(
          key: const Key('html_copy_button'),
          svg: _copied ? AppIcons.check : AppIcons.copy,
          size: 16,
          tooltip: '复制源码',
          padding: const EdgeInsets.all(4),
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: _copySource,
        ),
        if (widget.isClosed)
          AppIconAction(
            key: const Key('html_fullscreen_button'),
            svg: AppIcons.expand,
            size: 16,
            tooltip: '全屏预览',
            padding: const EdgeInsets.all(4),
            constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            onPressed: () => _openFullscreen(context),
          ),
      ],
      child: body,
    );
  }
}
