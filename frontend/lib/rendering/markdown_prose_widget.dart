import 'package:flutter/material.dart';

import '../core/theme/md_tokens.dart';

/// Renders a restricted Markdown prose subset (H1-H6, paragraphs, lists, quotes,
/// horizontal rules, pipe tables, and inline emphasis/code/links) compatible with SelectionArea.
class MarkdownProseWidget extends StatelessWidget {
  const MarkdownProseWidget({
    super.key,
    required this.markdown,
  });

  final String markdown;

  @override
  Widget build(BuildContext context) {
    final blocks = _parseProseBlocks(markdown);
    if (blocks.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < blocks.length; i++)
          Padding(
            padding: EdgeInsets.only(
              bottom: i == blocks.length - 1 ? 0 : MdSpacing.sm,
            ),
            child: _buildBlock(context, blocks[i]),
          ),
      ],
    );
  }

  Widget _buildBlock(BuildContext context, _MdBlock block) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final baseStyle = theme.textTheme.bodyLarge?.copyWith(
          color: scheme.onSurface,
          height: 1.55,
        ) ??
        TextStyle(color: scheme.onSurface, fontSize: 15, height: 1.55);

    switch (block) {
      case _HeadingBlock(:final level, :final text):
        final style = switch (level) {
          1 => theme.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700),
          2 => theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
          3 => theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
          4 => theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
          5 => theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
          _ => theme.textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
        } ?? baseStyle;
        return Padding(
          padding: const EdgeInsets.only(top: MdSpacing.xs),
          child: Text.rich(_buildInlineSpan(context, text, style)),
        );

      case _ParagraphBlock(:final text):
        return Text.rich(_buildInlineSpan(context, text, baseStyle));

      case _RuleBlock():
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: MdSpacing.xs),
          child: Divider(height: 1),
        );

      case _QuoteBlock(:final lines):
        final quoteStyle = baseStyle.copyWith(color: scheme.onSurfaceVariant);
        return Container(
          padding: const EdgeInsets.fromLTRB(
            MdSpacing.md,
            MdSpacing.xs,
            MdSpacing.sm,
            MdSpacing.xs,
          ),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: scheme.outline, width: 3),
            ),
          ),
          child: Text.rich(_buildInlineSpan(context, lines.join('\n'), quoteStyle)),
        );

      case _ListBlock(:final items):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final item in items)
              Padding(
                padding: EdgeInsets.only(
                  left: MdSpacing.sm + item.indent * 16.0,
                  bottom: MdSpacing.xs,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 24,
                      child: Text(
                        item.marker,
                        style: baseStyle.copyWith(
                          color: scheme.onSurfaceVariant,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text.rich(
                        _buildInlineSpan(context, item.text, baseStyle),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );

      case _TableBlock(:final headers, :final rows):
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Table(
            defaultColumnWidth: const IntrinsicColumnWidth(),
            border: TableBorder.all(
              color: scheme.outlineVariant,
              borderRadius: BorderRadius.circular(MdRadii.sm),
            ),
            children: [
              TableRow(
                decoration: BoxDecoration(color: scheme.surfaceContainerLow),
                children: [
                  for (final cell in headers)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: MdSpacing.md,
                        vertical: MdSpacing.sm,
                      ),
                      child: Text.rich(
                        _buildInlineSpan(
                          context,
                          cell,
                          baseStyle.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                    ),
                ],
              ),
              for (final row in rows)
                TableRow(
                  children: [
                    for (var c = 0; c < headers.length; c++)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: MdSpacing.md,
                          vertical: MdSpacing.sm,
                        ),
                        child: Text.rich(
                          _buildInlineSpan(
                            context,
                            c < row.length ? row[c] : '',
                            baseStyle,
                          ),
                        ),
                      ),
                  ],
                ),
            ],
          ),
        );
    }
  }

  TextSpan _buildInlineSpan(
    BuildContext context,
    String text,
    TextStyle baseStyle,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final pattern = RegExp(
      r'(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))',
    );

    final children = <InlineSpan>[];
    var last = 0;
    for (final m in pattern.allMatches(text)) {
      if (m.start > last) {
        children.add(TextSpan(text: text.substring(last, m.start)));
      }
      final token = m.group(0)!;
      if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
        children.add(
          TextSpan(
            text: ' ${token.substring(1, token.length - 1)} ',
            style: baseStyle.copyWith(
              fontFamily: 'monospace',
              fontSize: (baseStyle.fontSize ?? 15) * 0.9,
              backgroundColor: scheme.surfaceContainerHigh,
            ),
          ),
        );
      } else if ((token.startsWith('**') && token.endsWith('**')) ||
          (token.startsWith('__') && token.endsWith('__'))) {
        children.add(
          _buildInlineSpan(
            context,
            token.substring(2, token.length - 2),
            baseStyle.copyWith(fontWeight: FontWeight.w700),
          ),
        );
      } else if (token.startsWith('~~') && token.endsWith('~~')) {
        children.add(
          _buildInlineSpan(
            context,
            token.substring(2, token.length - 2),
            baseStyle.copyWith(decoration: TextDecoration.lineThrough),
          ),
        );
      } else if ((token.startsWith('*') && token.endsWith('*')) ||
          (token.startsWith('_') && token.endsWith('_'))) {
        children.add(
          _buildInlineSpan(
            context,
            token.substring(1, token.length - 1),
            baseStyle.copyWith(fontStyle: FontStyle.italic),
          ),
        );
      } else if (token.startsWith('[')) {
        final closeBracket = token.indexOf('](');
        if (closeBracket > 0) {
          final label = token.substring(1, closeBracket);
          children.add(
            TextSpan(
              text: label,
              style: baseStyle.copyWith(
                color: scheme.primary,
                decoration: TextDecoration.underline,
                decorationColor: scheme.primary,
              ),
            ),
          );
        } else {
          children.add(TextSpan(text: token));
        }
      }
      last = m.end;
    }
    if (last < text.length) {
      children.add(TextSpan(text: text.substring(last)));
    }
    return TextSpan(style: baseStyle, children: children);
  }
}

