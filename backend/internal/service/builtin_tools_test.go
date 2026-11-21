package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestBuiltinTimeToolResolutionAndValidation(t *testing.T) {
	fixedNow := time.Date(2026, 11, 21, 0, 30, 0, 0, time.UTC)

	// Default (omitted) falls back to local timezone.
	resLocal := service.ExecuteBuiltinTimeToolForTest(fixedNow, json.RawMessage(`{}`))
	if resLocal.IsError || len(resLocal.Content) == 0 {
		t.Fatalf("expected valid local time result, got %+v", resLocal)
	}
	var parsedLocal map[string]any
	if err := json.Unmarshal([]byte(resLocal.Content[0].Text), &parsedLocal); err != nil {
		t.Fatalf("decode local json: %v", err)
	}
	if parsedLocal["unix"] != float64(fixedNow.Unix()) {
		t.Fatalf("unexpected unix timestamp: %+v", parsedLocal)
	}

	// IANA timezones.
	for _, tc := range []struct {
		tz     string
		offset string
		date   string
		time   string
	}{
		{"Asia/Shanghai", "+08:00", "2026-11-21", "08:30:00"},
		{"America/New_York", "-05:00", "2026-11-20", "19:30:00"},
		{"UTC", "+00:00", "2026-11-21", "00:30:00"},
		{"+08:00", "+08:00", "2026-11-21", "08:30:00"},
		{"-05:30", "-05:30", "2026-11-20", "19:00:00"},
		{"UTC+9", "+09:00", "2026-11-21", "09:30:00"},
		{"GMT-04:00", "-04:00", "2026-11-20", "20:30:00"},
	} {
		args, _ := json.Marshal(map[string]string{"timezone": tc.tz})
		res := service.ExecuteBuiltinTimeToolForTest(fixedNow, args)
		if res.IsError {
			t.Fatalf("timezone %q unexpectedly errored: %+v", tc.tz, res)
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(res.Content[0].Text), &out); err != nil {
			t.Fatalf("decode %q: %v", tc.tz, err)
		}
		if out["offset"] != tc.offset || out["date"] != tc.date || out["time"] != tc.time {
			t.Fatalf("timezone %q got %+v, want offset=%s date=%s time=%s", tc.tz, out, tc.offset, tc.date, tc.time)
		}
		if len(res.StructuredContent) == 0 {
			t.Fatalf("timezone %q missing StructuredContent", tc.tz)
		}
	}

	// Invalid timezones & malformed JSON return structured tool errors.
	for _, bad := range []string{`{"timezone":"Mars/Olympus"}`, `{"timezone":"+15:00"}`, `{"timezone":"UTC+99"}`, `not-json`} {
		res := service.ExecuteBuiltinTimeToolForTest(fixedNow, json.RawMessage(bad))
		if !res.IsError {
			t.Fatalf("expected IsError=true for %s, got %+v", bad, res)
		}
	}
}

