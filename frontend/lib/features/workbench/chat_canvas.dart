import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/models/content_block.dart';
import '../../core/models/message.dart';
import '../../core/models/plugin_models.dart';
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
    required this.onRetryMessage,
    required this.onDeleteMessage,
    required this.onBranchMessage,
    this.onOpenSettings,
    this.assistantTextBuilder,
  });

  final VoidCallback onRetry;
  final ValueChanged<String> onRetryMessage;
  final ValueChanged<String> onDeleteMessage;
  final ValueChanged<String> onBranchMessage;
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
                    isBusy: chatCtrl.isBusy,
                    rendererRegistry: _rendererRegistry,
                    onRetry: () => widget.onRetryMessage(msg.id),
                    onDelete: () => widget.onDeleteMessage(msg.id),
                    onBranch: () => widget.onBranchMessage(msg.id),
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
    required this.isBusy,
    required this.rendererRegistry,
    required this.onRetry,
    required this.onDelete,
    required this.onBranch,
    this.assistantTextBuilder,
  });

  final Message message;
  final bool isStreaming;
  final bool isBusy;
  final ContentRendererRegistry rendererRegistry;
  final VoidCallback onRetry;
  final VoidCallback onDelete;
  final VoidCallback onBranch;
  final AssistantTextBuilder? assistantTextBuilder;

  Widget _buildActionBar(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final canMutate = !isBusy;
    final canBranch = !isBusy && !message.id.startsWith('local-');

    return Padding(
      padding: const EdgeInsets.only(top: MdSpacing.xs),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _CopyMessageAction(
            key: Key('msg_copy_${message.id}'),
            text: message.plainText,
          ),
          AppIconAction(
            key: Key('msg_retry_${message.id}'),
            svg: AppIcons.refresh,
            size: 16,
            tooltip: '重试',
            onPressed: canMutate ? onRetry : null,
          ),
          AppIconAction(
            key: Key('msg_delete_${message.id}'),
            svg: AppIcons.trash,
            size: 16,
            tooltip: '删除',
            onPressed: canMutate ? onDelete : null,
          ),
          AppIconAction(
            key: Key('msg_branch_${message.id}'),
            svg: AppIcons.branch,
            size: 16,
            tooltip: '分支',
            onPressed: canBranch ? onBranch : null,
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
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isUser = message.role == 'user';

    if (isUser) {
      return Padding(
        padding: const EdgeInsets.only(bottom: MdSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Container(
              constraints: const BoxConstraints(maxWidth: 620),
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
                  for (final block in message.blocks)
                    _buildBlock(context, block),
                ],
              ),
            ),
            if (!isStreaming) _buildActionBar(context),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: MdSpacing.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final block in message.blocks) _buildBlock(context, block),
          if (!isStreaming) _buildActionBar(context),
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
      case ImageBlock(:final url, :final mimeType):
        return Padding(
          padding: const EdgeInsets.only(top: MdSpacing.xs, bottom: MdSpacing.xs),
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
                  url.isNotEmpty
                      ? url
                      : (mimeType.isNotEmpty ? mimeType : '图片附件'),
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
      case ExtensionBlock(:final type, :final extra):
        if (type == 'webSearch') {
          return _WebSearchCard(payload: WebSearchPayload.fromExtra(extra));
        }
        return _CompactBlockChip(
          svg: AppIcons.code,
          label: type,
        );
    }
  }
}

class _WebSearchCard extends StatefulWidget {
  const _WebSearchCard({required this.payload});

  final WebSearchPayload payload;

  @override
  State<_WebSearchCard> createState() => _WebSearchCardState();
}

class _WebSearchCardState extends State<_WebSearchCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final p = widget.payload;
    final hasError = p.error.isNotEmpty;

    return Container(
      margin: const EdgeInsets.only(bottom: MdSpacing.sm),
      decoration: BoxDecoration(
        color: hasError ? scheme.errorContainer : scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(MdRadii.md),
        border: Border.all(
          color: hasError ? scheme.error : scheme.outlineVariant,
        ),
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
                    hasError ? AppIcons.warning : AppIcons.globe,
                    size: 15,
                    color: hasError ? scheme.onErrorContainer : scheme.primary,
                  ),
                  const SizedBox(width: MdSpacing.sm),
                  Expanded(
                    child: Text(
                      hasError
                          ? '联网搜索失败 (${p.engineId})'
                          : '联网搜索 · ${p.results.length} 条结果 (${p.engineId})',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelMedium?.copyWith(
                        color: hasError
                            ? scheme.onErrorContainer
                            : scheme.onSurface,
                      ),
                    ),
                  ),
                  AppSvgIcon(
                    _expanded ? AppIcons.chevronUp : AppIcons.chevronDown,
                    size: 16,
                    color: hasError
                        ? scheme.onErrorContainer
                        : scheme.onSurfaceVariant,
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
              child: hasError
                  ? SelectableText(
                      p.error,
                      style: textTheme.bodySmall?.copyWith(
                        color: scheme.onErrorContainer,
                      ),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (p.query.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: MdSpacing.xs),
                            child: Text(
                              '检索词: ${p.query}',
                              style: textTheme.labelSmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                        for (var i = 0; i < p.results.length; i++) ...[
                          if (i > 0) const SizedBox(height: MdSpacing.xs),
                          Text(
                            '${i + 1}. ${p.results[i].title}',
                            style: textTheme.bodySmall?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          SelectableText(
                            p.results[i].url,
                            style: textTheme.labelSmall?.copyWith(
                              color: scheme.primary,
                            ),
                          ),
                          if (p.results[i].snippet.isNotEmpty)
                            Text(
                              p.results[i].snippet,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: textTheme.bodySmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ],
                    ),
            ),
        ],
      ),
    );
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
  const _CopyMessageAction({super.key, required this.text});

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
