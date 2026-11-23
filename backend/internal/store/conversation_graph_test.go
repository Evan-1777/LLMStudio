package store

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"llmstudio/backend/internal/domain"
)

func TestGraphUpgradeAndMutations(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.ExecContext(ctx, `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
	must(err)
	entries, err := migrationFS.ReadDir("migrations")
	must(err)
	for _, entry := range entries {
		if entry.Name() >= "018" {
			break
		}
		body, err := migrationFS.ReadFile("migrations/" + entry.Name())
		must(err)
		_, err = db.ExecContext(ctx, string(body))
		must(err)
		_, err = db.ExecContext(ctx, `INSERT INTO schema_migrations VALUES (?, '')`, entry.Name())
		must(err)
	}
	now := formatTime(time.Now().UTC())
	_, err = db.ExecContext(ctx, `INSERT INTO conversations (id, assistant_id, title, created_at, updated_at) VALUES ('c', ?, 'old', ?, ?)`, domain.DefaultAssistantID, now, now)
	must(err)
	for _, id := range []string{"a", "b", "c"} {
		_, err := db.ExecContext(ctx, `INSERT INTO messages (id, conversation_id, role, blocks_json, created_at) VALUES (?, 'c', 'user', '[]', ?)`, id, now)
		must(err)
	}
	must(RunMigrations(ctx, db))
	must(RunMigrations(ctx, db))
	cs, ms := NewConversationStore(db), NewMessageStore(db)
	get := func() domain.Conversation { t.Helper(); c, e := cs.Get(ctx, "c"); must(e); return c }
	getMessage := func(id string) domain.Message { t.Helper(); m, e := ms.Get(ctx, id); must(e); return m }
	mutate := func(in GraphMutationInput) { t.Helper(); must(cs.ApplyGraphMutation(ctx, "c", in)) }
	if get().GraphState != nil || getMessage("b").ParentID != "" {
		t.Fatal("migration eagerly materialized legacy topic")
	}
	for _, parent := range []string{"a", "c"} {
		err := cs.ApplyGraphMutation(ctx, "c", GraphMutationInput{Op: "reparent", MessageID: "a", ParentID: &parent})
		if app, ok := domain.AsAppError(err); !ok || app.Code != domain.ErrCodeInvalidArgument || !strings.Contains(app.Message, "不能形成循环") {
			t.Fatalf("parent %q: %v", parent, err)
		}
	}
	if get().GraphState != nil {
		t.Fatal("rejected mutation must roll back materialization")
	}
	mutate(GraphMutationInput{Op: "createBranch", Activate: true})
	conv := get()
	root := conv.GraphState.Branches[0]
	if root.Label != "分支 1" || conv.ActiveLeafID != "" || conv.GraphState.ActiveBranchID != root.ID || getMessage("b").ParentID != "a" || getMessage("c").ParentID != "b" {
		t.Fatalf("invalid materialization: %+v", conv)
	}
	mutate(GraphMutationInput{Op: "createBranch", ParentMessageID: "b"})
	branch := get().GraphState.Branches[1]
	mutate(GraphMutationInput{Op: "activateBranch", BranchID: branch.ID})
	if c := get(); c.ActiveLeafID != "b" || c.GraphState.ActiveBranchID != branch.ID {
		t.Fatalf("branch activation: %+v", c)
	}
	summary, collapsed, x, y := "summary", true, 0.0, 35.0
	mutate(GraphMutationInput{Op: "setNodeMeta", MessageID: "b", GraphMeta: &GraphMetaPatch{Collapsed: &collapsed, Summary: &summary}, Positions: []GraphPosition{{MessageID: "b", X: &x, Y: &y}, {BranchID: branch.ID, X: &x, Y: &y}}})
	if b := getMessage("b"); !b.GraphMeta.Collapsed || b.GraphMeta.Summary != summary || *b.GraphMeta.X != x || *b.GraphMeta.Y != y || *get().GraphState.Branches[1].Y != y {
		t.Fatalf("metadata omitted: %+v", b)
	}
	parent := "a"
	mutate(GraphMutationInput{Op: "reparent", MessageID: "c", ParentID: &parent})
	parent = "b"
	mutate(GraphMutationInput{Op: "reparent", MessageID: "c", ParentID: &parent})
	if getMessage("c").ParentID != "b" {
		t.Fatal("reparent did not persist")
	}
	must(ms.DeleteByID(ctx, "c", "b"))
	if c := get(); c.ActiveLeafID != "a" || c.GraphState.Branches[1].ParentMessageID != "a" || getMessage("c").ParentID != "a" {
		t.Fatalf("delete did not reconnect graph: %+v", c)
	}
	mutate(GraphMutationInput{Op: "deleteBranch", BranchID: branch.ID})
	if c := get(); c.GraphState.ActiveBranchID != "" || c.ActiveLeafID != "c" {
		t.Fatalf("bad fallback: %+v", c)
	}
	mutate(GraphMutationInput{Op: "activateBranch", BranchID: root.ID})
	empty := ""
	m, err := ms.Create(ctx, domain.Message{ID: "new", ConversationID: "c", Role: domain.RoleUser, GraphWrite: &domain.MessageGraphWrite{ParentID: &empty, ConsumeBranchID: root.ID}})
	must(err)
	if c := get(); m.ParentID != "" || len(c.GraphState.Branches) != 0 || c.ActiveLeafID != m.ID || c.GraphState.ActiveBranchID != "" {
		t.Fatalf("branch consumption: %+v", c)
	}
}
