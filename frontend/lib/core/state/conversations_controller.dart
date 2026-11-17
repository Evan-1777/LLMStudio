import 'package:flutter/foundation.dart';

import '../models/conversation.dart';
import '../network/gateway_client.dart';

class ConversationsController extends ChangeNotifier {
  ConversationsController({required this.gateway});

  final GatewayClient gateway;

  List<Conversation> _conversations = const [];
  String? _activeId;
  String _searchQuery = '';
  bool _isLoading = false;
  String? _error;

  List<Conversation> get conversations => _conversations;
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

  List<Conversation> get filteredConversations {
    final q = _searchQuery.trim().toLowerCase();
    if (q.isEmpty) return _conversations;
    return _conversations
        .where((c) => c.title.toLowerCase().contains(q))
        .toList();
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
      if (_activeId != null &&
          !_conversations.any((c) => c.id == _activeId)) {
        _activeId = null;
      }
      if (selectFirstIfEmpty && _activeId == null && _conversations.isNotEmpty) {
        _activeId = _conversations.first.id;
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<Conversation> createConversation({
    String title = '',
    String providerId = '',
    String modelId = '',
    String systemPrompt = '',
    GenerationParams? params,
  }) async {
    final created = await gateway.createConversation(
      title: title,
      providerId: providerId,
      modelId: modelId,
      systemPrompt: systemPrompt,
      params: params,
    );
    _conversations = [created, ..._conversations];
    _activeId = created.id;
    notifyListeners();
    return created;
  }

  Future<Conversation> patchConversation(
    String id, {
    String? title,
    String? providerId,
    String? modelId,
    String? systemPrompt,
    GenerationParams? params,
    bool clearNullParams = false,
  }) async {
    final updated = await gateway.patchConversation(
      id,
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

  Future<void> deleteConversation(String id) async {
    await gateway.deleteConversation(id);
    _conversations = _conversations.where((c) => c.id != id).toList();
    if (_activeId == id) {
      _activeId = _conversations.isNotEmpty ? _conversations.first.id : null;
    }
    notifyListeners();
  }
}
