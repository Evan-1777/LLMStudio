import 'package:flutter/material.dart';

import '../core/theme/app_icons.dart';
import '../core/theme/md_tokens.dart';

/// Stores per-block manual expand/collapse state across ListView item recycling.
class BlockExpansionMemory {
  final Map<String, bool> _overrides = {};

  bool? get(String key) => _overrides[key];

  void set(String key, bool expanded) {
    _overrides[key] = expanded;
  }

  void clear(String key) {
    _overrides.remove(key);
  }
}

class BlockExpansionScope extends InheritedWidget {
  const BlockExpansionScope({
    super.key,
    required this.memory,
    required super.child,
  });

  final BlockExpansionMemory memory;

  static BlockExpansionMemory? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<BlockExpansionScope>()
        ?.memory;
  }

  @override
  bool updateShouldNotify(covariant BlockExpansionScope oldWidget) =>
      !identical(memory, oldWidget.memory);
}

/// Shared collapsible surface for both raw/fenced HTML blocks and fenced code blocks.
class CollapsibleBlockContainer extends StatefulWidget {
  const CollapsibleBlockContainer({
    super.key,
    required this.memoryKey,
    required this.badge,
    required this.rawContent,
    required this.autoCollapseEnabled,
    required this.lineThreshold,
    required this.charThreshold,
    required this.actions,
    required this.child,
  });

  final String memoryKey;
  final String badge;
  final String rawContent;
  final bool autoCollapseEnabled;
  final int lineThreshold;
  final int charThreshold;
  final List<Widget> actions;
  final Widget child;

  @override
  State<CollapsibleBlockContainer> createState() =>
      _CollapsibleBlockContainerState();
}

class _CollapsibleBlockContainerState extends State<CollapsibleBlockContainer> {
  bool? _localOverride;

  int get _lineCount =>
      widget.rawContent.isEmpty ? 0 : widget.rawContent.split('\n').length;

  int get _charCount => widget.rawContent.length;

  bool get _exceedsThreshold =>
      widget.autoCollapseEnabled &&
      (_lineCount > widget.lineThreshold || _charCount > widget.charThreshold);

  @override
  void didUpdateWidget(covariant CollapsibleBlockContainer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.autoCollapseEnabled != widget.autoCollapseEnabled ||
        oldWidget.lineThreshold != widget.lineThreshold ||
        oldWidget.charThreshold != widget.charThreshold) {
      _localOverride = null;
      BlockExpansionScope.maybeOf(context)?.clear(widget.memoryKey);
    }
  }

  void _toggle(BlockExpansionMemory? memory, bool currentExpanded) {
    final next = !currentExpanded;
    memory?.set(widget.memoryKey, next);
    setState(() => _localOverride = next);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final memory = BlockExpansionScope.maybeOf(context);
    final manual = memory?.get(widget.memoryKey) ?? _localOverride;
    final isExpanded = manual ?? !_exceedsThreshold;

    final previewLines = widget.rawContent.split('\n').take(6).join('\n');

    return Container(
      margin: const EdgeInsets.symmetric(vertical: MdSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: MdSpacing.md,
              vertical: 6,
            ),
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: isExpanded || _exceedsThreshold
                  ? const BorderRadius.vertical(top: Radius.circular(MdRadii.md))
                  : BorderRadius.circular(MdRadii.md),
            ),
            child: Row(
              children: [
                Text(
                  widget.badge,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: scheme.onSurface,
                      ),
                ),
                const SizedBox(width: MdSpacing.sm),
                Expanded(
                  child: Text(
                    '$_lineCount 行 · $_charCount 字符',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                  ),
                ),
                ...widget.actions,
                AppIconAction(
                  key: Key('collapse_toggle_${widget.memoryKey}'),
                  svg: isExpanded ? AppIcons.chevronUp : AppIcons.chevronDown,
                  size: 16,
                  tooltip: isExpanded ? '收起' : '展开',
                  padding: const EdgeInsets.all(4),
                  constraints:
                      const BoxConstraints(minWidth: 30, minHeight: 30),
                  onPressed: () => _toggle(memory, isExpanded),
                ),
              ],
            ),
          ),
          if (isExpanded)
            Padding(
              padding: const EdgeInsets.all(MdSpacing.md),
              child: widget.child,
            )
          else
            InkWell(
              onTap: () => _toggle(memory, isExpanded),
              borderRadius: const BorderRadius.vertical(
                bottom: Radius.circular(MdRadii.md),
              ),
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(
                  bottom: Radius.circular(MdRadii.md),
                ),
                child: Stack(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        MdSpacing.md,
                        MdSpacing.sm,
                        MdSpacing.md,
                        MdSpacing.md,
                      ),
                      child: Text(
                        previewLines,
                        maxLines: 6,
                        overflow: TextOverflow.clip,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              fontFamily: 'monospace',
                              color: scheme.onSurfaceVariant,
                              height: 1.45,
                            ),
                      ),
                    ),
                    Positioned.fill(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              scheme.surfaceContainerLow.withValues(alpha: 0),
                              scheme.surfaceContainerLow.withValues(alpha: 0.92),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
