import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/conversation.dart';
import '../../core/state/chat_controller.dart';
import '../../core/state/conversations_controller.dart';
import '../../core/theme/app_icons.dart';
import '../../core/theme/md_tokens.dart';

class ConversationSidebar extends StatefulWidget {
  const ConversationSidebar({
    super.key,
    required this.onSelectConversation,
    required this.onCreateConversation,
    this.onCloseDrawer,
  });

  final ValueChanged<String> onSelectConversation;
  final VoidCallback onCreateConversation;
  final VoidCallback? onCloseDrawer;

  @override
  State<ConversationSidebar> createState() => _ConversationSidebarState();
}

class _ConversationSidebarState extends State<ConversationSidebar> {
  final TextEditingController _searchCtrl = TextEditingController();

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _renameConversation(
    BuildContext context,
    Conversation conv,
  ) async {
    final convsCtrl = context.read<ConversationsController>();
    final ctrl = TextEditingController(text: conv.title);
    final updatedTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名话题'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(labelText: '标题'),
          onSubmitted: (value) => Navigator.of(ctx).pop(value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (updatedTitle != null && updatedTitle.isNotEmpty) {
      await convsCtrl.patchConversation(conv.id, title: updatedTitle);
    }
  }

  Future<void> _deleteConversation(
    BuildContext context,
    Conversation conv,
  ) async {
    final convsCtrl = context.read<ConversationsController>();
    final chatCtrl = context.read<ChatController>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除话题'),
        content: Text('确认删除「${conv.title}」？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final wasActive = convsCtrl.activeId == conv.id;
    await convsCtrl.deleteConversation(conv.id);
    if (!context.mounted) return;
    if (wasActive) {
      final nextId = convsCtrl.activeId;
      if (nextId != null) {
        await chatCtrl.loadConversation(nextId);
      } else {
        chatCtrl.clearSession();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final convsCtrl = context.watch<ConversationsController>();
    final items = convsCtrl.filteredConversations;

    return Container(
      color: scheme.surfaceContainerLow,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              MdSpacing.md,
              MdSpacing.md,
              MdSpacing.sm,
              MdSpacing.sm,
            ),
            child: Row(
              children: [
                Expanded(
                  child: FilledButton.tonalIcon(
                    key: const Key('history_new_topic_button'),
                    onPressed: () {
                      widget.onCreateConversation();
                      widget.onCloseDrawer?.call();
                    },
                    icon: AppSvgIcon(
                      AppIcons.plus,
                      size: 16,
                      color: scheme.onSecondaryContainer,
                    ),
                    label: const Text('新建话题'),
                  ),
                ),
                if (widget.onCloseDrawer != null)
                  AppIconAction(
                    svg: AppIcons.close,
                    tooltip: '关闭',
                    onPressed: widget.onCloseDrawer,
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: MdSpacing.md),
            child: TextField(
              key: const Key('history_search_field'),
              controller: _searchCtrl,
              onChanged: convsCtrl.setSearchQuery,
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜索话题',
                prefixIcon: Padding(
                  padding: const EdgeInsets.all(10),
                  child: AppSvgIcon(
                    AppIcons.search,
                    size: 16,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
                suffixIcon: convsCtrl.searchQuery.isNotEmpty
                    ? AppIconAction(
                        svg: AppIcons.close,
                        size: 14,
                        tooltip: '清除',
                        onPressed: () {
                          _searchCtrl.clear();
                          convsCtrl.setSearchQuery('');
                        },
                      )
                    : null,
              ),
            ),
          ),
          const SizedBox(height: MdSpacing.sm),
          Expanded(
            child: items.isEmpty
                ? const SizedBox.shrink()
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(
                      horizontal: MdSpacing.sm,
                      vertical: MdSpacing.xs,
                    ),
                    itemCount: items.length,
                    itemBuilder: (context, index) {
                      final conv = items[index];
                      final selected = conv.id == convsCtrl.activeId;
                      return _ConversationTile(
                        conversation: conv,
                        selected: selected,
                        onTap: () {
                          widget.onSelectConversation(conv.id);
                          widget.onCloseDrawer?.call();
                        },
                        onRename: () => _renameConversation(context, conv),
                        onDelete: () => _deleteConversation(context, conv),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _ConversationTile extends StatefulWidget {
  const _ConversationTile({
    required this.conversation,
    required this.selected,
    required this.onTap,
    required this.onRename,
    required this.onDelete,
  });

  final Conversation conversation;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onRename;
  final VoidCallback onDelete;

  @override
  State<_ConversationTile> createState() => _ConversationTileState();
}

class _ConversationTileState extends State<_ConversationTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bg = widget.selected
        ? scheme.secondaryContainer
        : _hovered
            ? scheme.surfaceContainerHigh
            : Colors.transparent;
    final fg = widget.selected
        ? scheme.onSecondaryContainer
        : scheme.onSurface;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Material(
          color: bg,
          borderRadius: BorderRadius.circular(MdRadii.md),
          child: InkWell(
            onTap: widget.onTap,
            borderRadius: BorderRadius.circular(MdRadii.md),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: MdSpacing.md,
                vertical: MdSpacing.sm,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.conversation.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                            color: fg,
                            fontWeight: widget.selected
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                    ),
                  ),
                  if (_hovered || widget.selected) ...[
                    AppIconAction(
                      svg: AppIcons.edit,
                      size: 15,
                      tooltip: '重命名',
                      color: fg.withValues(alpha: 0.8),
                      padding: const EdgeInsets.all(4),
                      constraints:
                          const BoxConstraints(minWidth: 28, minHeight: 28),
                      onPressed: widget.onRename,
                    ),
                    AppIconAction(
                      svg: AppIcons.trash,
                      size: 15,
                      tooltip: '删除',
                      color: fg.withValues(alpha: 0.8),
                      padding: const EdgeInsets.all(4),
                      constraints:
                          const BoxConstraints(minWidth: 28, minHeight: 28),
                      onPressed: widget.onDelete,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
