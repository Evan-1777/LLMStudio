import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/models/content_block.dart';
import '../../core/models/message.dart';
import '../../core/state/chat_controller.dart';
import '../../core/state/providers_controller.dart';
import '../../core/state/settings_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';
import '../../rendering/builtin_plugins.dart';
import '../../rendering/collapsible_block_container.dart';
import '../../rendering/content_renderer.dart';
import '../../rendering/markdown_parser.dart';

typedef AssistantTextBuilder = Widget Function(
  BuildContext context,
  String messageId,
  String text,
  bool isStreaming,
);

class ChatCanvas extends StatefulWidget {
  const ChatCanvas({
    super.key,
    required this.onRetry,
    required this.onRegenerate,
    this.onOpenSettings,
    this.assistantTextBuilder,
  });

  final VoidCallback onRetry;
  final ValueChanged<String> onRegenerate;
  final VoidCallback? onOpenSettings;
  final AssistantTextBuilder? assistantTextBuilder;

  @override
  State<ChatCanvas> createState() => _ChatCanvasState();
}

class _ChatCanvasState extends State<ChatCanvas> {
  final ScrollController _scrollCtrl = ScrollController();
  final BlockExpansionMemory _expansionMemory = BlockExpansionMemory();
  final ContentRendererRegistry _rendererRegistry =
      createDefaultRendererRegistry();
  bool _autoFollow = true;
  bool _showScrollToBottom = false;

  @override
  void dispose() {
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _scrollToBottom({bool animated = true}) {
    if (!_scrollCtrl.hasClients) return;
    final target = _scrollCtrl.position.maxScrollExtent;
    if (animated) {
      _scrollCtrl.animateTo(
        target,
        duration: MdMotion.standardDecelerateDuration,
        curve: MdMotion.standardDecelerateCurve,
      );
    } else {
      _scrollCtrl.jumpTo(target);
    }
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (!_scrollCtrl.hasClients) return false;
    final metrics = notification.metrics;
    final distanceFromBottom = metrics.maxScrollExtent - metrics.pixels;

    if (notification is UserScrollNotification && distanceFromBottom > 48) {
      if (_autoFollow || !_showScrollToBottom) {
        setState(() {
          _autoFollow = false;
          _showScrollToBottom = true;
        });
      }
    } else if (distanceFromBottom <= 24) {
      if (!_autoFollow || _showScrollToBottom) {
        setState(() {
          _autoFollow = true;
          _showScrollToBottom = false;
        });
      }
    } else if (!_autoFollow && !_showScrollToBottom) {
      setState(() => _showScrollToBottom = true);
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final chatCtrl = context.watch<ChatController>();
    final providersCtrl = context.watch<ProvidersController>();
    final runState = chatCtrl.runState;
    final messages = chatCtrl.messages;

    if (_autoFollow &&
        (runState == ChatRunState.streaming ||
            runState == ChatRunState.loading)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _autoFollow) {
          _scrollToBottom(animated: false);
        }
      });
    }

    if (runState == ChatRunState.loading && messages.isEmpty) {
      return const Column(
        children: [
          LinearProgressIndicator(minHeight: 2),
          Expanded(child: SizedBox.shrink()),
        ],
      );
    }

    if (messages.isEmpty && runState != ChatRunState.error) {
      if (!providersCtrl.hasUsableModel && widget.onOpenSettings != null) {
        return Center(
          child: FilledButton.tonalIcon(
            onPressed: widget.onOpenSettings,
            icon: AppSvgIcon(
              AppIcons.settings,
              size: 18,
              color: scheme.onSecondaryContainer,
            ),
            label: const Text('配置供应商'),
          ),
        );
      }
      return const SizedBox.expand();
    }

