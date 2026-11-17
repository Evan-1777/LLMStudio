import 'package:flutter/material.dart';

import '../core/theme/md_tokens.dart';

/// Non-Web / VM test fallback view for HtmlSandboxView.
class HtmlSandboxView extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: const Key('html_sandbox_stub'),
      width: double.infinity,
      constraints: BoxConstraints(
        minHeight: minHeight,
        maxHeight: fillAvailable ? double.infinity : maxHeight,
      ),
      padding: const EdgeInsets.all(MdSpacing.md),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(MdRadii.sm),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: SingleChildScrollView(
        child: SelectableText(
          html,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
                height: 1.45,
              ),
        ),
      ),
    );
  }
}
