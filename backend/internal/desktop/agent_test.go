package desktop

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"llmstudio/backend/internal/agent"
	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/format"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/provider"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestAgentExecutionScopeAndTransfer(t *testing.T) {
	ctx := t.Context()
	gatewayDir, localDir, outside := t.TempDir(), t.TempDir(), t.TempDir()
	for path, text := range map[string]string{gatewayDir: "gateway-marker", localDir: "desktop-marker", outside: "outside-marker"} {
		if err := os.WriteFile(filepath.Join(path, "marker.txt"), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(path, "sub"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.Symlink(outside, filepath.Join(gatewayDir, "outside"))
	entered, canceled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var call struct {
			Tools    []struct{ Function struct{ Name string } }
			Messages []struct{ Role, Content string }
		}
		_ = json.Unmarshal(data, &call)
		w.Header().Set("Content-Type", "text/event-stream")
		last := call.Messages[len(call.Messages)-1]
		if last.Role == "tool" && bytes.Contains(data, []byte("cancel-after-tool")) {
			w.(http.Flusher).Flush()
			close(entered)
			<-r.Context().Done()
			close(canceled)
			return
		}
		if last.Role == "tool" {
			fmt.Fprint(w, `data: {"choices":[{"delta":{"content":"finished"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		// The mock deliberately tries a native name even when not advertised.
		name, args := "read", `{"path":"marker.txt"}`
		if strings.Contains(last.Content, "try-write") {
			name, args = "write", `{"path":"forbidden.txt","content":"no"}`
		}
		if strings.Contains(last.Content, "allow-write") {
			name, args = "write", `{"path":"created.txt","content":"yes"}`
		}
		if strings.Contains(last.Content, "fake-alias") {
			name, args = "native_write", `{"path":"forbidden.txt","content":"no"}`
		}
		fmt.Fprintf(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":%q,"arguments":%q}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n", name, args)
	}))
	defer upstream.Close()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ls, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "desktop.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer ls.Close()
	prov, convs, msgs := store.NewProviderStore(db), store.NewConversationStore(db), store.NewMessageStore(db)
	formats, adapters := plugin.NewFormatRegistry(), plugin.NewProviderRegistry()
	formats.MustRegister(format.NewOpenAICompletionsFormat())
	adapters.MustRegister(provider.NewGenericHTTPAdapter())
	p, err := prov.Create(ctx, domain.ProviderConfig{ID: "p", Name: "Test upstream", Adapter: provider.AdapterGenericHTTP, BaseURL: upstream.URL, AuthType: domain.AuthTypeNone, Enabled: true, Models: []domain.ModelConfig{{ID: "m", Name: "Model", APIFormat: format.FormatIDOpenAICompletions}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ls.SaveCachedProviders(ctx, []CachedProvider{{ID: p.ID, Name: p.Name, BaseURL: p.BaseURL, Adapter: p.Adapter, AuthType: p.AuthType, Enabled: true, Models: p.Models}}); err != nil {
		t.Fatal(err)
	}
	cloudRuntime, localRuntime := agent.NewGateway(store.NewAgentStore(db), gatewayDir, true), agent.NewDesktop(ls.Agent)
	reads := []string{"read"}
	withWrites := []string{"read", "write"}
	if _, err := cloudRuntime.UpdateSettings(ctx, agent.SettingsPatch{AllowedTools: &reads}); err != nil {
		t.Fatal(err)
	}
	if _, err := localRuntime.UpdateSettings(ctx, agent.SettingsPatch{DefaultDirectory: &localDir, AllowedTools: &withWrites}); err != nil {
		t.Fatal(err)
	}
	for _, repo := range []*store.ConversationStore{convs, ls.Conversations} {
		for _, id := range []string{"same", "cancel", "cloud-web", "chat"} {
			mode := "agent"
			if id == "chat" {
				mode = ""
			}
			if _, err := repo.Create(ctx, domain.Conversation{ID: id, ProviderID: p.ID, ModelID: "m", Mode: mode}); err != nil {
				t.Fatal(err)
			}
		}
	}
	chat := service.NewChatService(prov, convs, msgs, formats, adapters, nil).WithAgent(cloudRuntime)
	makeRouter := func(token string, runtime *agent.Runtime, chat *service.ChatService) http.Handler {
		return httpapi.NewRouter(httpapi.RouterDeps{Config: config.Config{AccessToken: token, DevMode: token == ""}, ConversationService: service.NewConversationService(convs, msgs), ChatService: chat, AgentRuntime: runtime})
	}
	cloudSrv := httptest.NewServer(makeRouter("gateway-token", cloudRuntime, chat))
	defer cloudSrv.Close()
	cloud := NewCloudClient(cloudSrv.URL, "gateway-token")
	engine := NewDesktopChatEngine(ls, cloud, nil, formats, adapters, nil, nil, nil)
	facade, err := NewServer(ServerConfig{Store: ls, Cloud: cloud, ChatEngine: engine})
	if err != nil {
		t.Fatal(err)
	}
	desktopSrv := httptest.NewServer(facade.Handler())
	defer desktopSrv.Close()
	request := func(base, token, method, path, body string) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	read := func(resp *http.Response, status int) string {
		t.Helper()
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != status {
			t.Fatalf("status %d want %d: %s, %v", resp.StatusCode, status, body, err)
		}
		return string(body)
	}
	stream := func(base, token, id, scope, text string) *http.Response {
		return request(base, token, "POST", "/api/v1/conversations/"+id+"/messages/stream"+scope, fmt.Sprintf(`{"text":%q}`, text))
	}
	check := func(text string, parts ...string) {
		t.Helper()
		for _, part := range parts {
			if !strings.Contains(text, part) {
				t.Fatalf("missing %q in %s", part, text)
			}
		}
	}
	check(read(stream(cloudSrv.URL, "gateway-token", "cloud-web", "", "test"), 200), "gateway-marker", "finished", `"toolSource":"native"`)
	check(read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=cloud", "test"), 200), "gateway-marker", "finished")
	check(read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=local", "test"), 200), "desktop-marker", "finished")
	check(read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=local", "allow-write"), 200), "created.txt", "finished")
	if data, err := os.ReadFile(filepath.Join(localDir, "created.txt")); err != nil || string(data) != "yes" {
		t.Fatalf("local write: %s %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(gatewayDir, "created.txt")); !os.IsNotExist(err) {
		t.Fatalf("cross-scope write: %v", err)
	}
	check(read(stream(cloudSrv.URL, "gateway-token", "same", "", "try-write"), 200), "unknown or disabled tool")
	check(read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=local", "fake-alias"), 200), "unknown or disabled tool")
	read(stream(cloudSrv.URL, "gateway-token", "chat", "", "try-write"), 200)
	read(stream(cloudSrv.URL, "", "same", "", "try-write"), 401)
	for _, dir := range []string{gatewayDir, localDir, outside} {
		if _, err := os.Stat(filepath.Join(dir, "forbidden.txt")); !os.IsNotExist(err) {
			t.Fatalf("unauthorized write: %v", err)
		}
	}
	noAuthRuntime := agent.NewGateway(store.NewAgentStore(db), gatewayDir, false)
	noAuth := httptest.NewServer(makeRouter("", noAuthRuntime, service.NewChatService(prov, convs, msgs, formats, adapters, nil).WithAgent(noAuthRuntime)))
	defer noAuth.Close()
	read(stream(noAuth.URL, "", "same", "", "try-write"), 401)
	base := "/api/v1/agent/"
	listing := read(request(desktopSrv.URL, facade.Token(), "GET", base+"directories?scope=cloud", ""), 200)
	check(listing, "sub")
	if strings.Contains(listing, "outside") {
		t.Fatalf("escaped listing: %s", listing)
	}
	read(request(cloudSrv.URL, "gateway-token", "GET", base+"directories?path=..", ""), 400)
	read(request(desktopSrv.URL, facade.Token(), "GET", base+"directories?scope=local", ""), 404)
	read(request(cloudSrv.URL, "gateway-token", "POST", "/api/v1/conversations/same/messages/prepare-local", `{"text":"try"}`), 400)
	read(request(cloudSrv.URL, "gateway-token", "POST", "/api/v1/conversations/same/tools/execute", `{"calls":[{"name":"write","id":"x"}]}`), 400)
	read(request(cloudSrv.URL, "gateway-token", "PUT", base+"conversations/same/directory", `{"path":"sub"}`), 200)
	localSub := filepath.Join(localDir, "sub")
	if _, err := localRuntime.UpdateTopic(ctx, "same", localSub); err != nil {
		t.Fatal(err)
	}
	syncSvc := NewSyncService(ls, cloud)
	batch, err := syncSvc.BatchTransfer(ctx, "upload", []string{"same"}, true)
	if err != nil || len(batch.Succeeded) != 1 {
		t.Fatalf("batch %+v: %v", batch, err)
	}
	up, err := cloudRuntime.TopicDirectory(ctx, "same")
	if err != nil || up.Path != "sub" || !up.Override {
		t.Fatalf("cloud override: %+v %v", up, err)
	}
	pulled, err := syncSvc.PullConversation(ctx, "same", true)
	if err != nil || pulled.Conversation.Mode != "agent" {
		t.Fatalf("pull mode: %s %v", pulled.Conversation.Mode, err)
	}
	local, err := localRuntime.TopicDirectory(ctx, "same")
	if err != nil || local.Path != localSub || !local.Override {
		t.Fatalf("local override: %+v %v", local, err)
	}
	if err := ls.Conversations.Delete(ctx, "same"); err != nil {
		t.Fatal(err)
	}
	if _, err := syncSvc.PullConversation(ctx, "same", false); err != nil {
		t.Fatal(err)
	}
	local, err = localRuntime.TopicDirectory(ctx, "same")
	if err != nil || local.Path != localDir || local.Override {
		t.Fatalf("new target inherits its own default: %+v %v", local, err)
	}
	if err := os.Remove(filepath.Join(gatewayDir, "sub")); err != nil {
		t.Fatal(err)
	}
	check(read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=cloud", "try-write"), 400), "Agent 工作目录不可用")
	check(read(request(cloudSrv.URL, "gateway-token", "GET", base+"conversations/same/directory", ""), 200), "unavailable", "sub")
	resp := stream(desktopSrv.URL, facade.Token(), "cancel", "?scope=cloud", "cancel-after-tool")
	buf := make([]byte, 4096)
	var events strings.Builder
	for !strings.Contains(events.String(), "gateway-marker") {
		n, err := resp.Body.Read(buf)
		events.Write(buf[:n])
		if err != nil {
			t.Fatalf("before cancellation: %v, %s", err, events.String())
		}
	}
	select {
	case <-entered:
	case <-time.After(4 * time.Second):
		t.Fatal("gateway did not open the continuation")
	}
	cloud.SetCredentials("", "")
	resp.Body.Close()
	select {
	case <-canceled:
	case <-time.After(4 * time.Second):
		t.Fatal("connection change did not cancel gateway upstream")
	}
	deadline := time.Now().Add(4 * time.Second)
	for {
		items, err := msgs.ListByConversation(ctx, "cancel")
		if err != nil {
			t.Fatal(err)
		}
		if len(items) == 2 {
			if items[1].StopReason != domain.StopReasonAborted {
				t.Fatalf("abort persisted as %q", items[1].StopReason)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("abort did not persist exactly once: %d messages", len(items))
		}
		time.Sleep(5 * time.Millisecond)
	}
	read(stream(desktopSrv.URL, facade.Token(), "same", "?scope=cloud", "try-write"), 401)
}

func TestDesktopCloudWorkspaceFileBrowserAndLargeSaveProxy(t *testing.T) {
	ctx := t.Context()
	gatewayDir := t.TempDir()
	largeText := strings.Repeat("line-of-text\n", 10000) // ~130 KiB > 64 KiB old limit
	if err := os.WriteFile(filepath.Join(gatewayDir, "notes.md"), []byte("# Initial"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gatewayDir, "pic.png"), []byte("png"), 0600); err != nil {
		t.Fatal(err)
	}

	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ls, err := OpenDesktopStore(ctx, filepath.Join(t.TempDir(), "desktop.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer ls.Close()

	cloudRuntime := agent.NewGateway(store.NewAgentStore(db), gatewayDir, true)
	cloudSrv := httptest.NewServer(httpapi.NewRouter(httpapi.RouterDeps{
		Config:       config.Config{AccessToken: "gw-tok"},
		AgentRuntime: cloudRuntime,
	}))
	defer cloudSrv.Close()

	cloud := NewCloudClient(cloudSrv.URL, "gw-tok")
	facade, err := NewServer(ServerConfig{Store: ls, Cloud: cloud})
	if err != nil {
		t.Fatal(err)
	}
	desktopSrv := httptest.NewServer(facade.Handler())
	defer desktopSrv.Close()

	doReq := func(method, path, body string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, desktopSrv.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+facade.Token())
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, data
	}

	// Local scope does not expose gateway workspace file browser.
	if st, _ := doReq("GET", "/api/v1/agent/workspace/entries?scope=local", ""); st != http.StatusNotFound {
		t.Fatalf("expected 404 for local workspace entries, got %d", st)
	}

	// Cloud scope lists entries and reads Markdown file.
	if st, body := doReq("GET", "/api/v1/agent/workspace/entries?scope=cloud", ""); st != http.StatusOK || !strings.Contains(string(body), "notes.md") {
		t.Fatalf("cloud entries status=%d body=%s", st, body)
	}
	st, fileBody := doReq("GET", "/api/v1/agent/workspace/file?scope=cloud&path=notes.md", "")
	if st != http.StatusOK {
		t.Fatalf("cloud file status=%d body=%s", st, fileBody)
	}
	var doc agent.WorkspaceFileDocument
	if err := json.Unmarshal(fileBody, &doc); err != nil {
		t.Fatal(err)
	}

	// Saving >64 KiB file through desktop cloud proxy succeeds.
	payload, _ := json.Marshal(map[string]string{
		"path":         "notes.md",
		"content":      largeText,
		"expectedEtag": doc.ETag,
	})
	if st, saveBody := doReq("PUT", "/api/v1/agent/workspace/file?scope=cloud", string(payload)); st != http.StatusOK {
		t.Fatalf("large save status=%d body=%s", st, saveBody)
	}
	disk, err := os.ReadFile(filepath.Join(gatewayDir, "notes.md"))
	if err != nil || string(disk) != largeText {
		t.Fatalf("disk content mismatch len=%d want=%d err=%v", len(disk), len(largeText), err)
	}

	// Stale ETag returns 409 CONFLICT through desktop proxy.
	conflictPayload, _ := json.Marshal(map[string]string{
		"path":         "notes.md",
		"content":      "stale",
		"expectedEtag": doc.ETag,
	})
	if st, _ := doReq("PUT", "/api/v1/agent/workspace/file?scope=cloud", string(conflictPayload)); st != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %d", st)
	}

	// Image preview returns 400.
	if st, body := doReq("GET", "/api/v1/agent/workspace/file?scope=cloud&path=pic.png", ""); st != http.StatusBadRequest || !strings.Contains(string(body), "图片暂不支持预览") {
		t.Fatalf("expected 400 image error, got %d %s", st, body)
	}
}
