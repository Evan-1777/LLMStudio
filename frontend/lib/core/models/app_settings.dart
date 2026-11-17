import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

class AppSettings {
  const AppSettings({
    required this.gatewayBaseUrl,
    this.accessToken = '',
    this.themeMode = ThemeMode.system,
    this.seedColorValue = 0xFF3F5F90,
    this.autoCollapseEnabled = true,
    this.collapseLineThreshold = 24,
    this.collapseCharThreshold = 1200,
    this.enterToSend = true,
    this.defaultHtmlPreview = true,
  });

  final String gatewayBaseUrl;
  final String accessToken;
  final ThemeMode themeMode;
  final int seedColorValue;
  final bool autoCollapseEnabled;
  final int collapseLineThreshold;
  final int collapseCharThreshold;
  final bool enterToSend;
  final bool defaultHtmlPreview;

  static String defaultBaseUrl() {
    if (kIsWeb && (Uri.base.scheme == 'http' || Uri.base.scheme == 'https')) {
      return '/';
    }
    return 'http://localhost:8080';
  }

  factory AppSettings.defaults() => AppSettings(
        gatewayBaseUrl: defaultBaseUrl(),
      );

  AppSettings copyWith({
    String? gatewayBaseUrl,
    String? accessToken,
    ThemeMode? themeMode,
    int? seedColorValue,
    bool? autoCollapseEnabled,
    int? collapseLineThreshold,
    int? collapseCharThreshold,
    bool? enterToSend,
    bool? defaultHtmlPreview,
  }) {
    return AppSettings(
      gatewayBaseUrl: gatewayBaseUrl ?? this.gatewayBaseUrl,
      accessToken: accessToken ?? this.accessToken,
      themeMode: themeMode ?? this.themeMode,
      seedColorValue: seedColorValue ?? this.seedColorValue,
      autoCollapseEnabled: autoCollapseEnabled ?? this.autoCollapseEnabled,
      collapseLineThreshold:
          collapseLineThreshold ?? this.collapseLineThreshold,
      collapseCharThreshold:
          collapseCharThreshold ?? this.collapseCharThreshold,
      enterToSend: enterToSend ?? this.enterToSend,
      defaultHtmlPreview: defaultHtmlPreview ?? this.defaultHtmlPreview,
    );
  }

  factory AppSettings.fromJson(Map<String, dynamic> json) {
    final modeName = json['themeMode'] as String? ?? 'system';
    final themeMode = switch (modeName) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
    return AppSettings(
      gatewayBaseUrl: (json['gatewayBaseUrl'] as String?)?.trim().isNotEmpty == true
          ? (json['gatewayBaseUrl'] as String).trim()
          : defaultBaseUrl(),
      accessToken: json['accessToken'] as String? ?? '',
      themeMode: themeMode,
      seedColorValue: (json['seedColorValue'] as num?)?.toInt() ?? 0xFF3F5F90,
      autoCollapseEnabled: json['autoCollapseEnabled'] as bool? ?? true,
      collapseLineThreshold:
          (json['collapseLineThreshold'] as num?)?.toInt().clamp(4, 200) ?? 24,
      collapseCharThreshold:
          (json['collapseCharThreshold'] as num?)?.toInt().clamp(120, 20000) ??
              1200,
      enterToSend: json['enterToSend'] as bool? ?? true,
      defaultHtmlPreview: json['defaultHtmlPreview'] as bool? ?? true,
    );
  }

  Map<String, dynamic> toJson() => {
        'gatewayBaseUrl': gatewayBaseUrl,
        'accessToken': accessToken,
        'themeMode': themeMode.name,
        'seedColorValue': seedColorValue,
        'autoCollapseEnabled': autoCollapseEnabled,
        'collapseLineThreshold': collapseLineThreshold,
        'collapseCharThreshold': collapseCharThreshold,
        'enterToSend': enterToSend,
        'defaultHtmlPreview': defaultHtmlPreview,
      };
}
