import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../../core/models/plugin_models.dart';

const int _maxAttachmentBytes = 8 * 1024 * 1024;

Future<List<ComposerAttachment>> pickComposerAttachments() async {
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..multiple = true
    ..accept =
        'image/*,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.dart,.go,.py,.sh,.sql,.log';

  final completer = Completer<List<ComposerAttachment>>();
  late JSFunction changeListener;
  late JSFunction cancelListener;

  void cleanup() {
    input.removeEventListener('change', changeListener);
    input.removeEventListener('cancel', cancelListener);
  }

  changeListener = ((web.Event _) async {
    cleanup();
    final files = input.files;
    if (files == null || files.length == 0) {
      if (!completer.isCompleted) completer.complete(const []);
      return;
    }

    final results = <ComposerAttachment>[];
    for (var i = 0; i < files.length; i++) {
      final file = files.item(i);
      if (file == null || file.size > _maxAttachmentBytes) continue;
      final att = await _readSingleFile(file);
      if (att != null) results.add(att);
    }
    if (!completer.isCompleted) {
      completer.complete(results);
    }
  }).toJS;

  cancelListener = ((web.Event _) {
    cleanup();
    if (!completer.isCompleted) completer.complete(const []);
  }).toJS;

  input.addEventListener('change', changeListener);
  input.addEventListener('cancel', cancelListener);
  input.click();
  return completer.future;
}

Future<ComposerAttachment?> _readSingleFile(web.File file) {
  final isImage = file.type.startsWith('image/');
  final reader = web.FileReader();
  final completer = Completer<ComposerAttachment?>();

  late JSFunction loadListener;
  late JSFunction errListener;

  void cleanup() {
    reader.removeEventListener('load', loadListener);
    reader.removeEventListener('error', errListener);
  }

  loadListener = ((web.Event _) {
    cleanup();
    final raw = reader.result?.dartify()?.toString() ?? '';
    if (isImage) {
      var mime = file.type.isNotEmpty ? file.type : 'image/png';
      var base64Data = raw;
      final commaIdx = raw.indexOf(',');
      if (raw.startsWith('data:') && commaIdx > 0) {
        final header = raw.substring(5, commaIdx);
        final semiIdx = header.indexOf(';');
        if (semiIdx > 0) mime = header.substring(0, semiIdx);
        base64Data = raw.substring(commaIdx + 1);
      }
      if (!completer.isCompleted) {
        completer.complete(
          ComposerAttachment(
            name: file.name,
            mimeType: mime,
            isImage: true,
            base64Data: base64Data,
            byteLength: file.size,
          ),
        );
      }
    } else {
      if (!completer.isCompleted) {
        completer.complete(
          ComposerAttachment(
            name: file.name,
            mimeType: file.type.isNotEmpty ? file.type : 'text/plain',
            isImage: false,
            textContent: raw,
            byteLength: file.size,
          ),
        );
      }
    }
  }).toJS;

  errListener = ((web.Event _) {
    cleanup();
    if (!completer.isCompleted) completer.complete(null);
  }).toJS;

  reader.addEventListener('load', loadListener);
  reader.addEventListener('error', errListener);

  if (isImage) {
    reader.readAsDataURL(file);
  } else {
    reader.readAsText(file);
  }
  return completer.future;
}