    return BlockExpansionScope(
      memory: _expansionMemory,
      child: Stack(
        children: [
          NotificationListener<ScrollNotification>(
            onNotification: _handleScrollNotification,
            child: SelectionArea(
              child: ListView.builder(
                controller: _scrollCtrl,
                padding: const EdgeInsets.symmetric(
                  horizontal: MdSpacing.lg,
                  vertical: MdSpacing.lg,
                ),
                itemCount: messages.length + 1,
                itemBuilder: (context, index) {
                  if (index == messages.length) {
                    return _StatusFooter(
                      runState: runState,
                      errorMessage: chatCtrl.errorMessage,
                      onRetry: widget.onRetry,
                    );
                  }
                  final msg = messages[index];
                  final isLast = index == messages.length - 1;
                  final isStreamingMsg =
                      isLast && runState == ChatRunState.streaming;
                  return _MessageRow(
                    message: msg,
                    isStreaming: isStreamingMsg,
                    rendererRegistry: _rendererRegistry,
                    onRegenerate:
                        msg.role == 'assistant' && !msg.id.startsWith('local-')
                            ? () => widget.onRegenerate(msg.id)
                            : null,
                    assistantTextBuilder: widget.assistantTextBuilder,
                  );
                },
              ),
            ),
          ),
          if (_showScrollToBottom)
            Positioned(
              right: MdSpacing.lg,
              bottom: MdSpacing.md,
              child: AppIconAction(
                svg: AppIcons.arrowDown,
                tooltip: '回到底部',
                backgroundColor: scheme.surfaceContainerHigh,
                color: scheme.onSurface,
                onPressed: () {
                  setState(() {
                    _autoFollow = true;
                    _showScrollToBottom = false;
                  });
                  _scrollToBottom(animated: true);
                },
              ),
            ),
        ],
      ),
    );
  }
}

class _StatusFooter extends StatelessWidget {
  const _StatusFooter({
    required this.runState,
    required this.errorMessage,
    required this.onRetry,
  });

