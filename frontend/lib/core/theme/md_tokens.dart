import 'package:flutter/animation.dart';

/// Material Design 3 8dp-grid spacing scale.
abstract final class MdSpacing {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
  static const double xxxl = 48;
}

/// Material Design 3 corner radius tokens.
abstract final class MdRadii {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 28;
  static const double full = 9999;
}

/// Window size classifications per MD3 responsive guidelines.
enum WindowSizeClass {
  compact,
  medium,
  expanded,
}

/// Adaptive viewport breakpoints and canonical workbench dimensions.
abstract final class MdBreakpoints {
  static const double compactMaxWidth = 600;
  static const double mediumMaxWidth = 840;

  static const double sidebarWidth = 280;
  static const double inspectorWidth = 320;
  static const double maxReadableWidth = 880;
  static const double settingsDialogMaxWidth = 860;

  static WindowSizeClass classify(double width) {
    if (width < compactMaxWidth) {
      return WindowSizeClass.compact;
    }
    if (width < mediumMaxWidth) {
      return WindowSizeClass.medium;
    }
    return WindowSizeClass.expanded;
  }

  static bool isCompact(double width) =>
      classify(width) == WindowSizeClass.compact;

  static bool isMedium(double width) =>
      classify(width) == WindowSizeClass.medium;

  static bool isExpanded(double width) =>
      classify(width) == WindowSizeClass.expanded;
}

/// Material Design 3 motion durations and easing curves.
abstract final class MdMotion {
  static const Duration standardDuration = Duration(milliseconds: 300);
  static const Duration standardDecelerateDuration = Duration(milliseconds: 250);
  static const Duration standardAccelerateDuration = Duration(milliseconds: 200);

  static const Duration emphasizedDuration = Duration(milliseconds: 500);
  static const Duration emphasizedDecelerateDuration = Duration(milliseconds: 400);
  static const Duration emphasizedAccelerateDuration = Duration(milliseconds: 200);

  static const Curve standardCurve = Cubic(0.2, 0.0, 0.0, 1.0);
  static const Curve standardDecelerateCurve = Cubic(0.0, 0.0, 0.0, 1.0);
  static const Curve standardAccelerateCurve = Cubic(0.3, 0.0, 1.0, 1.0);

  static const Curve emphasizedCurve = Cubic(0.2, 0.0, 0.0, 1.0);
  static const Curve emphasizedDecelerateCurve = Cubic(0.05, 0.7, 0.1, 1.0);
  static const Curve emphasizedAccelerateCurve = Cubic(0.3, 0.0, 0.8, 0.15);
}
