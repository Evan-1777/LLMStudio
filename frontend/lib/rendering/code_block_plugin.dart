import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/theme/app_icons.dart';
import 'collapsible_block_container.dart';
import 'content_renderer.dart';
import 'markdown_parser.dart';

class CodeBlockPlugin extends ContentRendererPlugin {
  @override
  String get id => 'code-block';

  @override
  int get priority => 10;

  @override
  bool canRender(ContentSegment segment, ContentRenderContext renderContext) =>
      segment is CodeBlockSegment;

  @override
  Widget build(
    BuildContext context,
    ContentSegment segment,
    ContentRenderContext renderContext,
  ) {
    final code = segment as CodeBlockSegment;
    return _CodeBlockCard(
      code: code.code,
      language: code.language,
      renderContext: renderContext,
    );
  }
}

class _CodeBlockCard extends StatefulWidget {
  const _CodeBlockCard({
    required this.code,
    required this.language,
    required this.renderContext,
  });

  final String code;
  final String language;
  final ContentRenderContext renderContext;

  @override
  State<_CodeBlockCard> createState() => _CodeBlockCardState();
}

class _CodeBlockCardState extends State<_CodeBlockCard> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    await Future<void>.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _copied = false);
  }

  @override
  Widget build(BuildContext context) {
    final badge =
        widget.language.isEmpty ? 'CODE' : widget.language.toUpperCase();

    return CollapsibleBlockContainer(
      memoryKey: widget.renderContext.memoryKey,
      badge: badge,
      rawContent: widget.code,
      autoCollapseEnabled: widget.renderContext.autoCollapseEnabled,
      lineThreshold: widget.renderContext.collapseLineThreshold,
      charThreshold: widget.renderContext.collapseCharThreshold,
      actions: [
        AppIconAction(
          svg: _copied ? AppIcons.check : AppIcons.copy,
          size: 16,
          tooltip: '复制代码',
          padding: const EdgeInsets.all(4),
          constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          onPressed: _copy,
        ),
      ],
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Text(
          widget.code,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
                height: 1.5,
              ),
        ),
      ),
    );
  }
}
