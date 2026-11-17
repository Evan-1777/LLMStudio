/// Parsed segment types emitted by [parseAssistantContent].
sealed class ContentSegment {
  const ContentSegment();
}

final class MarkdownProseSegment extends ContentSegment {
  const MarkdownProseSegment(this.markdown);

  final String markdown;
}

final class CodeBlockSegment extends ContentSegment {
  const CodeBlockSegment({
    required this.language,
    required this.code,
    required this.isClosed,
  });

  final String language;
  final String code;
  final bool isClosed;
}

final class RawHtmlSegment extends ContentSegment {
  const RawHtmlSegment({
    required this.html,
    required this.isClosed,
  });

  final String html;
  final bool isClosed;
}

const Set<String> _rawHtmlBlockTags = {
  'html',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'table',
  'svg',
  'form',
  'style',
};

const Set<String> _voidHtmlTags = {
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
};

final RegExp _fenceStartPattern = RegExp(r'^\s{0,3}(`{3,}|~{3,})(.*)$');
final RegExp _doctypeStartPattern = RegExp(r'^\s*<!doctype\s+html\b', caseSensitive: false);
final RegExp _htmlOpenLinePattern = RegExp(
  r'^\s*<([a-zA-Z][a-zA-Z0-9]*)(?=[\s>/]|$)',
);
final RegExp _tagTokenPattern = RegExp(
  r'<(/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(/?)>',
);

/// Splits assistant Markdown output into prose, fenced code blocks, and standalone raw HTML blocks.
List<ContentSegment> parseAssistantContent(
  String input, {
  bool isStreaming = false,
}) {
  if (input.isEmpty) return const [];

  final normalized = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  final lines = normalized.split('\n');
  final segments = <ContentSegment>[];
  final proseLines = <String>[];

  void flushProse() {
    if (proseLines.isEmpty) return;
    final text = proseLines.join('\n');
    proseLines.clear();
    if (text.trim().isNotEmpty) {
      segments.add(MarkdownProseSegment(text));
    }
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];

    // 1. Fenced code block detection (``` or ~~~).
    final fenceMatch = _fenceStartPattern.firstMatch(line);
    if (fenceMatch != null) {
      final fence = fenceMatch.group(1)!;
      final fenceChar = fence[0];
      final fenceLen = fence.length;
      final info = fenceMatch.group(2)!.trim();
      final language =
          info.isEmpty ? '' : info.split(RegExp(r'\s+')).first.toLowerCase();

      // Backtick fences cannot contain backticks in the info string per CommonMark.
      if (!(fenceChar == '`' && info.contains('`'))) {
        flushProse();
        final codeLines = <String>[];
        var closed = false;
        var j = i + 1;
        while (j < lines.length) {
          final candidate = lines[j].trimLeft();
          if (candidate.startsWith(fenceChar * fenceLen)) {
            final rest = candidate.replaceFirst(RegExp('^\\$fenceChar+'), '');
            if (rest.trim().isEmpty) {
              closed = true;
              break;
            }
          }
          codeLines.add(lines[j]);
          j++;
        }
        segments.add(
          CodeBlockSegment(
            language: language,
            code: codeLines.join('\n'),
            isClosed: closed,
          ),
        );
        i = closed ? j + 1 : lines.length;
        continue;
      }
    }

    // 2. Conservative standalone raw HTML block detection.
    final rawStart = _matchHtmlBlockStart(line);
    if (rawStart != null) {
      final parsed = _consumeRawHtmlBlock(
        lines,
        i,
        rawStart,
        isStreaming: isStreaming,
      );
      if (parsed != null) {
        flushProse();
        segments.add(parsed.segment);
        i = parsed.nextIndex;
        continue;
      }
    }

    proseLines.add(line);
    i++;
  }

  flushProse();
  return segments;
}

String? _matchHtmlBlockStart(String line) {
  if (_doctypeStartPattern.hasMatch(line)) {
    return 'html';
  }
  final m = _htmlOpenLinePattern.firstMatch(line);
  if (m == null) return null;
  final tag = m.group(1)!.toLowerCase();
  if (!_rawHtmlBlockTags.contains(tag)) return null;
  return tag;
}

({RawHtmlSegment segment, int nextIndex})? _consumeRawHtmlBlock(
  List<String> lines,
  int startIndex,
  String rootTag, {
  required bool isStreaming,
}) {
  final htmlLines = <String>[];
  var depth = 0;
  var sawRootOpen = false;
  var j = startIndex;

  while (j < lines.length) {
    final line = lines[j];
    htmlLines.add(line);

    for (final m in _tagTokenPattern.allMatches(line)) {
      final isClose = m.group(1) == '/';
      final tag = m.group(2)!.toLowerCase();
      final isSelfClose = m.group(3) == '/' || _voidHtmlTags.contains(tag);

      if (tag == rootTag) {
        if (isClose) {
          depth--;
        } else if (!isSelfClose) {
          sawRootOpen = true;
          depth++;
        } else if (!sawRootOpen) {
          sawRootOpen = true;
        }
      }
    }

    if (sawRootOpen && depth <= 0) {
      return (
        segment: RawHtmlSegment(html: htmlLines.join('\n'), isClosed: true),
        nextIndex: j + 1,
      );
    }
    j++;
  }

  // Unclosed HTML block: keep during active streaming or multi-line HTML structure,
  // but avoid misclassifying single-line prose such as "<div> is an HTML tag".
  if (isStreaming || htmlLines.length > 1) {
    return (
      segment: RawHtmlSegment(html: htmlLines.join('\n'), isClosed: false),
      nextIndex: lines.length,
    );
  }
  return null;
}
