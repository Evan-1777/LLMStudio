package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/service"
	"llmstudio/backend/internal/store"
)

func TestGroupReorderUsesAssistantScopeAndPersists(t *testing.T) {
	const endpoint = "/api/v1/conversation-groups/reorder"
	const token = "test-token"
	const aid = domain.DefaultAssistantID
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "organization.db")
	db, err := store.OpenSQLite(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { db.Close() }()
	convs := store.NewConversationStore(db)
	assistants := store.NewAssistantStore(db)
	other, err := service.NewAssistantService(assistants).Create(ctx, service.AssistantInput{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	group := func(assistant, name string) domain.ConversationGroup {
		t.Helper()
		g, err := convs.CreateGroup(ctx, assistant, name)
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	a, b, c := group(aid, "A"), group(aid, "Empty"), group(aid, "C")
	otherGroup := group(other.ID, "Other group")
	create := func(title string, gid *string, pinned bool) domain.Conversation {
		t.Helper()
		v, err := convs.Create(ctx, domain.Conversation{AssistantID: aid, Title: title, GroupID: gid, Pinned: pinned})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	first, second, third := create("A1", &a.ID, false), create("A2", &a.ID, false), create("C1", &c.ID, false)
	pinned, ungrouped := create("Pinned", &a.ID, true), create("Ungrouped", nil, false)
	original, err := convs.ListByAssistant(ctx, aid)
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(RouterDeps{
		Config:              config.Config{AccessToken: token},
		ConversationService: service.NewConversationService(convs, store.NewMessageStore(db)).WithAssistants(assistants),
	})
	move := func(auth, assistant, id string, anchor *string, status int) service.OrganizationSnapshot {
		t.Helper()
		rec := doJSONReq(t, router, http.MethodPost, endpoint, auth, service.ReorderGroupsInput{AssistantID: assistant, ID: id, BeforeID: anchor})
		if rec.Code != status {
			t.Fatalf("status %d, want %d: %s", rec.Code, status, rec.Body.String())
		}
		var snap service.OrganizationSnapshot
		if status == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
				t.Fatal(err)
			}
		}
		return snap
	}
	move("", aid, c.ID, &a.ID, 401)
	move(token, "", c.ID, &a.ID, 400)
	move(token, aid, "", &a.ID, 400)
	move(token, aid, otherGroup.ID, &a.ID, 404)
	move(token, aid, c.ID, &otherGroup.ID, 404)
	missing := "missing"
	move(token, aid, c.ID, &missing, 404)
	current, err := convs.ListGroups(ctx, aid)
	if err != nil || !reflect.DeepEqual(current, []domain.ConversationGroup{a, b, c}) {
		t.Fatalf("invalid request changed order: %v, %v", current, err)
	}
	// A no-op must not write even when positions have gaps.
	if _, err := db.ExecContext(ctx, "UPDATE conversation_groups SET sort_order = sort_order + 10 WHERE assistant_id = ?", aid); err != nil {
		t.Fatal(err)
	}
	snap := move(token, aid, a.ID, &b.ID, 200)
	if snap.Groups[0].SortOrder != a.SortOrder+10 {
		t.Fatal("same position unexpectedly rewrote ranks")
	}
	snap = move(token, aid, c.ID, &a.ID, 200)
	if snap.AssistantID != aid || len(snap.Groups) != 3 || snap.Groups[0].ID != c.ID || snap.Groups[1].ID != a.ID || snap.Groups[2].ID != b.ID {
		t.Fatalf("unexpected group order: %+v", snap.Groups)
	}
	got := make([]string, 0, len(snap.Conversations))
	for _, v := range snap.Conversations {
		got = append(got, v.ID)
		i := slices.IndexFunc(original, func(o domain.Conversation) bool { return o.ID == v.ID })
		if i < 0 || !reflect.DeepEqual(original[i], v) {
			t.Fatalf("reorder changed conversation %s", v.ID)
		}
	}
	if !slices.Equal(got, []string{pinned.ID, third.ID, second.ID, first.ID, ungrouped.ID}) {
		t.Fatalf("unexpected canonical conversation order: %v", got)
	}
	move(token, aid, c.ID, nil, 200)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = store.OpenSQLite(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	convs = store.NewConversationStore(db)
	persisted, err := convs.ListGroups(ctx, aid)
	if err != nil || len(persisted) != 3 || persisted[0].ID != a.ID || persisted[1].ID != b.ID || persisted[2].ID != c.ID {
		t.Fatalf("reopened order: %v, %v", persisted, err)
	}
	isolated, err := convs.ListGroups(ctx, other.ID)
	if err != nil || !reflect.DeepEqual(isolated, []domain.ConversationGroup{otherGroup}) {
		t.Fatalf("other assistant changed: %v, %v", isolated, err)
	}
}

func TestCleanupUngroupedDeletesOnlyCurrentUngroupedTopicsAndMessages(t *testing.T) {
	const token = "test-token"
	const endpoint = "/api/v1/conversations/cleanup-ungrouped"
	ctx := context.Background()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	convs := store.NewConversationStore(db)
	messages := store.NewMessageStore(db)
	assistants := store.NewAssistantStore(db)
	other, err := service.NewAssistantService(assistants).Create(ctx, service.AssistantInput{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	router := NewRouter(RouterDeps{
		Config:              config.Config{AccessToken: token},
		ConversationService: service.NewConversationService(convs, messages).WithAssistants(assistants),
	})
	var groups []domain.ConversationGroup
	var deleted, kept []domain.Conversation
	for _, assistant := range []string{domain.DefaultAssistantID, other.ID} {
		group, err := convs.CreateGroup(ctx, assistant, "Keep group")
		if err != nil {
			t.Fatal(err)
		}
		groups = append(groups, group)
		add := func(name string, id *string, pinned bool) domain.Conversation {
			t.Helper()
			c, err := convs.Create(ctx, domain.Conversation{AssistantID: assistant, Title: name, GroupID: id, Pinned: pinned})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := messages.Create(ctx, domain.Message{ConversationID: c.ID, Role: domain.RoleUser}); err != nil {
				t.Fatal(err)
			}
			return c
		}
		deleted = append(deleted, add("unfiled", nil, false))
		kept = append(kept, add("grouped", &group.ID, false), add("pinned", nil, true), add("grouped pin", &group.ID, true))
		moved := add("recently moved", nil, false)
		pinned := add("recently pinned", nil, false)
		if err := convs.BatchMove(ctx, assistant, []string{moved.ID}, &group.ID); err != nil {
			t.Fatal(err)
		}
		if err := convs.BatchPin(ctx, assistant, []string{pinned.ID}, true); err != nil {
			t.Fatal(err)
		}
		kept = append(kept, moved, pinned)
	}
	count := func(query, id string, want int) {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, query, id).Scan(&n); err != nil || n != want {
			t.Fatalf("%s: count=%d, want %d: %v", id, n, want, err)
		}
	}
	const countTopics = "SELECT COUNT(*) FROM conversations WHERE id = ?"
	const countMessages = "SELECT COUNT(*) FROM messages WHERE conversation_id = ?"
	if rec := doJSONReq(t, router, http.MethodPost, endpoint, "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", rec.Code)
	}
	for _, c := range deleted {
		count(countTopics, c.ID, 1)
		count(countMessages, c.ID, 1)
	}
	rec := doJSONReq(t, router, http.MethodPost, endpoint, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("cleanup status %d: %s", rec.Code, rec.Body.String())
	}
	var response struct{ Deleted []domain.DeletedConversation }
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Deleted) != len(deleted) {
		t.Fatalf("unexpected result: %v", response.Deleted)
	}
	for _, c := range deleted {
		if !slices.Contains(response.Deleted, domain.DeletedConversation{ID: c.ID, AssistantID: c.AssistantID}) {
			t.Fatalf("missing deletion of %s", c.ID)
		}
		count(countTopics, c.ID, 0)
		count(countMessages, c.ID, 0)
	}
	for _, c := range kept {
		count(countTopics, c.ID, 1)
		count(countMessages, c.ID, 1)
	}
	for _, g := range groups {
		after, err := convs.GetGroup(ctx, g.ID)
		if err != nil || after != g {
			t.Fatalf("group changed: %v", err)
		}
	}
	rec = doJSONReq(t, router, http.MethodPost, endpoint, token, nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"deleted\":[]}\n" {
		t.Fatalf("repeat cleanup: %d %s", rec.Code, rec.Body.String())
	}
}
