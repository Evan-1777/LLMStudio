import 'package:flutter/foundation.dart';

import '../models/conversation.dart';
import '../network/gateway_client.dart';

class ConversationsController extends ChangeNotifier {
  ConversationsController({required this.gateway});

  final GatewayClient gateway;

  List<Conversation> _conversations = const [];
  String _activeAssistantId = 'default';
  String? _activeId;
  String _searchQuery = '';
  bool _isLoading = false;
  String? _error;

  List<Conversation> get conversations => _conversations;
  String get activeAssistantId => _activeAssistantId;
  String? get activeId => _activeId;
  String get searchQuery => _searchQuery;
  bool get isLoading => _isLoading;
  String? get error => _error;

  Conversation? get activeConversation {
    final id = _activeId;
    if (id == null) return null;
    for (final c in _conversations) {
      if (c.id == id) return c;
    }
    return null;
  }

  List<Conversation> get assistantConversations =>
      _conversations.where((c) => c.assistantId == _activeAssistantId).toList();

  List<Conversation> get filteredConversations {
    final scoped = assistantConversations;
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return scoped;
    return scoped.where((c) => c.title.toLowerCase().contains(q)).toList();
  }

  void setActiveAssistantId(String assistantId) {
    final normalized = assistantId.trim().isEmpty ? 'default' : assistantId;
    if (_activeAssistantId == normalized) return;
    _activeAssistantId = normalized;
    final scoped = assistantConversations;
    _activeId = scoped.isNotEmpty ? scoped.first.id : null;
    notifyListeners();
  }

  void setSearchQuery(String value) {
    if (_searchQuery == value) return;
    _searchQuery = value;
    notifyListeners();
  }

  void setActiveId(String? id) {
    if (_activeId == id) return;
    _activeId = id;
    notifyListeners();
  }

  void upsertLocal(Conversation conv) {
    final exists = _conversations.any((c) => c.id == conv.id);
    if (exists) {
      _conversations = [
        conv,
        for (final c in _conversations)
          if (c.id != conv.id) c,
      ];
    } else {
      _conversations = [conv, ..._conversations];
    }
    notifyListeners();
  }

  Future<void> refresh({bool selectFirstIfEmpty = true}) async {
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      _conversations = await gateway.listConversations();
      final scoped = assistantConversations;
      if (_activeId != null && !scoped.any((c) => c.id == _activeId)) {
        _activeId = null;
      }
      if (selectFirstIfEmpty && _activeId == null && scoped.isNotEmpty) {
        _activeId = scoped.first.id;
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<Conversation> createConversation({
    String? assistantId,
    String title = '',
    String providerId = '',
    String modelId = '',
    String systemPrompt = '',
    GenerationParams? params,
  }) async {
    final effectiveAssistantId = (assistantId ?? _activeAssistantId).trim();
    final created = await gateway.createConversation(
      assistantId:
          effectiveAssistantId.isEmpty ? 'default' : effectiveAssistantId,
      title: title,
      providerId: providerId,
      modelId: modelId,
      systemPrompt: systemPrompt,
      params: params,
    );
    _conversations = [created, ..._conversations];
    _activeAssistantId = created.assistantId;
    _activeId = created.id;
    notifyListeners();
    return created;
  }

  Future<Conversation> patchConversation(
    String id, {
    String? assistantId,
    String? title,
    String? providerId,
    String? modelId,
    String? systemPrompt,
    GenerationParams? params,
    bool clearNullParams = false,
  }) async {
    final updated = await gateway.patchConversation(
      id,
      assistantId: assistantId,
      title: title,
      providerId: providerId,
      modelId: modelId,
      systemPrompt: systemPrompt,
      params: params,
      clearNullParams: clearNullParams,
    );
    _conversations = [
      for (final c in _conversations)
        if (c.id == id) updated else c,
    ];
    notifyListeners();
    return updated;
  }

  Future<ConversationDetail> branchFromMessage(
    String conversationId,
    String messageId,
  ) async {
    final detail = await gateway.branchConversation(conversationId, messageId);
    _conversations = [detail.conversation, ..._conversations];
    _activeAssistantId = detail.conversation.assistantId;
    _activeId = detail.conversation.id;
    notifyListeners();
    return detail;
  }

  Future<void> deleteConversation(String id) async {
    await gateway.deleteConversation(id);
    _conversations = _conversations.where((c) => c.id != id).toList();
    if (_activeId == id) {
      final scoped = assistantConversations;
      _activeId = scoped.isNotEmpty ? scoped.first.id : null;
    }
    notifyListeners();
  }
}
