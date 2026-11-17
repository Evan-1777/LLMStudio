import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// Unified inline SVG vector icon paths (24x24 geometric stroke style).
abstract final class AppIcons {
  static String _svg(String body) =>
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
      'fill="none" stroke="currentColor" stroke-width="1.75" '
      'stroke-linecap="round" stroke-linejoin="round">$body</svg>';

  static final String send = _svg(
    '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  );

  static final String stop = _svg(
    '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  );

  static final String plus = _svg(
    '<path d="M12 5v14"/><path d="M5 12h14"/>',
  );

  static final String sidebar = _svg(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  );

  static final String sliders = _svg(
    '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/>'
    '<path d="M4 12h4"/><path d="M12 12h8"/><circle cx="10" cy="12" r="2"/>'
    '<path d="M4 17h12"/><path d="M20 17h0"/><circle cx="18" cy="17" r="2"/>',
  );

  static final String settings = _svg(
    '<circle cx="12" cy="12" r="3"/>'
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  );

  static final String search = _svg(
    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  );

  static final String trash = _svg(
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  );

  static final String edit = _svg(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  );

  static final String copy = _svg(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  );

  static final String check = _svg(
    '<path d="m5 12 5 5L20 7"/>',
  );

  static final String refresh = _svg(
    '<path d="M21 12a9 9 0 0 0-15.5-6.3L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.5 6.3L21 16"/><path d="M16 16h5v5"/>',
  );

  static final String chevronDown = _svg(
    '<path d="m6 9 6 6 6-6"/>',
  );

  static final String chevronUp = _svg(
    '<path d="m18 15-6-6-6 6"/>',
  );

  static final String chevronRight = _svg(
    '<path d="m9 18 6-6-6-6"/>',
  );

  static final String eye = _svg(
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  );

  static final String eyeOff = _svg(
    '<path d="M9.9 4.2A9.8 9.8 0 0 1 12 4c6.5 0 10 8 10 8a17.5 17.5 0 0 1-3.3 4.3"/><path d="M6.6 6.6A17.7 17.7 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m2 2 20 20"/>',
  );

  static final String code = _svg(
    '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  );

  static final String preview = _svg(
    '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/><path d="m10 9 5 2.5L10 14V9Z"/>',
  );

  static final String expand = _svg(
    '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  );

  static final String close = _svg(
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  );

  static final String arrowDown = _svg(
    '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  );

  static final String sun = _svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
  );

  static final String moon = _svg(
    '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  );

  static final String monitor = _svg(
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  );

  static final String warning = _svg(
    '<path d="m12 3 9 16H3L12 3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  );

  static final String cpu = _svg(
    '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v4"/><path d="M15 1v4"/><path d="M9 19v4"/><path d="M15 19v4"/><path d="M1 9h4"/><path d="M1 15h4"/><path d="M19 9h4"/><path d="M19 15h4"/>',
  );

  static final String wrench = _svg(
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
  );

  static final String image = _svg(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  );

  static final String link = _svg(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  );

  static final String key = _svg(
    '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.7-8.7"/><path d="M17 6l3 3"/>',
  );

  static final String globe = _svg(
    '<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/>'
    '<path d="M12 3a13.5 13.5 0 0 1 0 18"/><path d="M12 3a13.5 13.5 0 0 0 0 18"/>',
  );

  static final String attachment = _svg(
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  );

  static final String branch = _svg(
    '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>'
    '<circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  );

  static final String lightbulb = _svg(
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>'
    '<path d="M9 18h6"/><path d="M10 22h4"/>',
  );

  static final String bot = _svg(
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>'
    '<path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  );

  static final String plugin = _svg(
    '<path d="M12 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0V7Z"/>'
    '<path d="M12 17v5"/><path d="M9 7V3"/><path d="M15 7V3"/>',
  );

  static final String arrowLeft = _svg(
    '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  );

  static final String folder = _svg(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  );
}

/// Renders an inline SVG icon tinted with the active Material 3 ColorScheme.
class AppSvgIcon extends StatelessWidget {
  const AppSvgIcon(
    this.svg, {
    super.key,
    this.size = 20,
    this.color,
    this.semanticsLabel,
  });

  final String svg;
  final double size;
  final Color? color;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final resolvedColor =
        color ?? IconTheme.of(context).color ?? Theme.of(context).colorScheme.onSurface;
    final picture = SvgPicture.string(
      svg,
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(resolvedColor, BlendMode.srcIn),
    );
    if (semanticsLabel == null) {
      return ExcludeSemantics(child: picture);
    }
    return Semantics(
      label: semanticsLabel,
      excludeSemantics: true,
      child: picture,
    );
  }
}

/// Compact MD3 icon action button backed by an inline SVG icon and tooltip.
class AppIconAction extends StatelessWidget {
  const AppIconAction({
    super.key,
    required this.svg,
    required this.tooltip,
    required this.onPressed,
    this.size = 18,
    this.color,
    this.backgroundColor,
    this.padding = const EdgeInsets.all(8),
    this.constraints = const BoxConstraints(minWidth: 36, minHeight: 36),
  });

  final String svg;
  final String tooltip;
  final VoidCallback? onPressed;
  final double size;
  final Color? color;
  final Color? backgroundColor;
  final EdgeInsetsGeometry padding;
  final BoxConstraints constraints;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final effectiveColor = color ??
        (onPressed == null
            ? scheme.onSurface.withValues(alpha: 0.38)
            : scheme.onSurfaceVariant);

    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      padding: padding,
      constraints: constraints,
      style: backgroundColor != null
          ? IconButton.styleFrom(backgroundColor: backgroundColor)
          : null,
      icon: AppSvgIcon(
        svg,
        size: size,
        color: effectiveColor,
        semanticsLabel: tooltip,
      ),
    );
  }
}
