import 'dart:async';
import 'dart:js_interop';
import 'dart:math';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../core/theme/md_tokens.dart';

@JS('Object.is')
external bool _jsObjectIs(JSAny? a, JSAny? b);

/// Isolated Web iframe adapter for rendering untrusted assistant HTML safely.
class HtmlSandboxView extends StatefulWidget {
  const HtmlSandboxView({
    super.key,
    required this.html,
    this.minHeight = 120,
    this.maxHeight = 680,
    this.fillAvailable = false,
  });

  final String html;
  final double minHeight;
  final double maxHeight;
  final bool fillAvailable;

  @override
  State<HtmlSandboxView> createState() => _HtmlSandboxViewState();
}

class _HtmlSandboxViewState extends State<HtmlSandboxView> {
  static int _viewCounter = 0;

  late final String _viewType;
  late final String _nonce;
  web.HTMLIFrameElement? _iframe;
  StreamSubscription<web.MessageEvent>? _messageSub;
  late double _height;

  @override
  void initState() {
    super.initState();
    _viewCounter++;
    _viewType = 'llmstudio-html-sandbox-$_viewCounter';
    _nonce = _generateNonce();
    _height = min(widget.minHeight, widget.maxHeight);

    final iframe = web.HTMLIFrameElement()
      ..style.border = 'none'
      ..style.width = '100%'
      ..style.height = '100%'
      ..style.display = 'block'
      ..style.backgroundColor = 'transparent';
    // Explicitly omit allow-same-origin so iframe executes in an opaque isolated origin.
    iframe.sandbox.add('allow-scripts');
    iframe.srcdoc = _buildSrcDoc(widget.html, _nonce).toJS;
    _iframe = iframe;

    ui_web.platformViewRegistry.registerViewFactory(
      _viewType,
      (int viewId) => iframe,
    );

    _messageSub = web.window.onMessage.listen(_handleWindowMessage);
  }

  @override
  void didUpdateWidget(covariant HtmlSandboxView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html && _iframe != null) {
      _iframe!.srcdoc = _buildSrcDoc(widget.html, _nonce).toJS;
    }
  }

  @override
  void dispose() {
    _messageSub?.cancel();
    _messageSub = null;
    _iframe = null;
    super.dispose();
  }

  void _handleWindowMessage(web.MessageEvent event) {
    final iframeWin = _iframe?.contentWindow;
    if (iframeWin == null) return;
    if (!_jsObjectIs(event.source, iframeWin)) return;

    final raw = event.data?.dartify();
    if (raw is! Map) return;
    if (raw['type'] != 'llmstudio-html-height') return;
    if (raw['nonce'] != _nonce) return;

    final reported = raw['height'];
    if (reported is num && reported > 0) {
      final clamped = reported.toDouble().clamp(widget.minHeight, widget.maxHeight);
      if ((clamped - _height).abs() >= 1 && mounted) {
        setState(() => _height = clamped);
      }
    }
  }

  static String _generateNonce() {
    final rng = Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  static String _buildSrcDoc(String rawHtml, String nonce) {
    final bridgeScript = '''
<script>
(function() {
  var nonce = "$nonce";
  function postHeight() {
    try {
      var docEl = document.documentElement;
      var body = document.body;
      var h = Math.max(
        docEl ? docEl.scrollHeight : 0,
        body ? body.scrollHeight : 0
      );
      window.parent.postMessage({
        type: "llmstudio-html-height",
        nonce: nonce,
        height: h
      }, "*");
    } catch (_) {}
  }
  window.addEventListener("load", postHeight);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(postHeight).observe(document.documentElement);
  }
  setTimeout(postHeight, 40);
})();
</script>
''';

    final lower = rawHtml.toLowerCase();
    final hasDocumentRoot =
        lower.contains('<!doctype') || lower.contains('<html');
    if (hasDocumentRoot) {
      final bodyCloseIdx = lower.lastIndexOf('</body>');
      if (bodyCloseIdx >= 0) {
        return rawHtml.substring(0, bodyCloseIdx) +
            bridgeScript +
            rawHtml.substring(bodyCloseIdx);
      }
      return '$rawHtml\n$bridgeScript';
    }

    return '''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body {
    margin: 0;
    padding: 10px;
    box-sizing: border-box;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
</style>
</head>
<body>
$rawHtml
$bridgeScript
</body>
</html>''';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final view = ClipRRect(
      borderRadius: BorderRadius.circular(MdRadii.sm),
      child: Container(
        color: Colors.white,
        child: HtmlElementView(viewType: _viewType),
      ),
    );

    if (widget.fillAvailable) {
      return Container(
        decoration: BoxDecoration(
          border: Border.all(color: scheme.outlineVariant),
          borderRadius: BorderRadius.circular(MdRadii.sm),
        ),
        child: view,
      );
    }

    return AnimatedContainer(
      duration: MdMotion.standardDecelerateDuration,
      curve: MdMotion.standardDecelerateCurve,
      height: _height,
      decoration: BoxDecoration(
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(MdRadii.sm),
      ),
      child: view,
    );
  }
}
