import 'package:flutter/foundation.dart';

import '../models/assistant.dart';
import '../network/gateway_client.dart';

class AssistantsController extends ChangeNotifier {
  AssistantsController({required this.gateway});

  final GatewayClient gateway;

  List<Assistant> _assistants = const [
    Assistant(id: 'default', name: '默认助手', isDefault: true),
  ];
  String _activeAssistantId = 'default';
  bool _isLoading = false;
  String? _error;

  List<Assistant> get assistants => _assistants;
  String get activeAssistantId => _activeAssistantId;
  bool get isLoading => _isLoading;
  String? get error => _error;

  Assistant get activeAssistant {
    for (final a in _assistants) {
      if (a.id == _activeAssistantId) return a;
    }
    if (_assistants.isNotEmpty) return _assistants.first;
    return const Assistant(id: 'default', name: '默认助手', isDefault: true);
  }

  void selectAssistant(String id) {
    if (_activeAssistantId == id) return;
    _activeAssistantId = id;
    notifyListeners();
  }

  Future<void> refresh() async {
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      final list = await gateway.listAssistants();
      if (list.isNotEmpty) {
        _assistants = list;
        if (!_assistants.any((a) => a.id == _activeAssistantId)) {
          _activeAssistantId = _assistants.first.id;
        }
      }
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<Assistant> createAssistant(AssistantUpsertPayload payload) async {
    final created = await gateway.createAssistant(payload);
    _assistants = [..._assistants, created];
    _activeAssistantId = created.id;
    notifyListeners();
    return created;
  }

  Future<Assistant> updateAssistant(
    String id,
    AssistantUpsertPayload payload,
  ) async {
    final updated = await gateway.updateAssistant(id, payload);
    _assistants = [
      for (final a in _assistants)
        if (a.id == id) updated else a,
    ];
    notifyListeners();
    return updated;
  }

  Future<void> deleteAssistant(String id) async {
    await gateway.deleteAssistant(id);
    _assistants = _assistants.where((a) => a.id != id).toList();
    if (_activeAssistantId == id) {
      _activeAssistantId =
          _assistants.isNotEmpty ? _assistants.first.id : 'default';
    }
    notifyListeners();
  }
}