sealed class _MdBlock {
  const _MdBlock();
}

final class _HeadingBlock extends _MdBlock {
  const _HeadingBlock(this.level, this.text);

  final int level;
  final String text;
}

final class _ParagraphBlock extends _MdBlock {
  const _ParagraphBlock(this.text);

  final String text;
}

final class _RuleBlock extends _MdBlock {
  const _RuleBlock();
}

final class _QuoteBlock extends _MdBlock {
  const _QuoteBlock(this.lines);

  final List<String> lines;
}

final class _ListItem {
  const _ListItem({
    required this.indent,
    required this.marker,
    required this.text,
  });

  final int indent;
  final String marker;
  final String text;
}

final class _ListBlock extends _MdBlock {
  const _ListBlock(this.items);

  final List<_ListItem> items;
}

final class _TableBlock extends _MdBlock {
  const _TableBlock(this.headers, this.rows);

  final List<String> headers;
  final List<List<String>> rows;
}

final RegExp _headingRe = RegExp(r'^(#{1,6})\s+(.+)$');
final RegExp _ruleRe = RegExp(r'^(\s*)([-*_])(?:\s*\2){2,}\s*$');
final RegExp _ulRe = RegExp(r'^(\s*)[-*+]\s+(.+)$');
final RegExp _olRe = RegExp(r'^(\s*)(\d+\.)\s+(.+)$');
final RegExp _tableSepRe =
    RegExp(r'^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$');

List<_MdBlock> _parseProseBlocks(String markdown) {
  final lines = markdown.split('\n');
  final blocks = <_MdBlock>[];
  final paraLines = <String>[];

  void flushPara() {
    if (paraLines.isEmpty) return;
    final text = paraLines.join('\n').trim();
    paraLines.clear();
    if (text.isNotEmpty) {
      blocks.add(_ParagraphBlock(text));
    }
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    final trimmed = line.trim();

    if (trimmed.isEmpty) {
      flushPara();
      i++;
      continue;
    }

    final headingMatch = _headingRe.firstMatch(trimmed);
    if (headingMatch != null) {
      flushPara();
      blocks.add(
        _HeadingBlock(
          headingMatch.group(1)!.length,
          headingMatch.group(2)!.trim(),
        ),
      );
      i++;
      continue;
    }

    if (_ruleRe.hasMatch(trimmed)) {
      flushPara();
      blocks.add(const _RuleBlock());
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushPara();
      final quoteLines = <String>[];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.add(lines[i].trim().replaceFirst(RegExp(r'^>\s?'), ''));
        i++;
      }
      blocks.add(_QuoteBlock(quoteLines));
      continue;
    }

    if (i + 1 < lines.length &&
        line.contains('|') &&
        lines[i + 1].contains('|') &&
        _tableSepRe.hasMatch(lines[i + 1])) {
      flushPara();
      final headers = _splitTableRow(line);
      i += 2;
      final rows = <List<String>>[];
      while (i < lines.length && lines[i].contains('|') && lines[i].trim().isNotEmpty) {
        rows.add(_splitTableRow(lines[i]));
        i++;
      }
      blocks.add(_TableBlock(headers, rows));
      continue;
    }

    if (_ulRe.hasMatch(line) || _olRe.hasMatch(line)) {
      flushPara();
      final items = <_ListItem>[];
      while (i < lines.length) {
        final ul = _ulRe.firstMatch(lines[i]);
        if (ul != null) {
          items.add(
            _ListItem(
              indent: ul.group(1)!.length ~/ 2,
              marker: '•',
              text: ul.group(2)!,
            ),
          );
          i++;
          continue;
        }
        final ol = _olRe.firstMatch(lines[i]);
        if (ol != null) {
          items.add(
            _ListItem(
              indent: ol.group(1)!.length ~/ 2,
              marker: ol.group(2)!,
              text: ol.group(3)!,
            ),
          );
          i++;
          continue;
        }
        break;
      }
      blocks.add(_ListBlock(items));
      continue;
    }

    paraLines.add(line);
    i++;
  }

  flushPara();
  return blocks;
}

List<String> _splitTableRow(String row) {
  var trimmed = row.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.substring(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.substring(0, trimmed.length - 1);
  return trimmed.split('|').map((c) => c.trim()).toList();
}
