import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:llmstudio_frontend/core/models/content_block.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
import 'package:llmstudio_frontend/core/network/gateway_client.dart';
import 'package:llmstudio_frontend/core/storage/settings_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeStreamingHttpClient extends http.BaseClient {
  _FakeStreamingHttpClient(this.handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request) handler;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => handler(request);
}

void main() {
  test('ContentBlock and Conversation sync fields parse and serialize accurately', () {
    final blocks = [
      ContentBlock.fromJson({'type': 'text', 'text': 'hello'}),
      ContentBlock.fromJson({
        'type': 'thinking',
        'thinking': 'step',
        'signature': 'sig1',
      }),
      ContentBlock.fromJson({
        'type': 'image',
        'mimeType': 'image/png',
        'url': 'https://example.com/a.png',
      }),
      ContentBlock.fromJson({
        'type': 'toolCall',
        'id': 'tc1',
        'name': 'search',
        'arguments': {'q': 'dart'},
      }),
      ContentBlock.fromJson({
        'type': 'toolResult',
        'toolCallId': 'tc1',
        'toolName': 'search',
        'content': 'ok',
        'isError': false,
      }),
      ContentBlock.fromJson({
        'type': 'imageGen',
        'extra': {'seed': 7},
      }),
    ];

    expect(blocks[0], isA<TextBlock>());
    expect(blocks[1], isA<ThinkingBlock>());
    expect((blocks[1] as ThinkingBlock).signature, 'sig1');
    expect(blocks[2], isA<ImageBlock>());
    expect(blocks[3], isA<ToolCallBlock>());
    expect(blocks[4], isA<ToolResultBlock>());
    expect(blocks[5], isA<ExtensionBlock>());
    expect((blocks[5] as ExtensionBlock).extra, {'seed': 7});

    final conv = Conversation.fromJson({
      'id': 'c1',
      'title': 'Session',
      'syncEnabled': true,
      'syncState': 'local_only',
      'syncVersion': 2,
      'createdAt': '2026-11-17T00:00:00Z',
      'updatedAt': '2026-11-17T00:00:00Z',
    });
    expect(conv.syncEnabled, isTrue);
    expect(conv.syncState, 'local_only');
    expect(conv.syncVersion, 2);
  });

  test('SettingsStore persists and restores AppSettings', () async {
    SharedPreferences.setMockInitialValues({});
    final store = SettingsStore();
    final initial = await store.load();
    expect(initial.autoCollapseEnabled, isTrue);
    expect(initial.collapseLineThreshold, 24);

    final updated = initial.copyWith(
      gatewayBaseUrl: 'https://gw.example.com',
      accessToken: 'tok-abc',
      collapseLineThreshold: 40,
      enterToSend: false,
    );
    await store.save(updated);

    final reloaded = await store.load();
    expect(reloaded.gatewayBaseUrl, 'https://gw.example.com');
    expect(reloaded.accessToken, 'tok-abc');
    expect(reloaded.collapseLineThreshold, 40);
    expect(reloaded.enterToSend, isFalse);
  });

  test('decodeSseByteStream handles multi-byte UTF-8 split across chunks and CRLF', () async {
    final fullPayload = 'event: block_delta\r\n'
        'data: {"type":"block_delta","index":0,"delta":"你好世界🚀"}\r\n\r\n';
    final bytes = utf8.encode(fullPayload);
    // Split directly inside multi-byte Chinese and emoji UTF-8 sequences.
    final splitIndex = fullPayload.indexOf('你好') + 2;
    final byteSplit = utf8.encode(fullPayload.substring(0, splitIndex)).length - 1;

    final stream = Stream<List<int>>.fromIterable([
      bytes.sublist(0, byteSplit),
      bytes.sublist(byteSplit, byteSplit + 3),
      bytes.sublist(byteSplit + 3),
    ]);

    final frames = await decodeSseByteStream(stream).toList();
    expect(frames, hasLength(1));
    expect(frames.first.event, 'block_delta');
    final decoded = jsonDecode(frames.first.data) as Map<String, dynamic>;
    expect(decoded['delta'], '你好世界🚀');
  });

  test('GatewayClient injects Bearer token and triggers AbortTrigger', () async {
    final controller = StreamController<List<int>>();
    final abortCompleter = Completer<void>();
    http.BaseRequest? capturedReq;

    final fakeClient = _FakeStreamingHttpClient((req) async {
      capturedReq = req;
      final abortable = req as http.Abortable;
      abortable.abortTrigger?.then((_) {
        if (!controller.isClosed) {
          controller.addError(http.RequestAbortedException(req.url));
          controller.close();
        }
      });
      controller.add(
        utf8.encode(
          'event: block_delta\ndata: {"type":"block_delta","index":0,"delta":"hi"}\n\n',
        ),
      );
      return http.StreamedResponse(controller.stream, 200);
    });

    final gw = GatewayClient(
      baseUrl: 'http://localhost:8080',
      accessToken: 'secret-token',
      httpClient: fakeClient,
    );

    final events = <String>[];
    Object? caughtErr;
    try {
      await for (final ev in gw.streamChat(
        conversationId: 'c1',
        text: 'hello',
        abortTrigger: abortCompleter.future,
      )) {
        events.add(ev.delta);
        abortCompleter.complete();
      }
    } catch (e) {
      caughtErr = e;
    }

    expect(capturedReq?.headers['Authorization'], 'Bearer secret-token');
    expect(events, ['hi']);
    expect(caughtErr, isA<http.RequestAbortedException>());
  });
}
