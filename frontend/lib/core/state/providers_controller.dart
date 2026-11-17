import 'package:flutter/foundation.dart';

import '../models/provider.dart';
import '../network/gateway_client.dart';

class ModelOption {
  const ModelOption({
    required this.provider,
    required this.model,
  });

  final ProviderConfig provider;
  final ModelConfig model;

  bool get isUsable =>
      provider.enabled && (provider.authType == 'none' || provider.apiKeySet);
}

class ProvidersController extends ChangeNotifier {
  ProvidersController({required this.gateway});

  final GatewayClient gateway;

  List<FormatInfo> _formats = const [];
  List<ProviderConfig> _providers = const [];
  bool _isLoading = false;
  String? _error;

  List<FormatInfo> get formats => _formats;
  List<ProviderConfig> get providers => _providers;
  bool get isLoading => _isLoading;
  String? get error => _error;

  List<ProviderConfig> get enabledProviders =>
      _providers.where((p) => p.enabled && p.models.isNotEmpty).toList();

  List<ModelOption> get availableModels {
    final out = <ModelOption>[];
    for (final p in enabledProviders) {
      for (final m in p.models) {
        out.add(ModelOption(provider: p, model: m));
      }
    }
    return out;
  }

  List<ModelOption> get usableModels =>
      availableModels.where((o) => o.isUsable).toList();

  bool get hasUsableModel => usableModels.isNotEmpty;

  ModelOption? resolveModel(String providerId, String modelId) {
    for (final opt in availableModels) {
      if (opt.provider.id == providerId && opt.model.id == modelId) {
        return opt;
      }
    }
    return null;
  }

  ModelOption? defaultModel() {
    final usable = usableModels;
    if (usable.isNotEmpty) return usable.first;
    final all = availableModels;
    return all.isNotEmpty ? all.first : null;
  }

  Future<void> refresh() async {
    _isLoading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        gateway.listFormats(),
        gateway.listProviders(),
      ]);
      _formats = results[0] as List<FormatInfo>;
      _providers = results[1] as List<ProviderConfig>;
    } catch (e) {
      _error = e.toString();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<ProviderConfig> createProvider(ProviderUpsertPayload payload) async {
    final created = await gateway.createProvider(payload);
    _providers = [..._providers, created];
    notifyListeners();
    return created;
  }

  Future<ProviderConfig> updateProvider(
    String id,
    ProviderUpsertPayload payload,
  ) async {
    final updated = await gateway.updateProvider(id, payload);
    _providers = [
      for (final p in _providers)
        if (p.id == id) updated else p,
    ];
    notifyListeners();
    return updated;
  }

  Future<void> deleteProvider(String id) async {
    await gateway.deleteProvider(id);
    _providers = _providers.where((p) => p.id != id).toList();
    notifyListeners();
  }
}
