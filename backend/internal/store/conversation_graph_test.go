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

func TestGraphBatchMutationsAndDeleteNodes(t *testing.T) {
	ctx := t.Context()
	db, err := OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	cs, ms := NewConversationStore(db), NewMessageStore(db)
	now := formatTime(time.Now().UTC())
	_, err = db.ExecContext(ctx, `INSERT INTO conversations (id, assistant_id, title, created_at, updated_at) VALUES ('legacy', ?, 'legacy', ?, ?)`, domain.DefaultAssistantID, now, now)
	must(err)
	_, err = db.ExecContext(ctx, `INSERT INTO messages (id, conversation_id, role, blocks_json, created_at) VALUES ('m1', 'legacy', 'user', '[]', ?)`, now)
	must(err)

	// Invalid target in deleteNodes must reject and roll back legacy materialization.
	err = cs.ApplyGraphMutation(ctx, "legacy", GraphMutationInput{Op: "deleteNodes", MessageIDs: []string{"m1", "missing"}})
	if app, ok := domain.AsAppError(err); !ok || app.Code != domain.ErrCodeInvalidArgument {
		t.Fatalf("expected invalid argument for missing message, got %v", err)
	}
	if c, e := cs.Get(ctx, "legacy"); e != nil || c.GraphState != nil {
		t.Fatalf("rejected deleteNodes must not materialize legacy conversation: %+v err=%v", c, e)
	}
	if _, e := ms.Get(ctx, "m1"); e != nil {
		t.Fatalf("rejected deleteNodes must not partially delete existing message: %v", e)
	}

	// Build chain a -> b -> c -> d plus branch attached to b and active branch attached to c.
	_, err = db.ExecContext(ctx, `INSERT INTO conversations (id, assistant_id, title, created_at, updated_at) VALUES ('g', ?, 'graph', ?, ?)`, domain.DefaultAssistantID, now, now)
	must(err)
	for _, id := range []string{"a", "b", "c", "d"} {
		_, err := db.ExecContext(ctx, `INSERT INTO messages (id, conversation_id, role, blocks_json, created_at) VALUES (?, 'g', 'user', '[]', ?)`, id, now)
		must(err)
	}
	get := func() domain.Conversation { t.Helper(); c, e := cs.Get(ctx, "g"); must(e); return c }
	getMsg := func(id string) domain.Message { t.Helper(); m, e := ms.Get(ctx, id); must(e); return m }
	mutate := func(in GraphMutationInput) { t.Helper(); must(cs.ApplyGraphMutation(ctx, "g", in)) }

	mutate(GraphMutationInput{Op: "createBranch", ParentMessageID: "b", Label: "B1"})
	mutate(GraphMutationInput{Op: "createBranch", ParentMessageID: "c", Label: "B2", Activate: true})
	conv := get()
	b1, b2 := conv.GraphState.Branches[0].ID, conv.GraphState.Branches[1].ID

	// Invalid branch ID rolls back without deleting messages.
	err = cs.ApplyGraphMutation(ctx, "g", GraphMutationInput{Op: "deleteNodes", MessageIDs: []string{"b"}, BranchIDs: []string{"no-such-branch"}})
	if app, ok := domain.AsAppError(err); !ok || app.Code != domain.ErrCodeInvalidArgument {
		t.Fatalf("expected invalid argument for missing branch, got %v", err)
	}
	if _, e := ms.Get(ctx, "b"); e != nil {
		t.Fatalf("rollback failed for message b: %v", e)
	}

	// Batch setNodeMeta collapsed on multiple user messages.
	collapsed := true
	mutate(GraphMutationInput{Op: "setNodeMeta", MessageIDs: []string{"a", "d", "a"}, GraphMeta: &GraphMetaPatch{Collapsed: &collapsed}})
	if !getMsg("a").GraphMeta.Collapsed || !getMsg("d").GraphMeta.Collapsed {
		t.Fatalf("batch setNodeMeta collapsed did not persist")
	}

	// Batch delete b and c: d and branch B1 must reconnect to surviving ancestor a; active branch B2 must also update.
	mutate(GraphMutationInput{Op: "deleteNodes", MessageIDs: []string{"b", "c", "b"}})
	if d := getMsg("d"); d.ParentID != "a" {
		t.Fatalf("expected d.ParentID == 'a', got %q", d.ParentID)
	}
	conv = get()
	if conv.GraphState.Branches[0].ParentMessageID != "a" || conv.GraphState.Branches[1].ParentMessageID != "a" {
		t.Fatalf("branches did not reconnect to surviving ancestor a: %+v", conv.GraphState.Branches)
	}
	if conv.GraphState.ActiveBranchID != b2 || conv.ActiveLeafID != "a" {
		t.Fatalf("active branch pointer not updated: activeBranch=%q activeLeaf=%q", conv.GraphState.ActiveBranchID, conv.ActiveLeafID)
	}

	// Batch reparent rejects non-empty parentId, succeeds for empty parentId.
	nonEmpty := "a"
	err = cs.ApplyGraphMutation(ctx, "g", GraphMutationInput{Op: "reparent", MessageIDs: []string{"d"}, ParentID: &nonEmpty})
	if app, ok := domain.AsAppError(err); !ok || app.Code != domain.ErrCodeInvalidArgument {
		t.Fatalf("expected invalid argument for batch reparent with non-empty parent, got %v", err)
	}
	empty := ""
	mutate(GraphMutationInput{Op: "reparent", MessageIDs: []string{"a", "d"}, ParentID: &empty})
	if getMsg("d").ParentID != "" {
		t.Fatalf("batch reparent disconnect failed: got %q", getMsg("d").ParentID)
	}

	// Deleting active branch B2 falls back ActiveBranchID to "" and ActiveLeafID to a surviving leaf.
	mutate(GraphMutationInput{Op: "deleteNodes", BranchIDs: []string{b2}})
	conv = get()
	if conv.GraphState.ActiveBranchID != "" || (conv.ActiveLeafID != "a" && conv.ActiveLeafID != "d") {
		t.Fatalf("deleting active branch did not fall back to surviving leaf: %+v", conv)
	}

	// Deleting all remaining messages and branch clears ActiveBranchID and ActiveLeafID.
	mutate(GraphMutationInput{Op: "deleteNodes", MessageIDs: []string{"a", "d"}, BranchIDs: []string{b1}})
	conv = get()
	if conv.GraphState.ActiveBranchID != "" || conv.ActiveLeafID != "" || len(conv.GraphState.Branches) != 0 {
		t.Fatalf("deleting all nodes did not clear active state: %+v", conv)
	}
}