  final ChatRunState runState;
  final String? errorMessage;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (runState == ChatRunState.loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: MdSpacing.md),
        child: LinearProgressIndicator(minHeight: 2),
      );
    }
    if (runState == ChatRunState.error) {
      return Container(
        margin: const EdgeInsets.only(top: MdSpacing.md),
        padding: const EdgeInsets.symmetric(
          horizontal: MdSpacing.md,
          vertical: MdSpacing.sm,
        ),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: BorderRadius.circular(MdRadii.md),
        ),
        child: Row(
          children: [
            AppSvgIcon(
              AppIcons.warning,
              size: 18,
              color: scheme.onErrorContainer,
            ),
            const SizedBox(width: MdSpacing.sm),
            Expanded(
              child: Text(
                errorMessage?.isNotEmpty == true ? errorMessage! : '请求失败',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: scheme.onErrorContainer,
                    ),
              ),
            ),
            AppIconAction(
              key: const Key('chat_retry_button'),
              svg: AppIcons.refresh,
              tooltip: '重试',
              color: scheme.onErrorContainer,
              onPressed: onRetry,
            ),
          ],
        ),
      );
    }
    return const SizedBox(height: MdSpacing.md);
  }
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.message,
    required this.isStreaming,
    required this.rendererRegistry,
    this.onRegenerate,
    this.assistantTextBuilder,
  });

  final Message message;
  final bool isStreaming;
  final ContentRendererRegistry rendererRegistry;
  final VoidCallback? onRegenerate;
  final AssistantTextBuilder? assistantTextBuilder;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isUser = message.role == 'user';

    if (isUser) {
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 620),
          margin: const EdgeInsets.only(bottom: MdSpacing.lg),
          padding: const EdgeInsets.symmetric(
            horizontal: MdSpacing.lg,
            vertical: MdSpacing.md,
          ),
          decoration: BoxDecoration(
            color: scheme.secondaryContainer,
            borderRadius: BorderRadius.circular(MdRadii.lg),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final block in message.blocks) _buildBlock(context, block),
            ],
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: MdSpacing.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final block in message.blocks) _buildBlock(context, block),
          if (!isStreaming)
            Padding(
              padding: const EdgeInsets.only(top: MdSpacing.xs),
              child: Row(
                children: [
                  _CopyMessageAction(text: message.plainText),
                  if (onRegenerate != null)
                    AppIconAction(
                      svg: AppIcons.refresh,
                      size: 16,
                      tooltip: '重新生成',
                      onPressed: onRegenerate,
                    ),
                  if (message.stopReason == 'aborted')
                    Container(
                      margin: const EdgeInsets.only(left: MdSpacing.sm),
                      padding: const EdgeInsets.symmetric(
                        horizontal: MdSpacing.sm,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: scheme.surfaceContainerHigh,
                        borderRadius: BorderRadius.circular(MdRadii.full),
                      ),
                      child: Text(
                        '已终止',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: scheme.onSurfaceVariant,
                            ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildBlock(BuildContext context, ContentBlock block) {
    final scheme = Theme.of(context).colorScheme;
    switch (block) {
      case TextBlock(:final text):
        if (message.role == 'assistant') {
          if (assistantTextBuilder != null) {
            return assistantTextBuilder!(context, message.id, text, isStreaming);
          }
          final settings = context.watch<SettingsController>().settings;
          final segments = parseAssistantContent(text, isStreaming: isStreaming);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < segments.length; i++)
                rendererRegistry.buildSegment(
                  context,
                  segments[i],
                  ContentRenderContext(
                    messageId: message.id,
                    segmentIndex: i,
                    isStreaming: isStreaming,
                    defaultHtmlPreview: settings.defaultHtmlPreview,
                    autoCollapseEnabled: settings.autoCollapseEnabled,
                    collapseLineThreshold: settings.collapseLineThreshold,
                    collapseCharThreshold: settings.collapseCharThreshold,
                  ),
                ),
            ],
          );
        }
        return Text(
          text,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(height: 1.55),
        );
      case ThinkingBlock(:final thinking):
        return _ThinkingAccordion(
          thinking: thinking,
          initiallyExpanded: isStreaming,
        );
      case ImageBlock(:final url):
        return Padding(
          padding: const EdgeInsets.only(top: MdSpacing.sm),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppSvgIcon(
                AppIcons.image,
                size: 16,
                color: scheme.onSurfaceVariant,
              ),
              const SizedBox(width: MdSpacing.xs),
              Flexible(
                child: Text(
                  url.isNotEmpty ? url : 'Image',
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        );
      case ToolCallBlock(:final name):
        return _CompactBlockChip(
          svg: AppIcons.wrench,
          label: name.isNotEmpty ? name : 'toolCall',
        );
      case ToolResultBlock(:final toolName, :final isError):
        return _CompactBlockChip(
          svg: isError ? AppIcons.warning : AppIcons.check,
          label: toolName.isNotEmpty ? toolName : 'toolResult',
        );
      case ExtensionBlock(:final type):
        return _CompactBlockChip(
          svg: AppIcons.code,
          label: type,
        );
    }
  }
}

class _ThinkingAccordion extends StatefulWidget {
  const _ThinkingAccordion({
    required this.thinking,
    this.initiallyExpanded = false,
  });

  final String thinking;
  final bool initiallyExpanded;

  @override
  State<_ThinkingAccordion> createState() => _ThinkingAccordionState();
}

class _ThinkingAccordionState extends State<_ThinkingAccordion> {
  late bool _expanded = widget.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: MdSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(MdRadii.md),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: MdSpacing.md,
                vertical: MdSpacing.sm,
              ),
              child: Row(
                children: [
                  AppSvgIcon(
                    AppIcons.cpu,
                    size: 14,
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: MdSpacing.sm),
                  Text(
                    '思考过程',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                  ),
                  const Spacer(),
                  AppSvgIcon(
                    _expanded ? AppIcons.chevronUp : AppIcons.chevronDown,
                    size: 16,
                    color: scheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                MdSpacing.md,
                0,
                MdSpacing.md,
                MdSpacing.md,
              ),
              child: SelectableText(
                widget.thinking,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      height: 1.5,
                    ),
              ),
            ),
        ],
      ),
    );
  }
}

class _CompactBlockChip extends StatelessWidget {
  const _CompactBlockChip({
    required this.svg,
    required this.label,
  });

  final String svg;
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: MdSpacing.xs),
      padding: const EdgeInsets.symmetric(
        horizontal: MdSpacing.sm,
        vertical: MdSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(MdRadii.sm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppSvgIcon(svg, size: 14, color: scheme.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
          ),
        ],
      ),
    );
  }
}

class _CopyMessageAction extends StatefulWidget {
  const _CopyMessageAction({required this.text});

  final String text;

  @override
  State<_CopyMessageAction> createState() => _CopyMessageActionState();
}

class _CopyMessageActionState extends State<_CopyMessageAction> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    return AppIconAction(
      svg: _copied ? AppIcons.check : AppIcons.copy,
      size: 16,
      tooltip: '复制',
      onPressed: widget.text.isEmpty
          ? null
          : () async {
              await Clipboard.setData(ClipboardData(text: widget.text));
              if (!mounted) return;
              setState(() => _copied = true);
              await Future<void>.delayed(const Duration(seconds: 2));
              if (mounted) {
                setState(() => _copied = false);
              }
            },
    );
  }
}