func TestChatServiceBuiltinTimeToolFullFlowAndCrossRoundToggle(t *testing.T) {
	ctx := context.Background()

	var mu sync.Mutex
	var seenToolNames [][]string
	turn := 0
	var prefsSvc *service.PreferenceService

	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		turn++
		curTurn := turn
		var names []string
		if rawTools, ok := body["tools"].([]any); ok {
			for _, rt := range rawTools {
				fn := rt.(map[string]any)["function"].(map[string]any)
				names = append(names, fn["name"].(string))
			}
		}
		seenToolNames = append(seenToolNames, names)
		mu.Unlock()

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		if curTurn == 2 && len(names) > 0 {
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"tc_time_1\",\"function\":{\"name\":%q,\"arguments\":\"{\\\"timezone\\\":\\\"Asia/Shanghai\\\"}\"}}]}}]}\n\n", service.BuiltinTimeToolName)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
		} else {
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"turn-%d-ok\"}}]}\n\n", curTurn)
			_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		}
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}))
	defer llmSrv.Close()

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	formats := plugin.NewFormatRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters := plugin.NewProviderRegistry()
	adapters.MustRegister(provider.NewGenericHTTPAdapter())

	provStore := store.NewProviderStore(db)
	convStore := store.NewConversationStore(db)
	msgStore := store.NewMessageStore(db)
	prefsSvc = service.NewPreferenceService(store.NewPreferenceStore(db))

	_, err = provStore.Create(ctx, domain.ProviderConfig{
		ID:       "prov-time",
		Name:     "Mock",
		Adapter:  provider.AdapterGenericHTTP,
		BaseURL:  llmSrv.URL,
		AuthType: domain.AuthTypeNone,
		Enabled:  true,
		LocalRequest: true,
		Models: []domain.ModelConfig{
			{ID: "gpt-4o", Name: "GPT-4o", APIFormat: format.FormatIDOpenAICompletions},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	conv, err := convStore.Create(ctx, domain.Conversation{
		ID: "conv-time", AssistantID: domain.DefaultAssistantID, Title: "Time", ProviderID: "prov-time", ModelID: "gpt-4o",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Intentionally omit external MCP store/client to prove builtin tool works with zero external MCP servers.
	svc := service.NewChatService(provStore, convStore, msgStore, formats, adapters, &http.Client{}).
		WithPreferences(prefsSvc)

	// 1. Default disabled: no tools exposed.
	prepOff, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "what time is it"})
	if err != nil {
		t.Fatalf("Prepare disabled: %v", err)
	}
	_ = prepOff.Stream(ctx, func(domain.StreamEvent) error { return nil })
	if len(seenToolNames[0]) != 0 {
		t.Fatalf("expected 0 tools when disabled, got %v", seenToolNames[0])
	}

	// 2. Enable builtinTimeToolEnabled: Prepare/Stream exposes and executes get_current_time across rounds.
	enable := true
	if _, _, err := prefsSvc.Update(ctx, domain.PreferencesPatch{BuiltinTimeToolEnabled: &enable}); err != nil {
		t.Fatal(err)
	}
	prepOn, err := svc.Prepare(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "what time in Shanghai"})
	if err != nil {
		t.Fatalf("Prepare enabled: %v", err)
	}
	var streamEvents []domain.StreamEvent
	if err := prepOn.Stream(ctx, func(ev domain.StreamEvent) error {
		streamEvents = append(streamEvents, ev)
		return nil
	}); err != nil {
		t.Fatalf("Stream enabled: %v", err)
	}
	if len(seenToolNames) < 3 || len(seenToolNames[1]) != 1 || seenToolNames[1][0] != service.BuiltinTimeToolName {
		t.Fatalf("expected get_current_time exposed when enabled, got %+v", seenToolNames)
	}
	var foundToolResult bool
	for _, ev := range streamEvents {
		if ev.Block != nil && ev.Block.Type == domain.BlockTypeToolResult && !ev.Block.IsError && ev.Block.ToolName == service.BuiltinTimeToolName {
			foundToolResult = true
		}
	}
	if !foundToolResult {
		t.Fatalf("expected successful builtin toolResult event, got %+v", streamEvents)
	}

	// 3. Browser-direct path (PrepareLocal + ExecuteTools) discovers and executes get_current_time.
	localPrep, err := svc.PrepareLocal(ctx, service.StreamChatInput{ConversationID: conv.ID, Text: "direct time"})
	if err != nil {
		t.Fatalf("PrepareLocal: %v", err)
	}
	rawBody, _ := json.Marshal(localPrep.Body)
	if !json.Valid(rawBody) {
		t.Fatal("invalid PrepareLocal body")
	}
	var execEvents []domain.StreamEvent
	if err := svc.ExecuteTools(ctx, service.ExecuteToolsInput{
		ConversationID: conv.ID,
		Calls: []service.ToolCallInput{
			{ID: "call-1", Name: service.BuiltinTimeToolName, Arguments: json.RawMessage(`{"timezone":"+08:00"}`)},
		},
	}, func(ev domain.StreamEvent) error {
		execEvents = append(execEvents, ev)
		return nil
	}); err != nil {
		t.Fatalf("ExecuteTools: %v", err)
	}
	if len(execEvents) == 0 || execEvents[0].Block == nil || execEvents[0].Block.IsError {
		t.Fatalf("expected ExecuteTools success for builtin time tool, got %+v", execEvents)
	}

	// 4. Disabling mid-flight blocks ExecuteTools execution.
	disable := false
	if _, _, err := prefsSvc.Update(ctx, domain.PreferencesPatch{BuiltinTimeToolEnabled: &disable}); err != nil {
		t.Fatal(err)
	}
	var disabledEvents []domain.StreamEvent
	if err := svc.ExecuteTools(ctx, service.ExecuteToolsInput{
		ConversationID: conv.ID,
		Calls: []service.ToolCallInput{
			{ID: "call-2", Name: service.BuiltinTimeToolName, Arguments: json.RawMessage(`{}`)},
		},
	}, func(ev domain.StreamEvent) error {
		disabledEvents = append(disabledEvents, ev)
		return nil
	}); err != nil {
		t.Fatalf("ExecuteTools disabled: %v", err)
	}
	if len(disabledEvents) == 0 || disabledEvents[0].Block == nil || !disabledEvents[0].Block.IsError {
		t.Fatalf("expected IsError=true when builtin tool is disabled, got %+v", disabledEvents)
	}
}
