import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:llmstudio_frontend/core/models/assistant.dart';
import 'package:llmstudio_frontend/core/models/content_block.dart';
import 'package:llmstudio_frontend/core/models/conversation.dart';
import 'package:llmstudio_frontend/core/models/plugin_models.dart';
import 'package:llmstudio_frontend/core/models/provider.dart';
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

  test('v1.1 models and GatewayClient serialize assistants, search, MCP, discovery, and blocks', () async {
    final assistant = Assistant.fromJson({
      'id': 'a1',
      'name': 'Coder',
      'systemPrompt': 'Write clean Dart.',
      'defaultProviderId': 'p1',
      'defaultModelId': 'm1',
      'isDefault': false,
    });
    expect(assistant.toJson()['defaultProviderId'], 'p1');

    final fmt = FormatInfo.fromJson({
      'id': 'openai-responses',
      'displayName': 'OpenAI Responses',
      'defaultPath': '/v1/responses',
    });
    expect(fmt.defaultPath, '/v1/responses');

    final conv = Conversation.fromJson({
      'id': 'c2',
      'title': 'Topic',
      'createdAt': '2026-11-17T00:00:00Z',
      'updatedAt': '2026-11-17T00:00:00Z',
    });
    expect(conv.assistantId, 'default');

    final ws = WebSearchPayload.fromExtra({
      'query': 'flutter 3.44',
      'engineId': 'tavily',
      'results': [
        {'title': 'Release', 'url': 'https://flutter.dev', 'snippet': 'Notes'},
      ],
    });
    expect(ws.results, hasLength(1));
    expect(ws.results.first.title, 'Release');

    final imgAtt = const ComposerAttachment(
      name: 'pic.png',
      mimeType: 'image/png',
      isImage: true,
      base64Data: 'QUJD',
    ).toContentBlock();
    expect(imgAtt, isA<ImageBlock>());
    expect((imgAtt as ImageBlock).data, 'QUJD');

    final txtAtt = const ComposerAttachment(
      name: 'main.dart',
      isImage: false,
      textContent: 'void main() {}',
    ).toContentBlock();
    expect(txtAtt, isA<TextBlock>());
    expect((txtAtt as TextBlock).text, '<file name="main.dart">\nvoid main() {}\n</file>');

    final discovered = DiscoveredModel.fromJson({
      'id': 'gpt-4o',
      'name': 'GPT-4o',
      'group': 'gpt',
      'apiFormat': 'openai-completions',
      'reasoning': false,
    });
    expect(discovered.toModelConfig().id, 'gpt-4o');

    final seenPaths = <String>[];
    final fakeClient = _FakeStreamingHttpClient((req) async {
      seenPaths.add('${req.method} ${req.url.path}');
      if (req.url.path == '/api/v1/formats') {
        final body = utf8.encode(jsonEncode({
          'formats': [
            {'id': 'openai-responses', 'displayName': 'Responses', 'defaultPath': '/v1/responses'},
          ],
          'adapters': [
            {'id': 'generic-http', 'displayName': 'Generic HTTP'},
          ],
        }));
        return http.StreamedResponse(Stream.value(body), 200);
      }
      if (req.url.path == '/api/v1/providers/p1/test') {
        final body = utf8.encode(jsonEncode({
          'ok': true,
          'latencyMs': 12,
          'modelCount': 2,
          'message': '连接正常',
        }));
        return http.StreamedResponse(Stream.value(body), 200);
      }
      if (req.url.path == '/api/v1/providers/p1/models/fetch') {
        final body = utf8.encode(jsonEncode({
          'models': [
            {'id': 'gpt-4.1', 'name': 'GPT-4.1', 'group': 'gpt', 'apiFormat': 'openai-responses'},
          ],
        }));
        return http.StreamedResponse(Stream.value(body), 200);
      }
      final body = utf8.encode(jsonEncode({
        'conversation': {'id': 'c-branch', 'assistantId': 'default', 'title': 'Topic (分支)'},
        'messages': [],
      }));
      return http.StreamedResponse(Stream.value(body), 201);
    });

    final gw = GatewayClient(baseUrl: 'http://localhost:8080', httpClient: fakeClient);
    final fmtMeta = await gw.listFormatsAndAdapters();
    expect(fmtMeta.formats.single.defaultPath, '/v1/responses');
    expect(fmtMeta.adapters.single.id, 'generic-http');

    final testRes = await gw.testProviderConnection('p1');
    expect(testRes.ok, isTrue);
    expect(testRes.modelCount, 2);

    final fetched = await gw.fetchProviderModels('p1');
    expect(fetched.single.id, 'gpt-4.1');

    final branched = await gw.branchConversation('c2', 'm2');
    expect(branched.conversation.id, 'c-branch');
    expect(seenPaths, contains('POST /api/v1/conversations/c2/messages/m2/branch'));
  });
}
