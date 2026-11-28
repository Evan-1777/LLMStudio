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

func TestConversationSearchStore(t *testing.T) {
	ctx := t.Context()
	db, err := OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cs, ms := NewConversationStore(db), NewMessageStore(db)
	as := NewAssistantStore(db)
	otherA, err := as.Create(ctx, domain.Assistant{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}

	g1, err := cs.CreateGroup(ctx, domain.DefaultAssistantID, "G1")
	if err != nil {
		t.Fatal(err)
	}
	cTitle, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "Alpha 架构设计", GroupID: &g1.ID})
	if err != nil {
		t.Fatal(err)
	}
	cBody, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "普通话题", Pinned: true})
	if err != nil {
		t.Fatal(err)
	}
	cSummary, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "摘要测试"})
	if err != nil {
		t.Fatal(err)
	}
	cNoise, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "噪声过滤"})
	if err != nil {
		t.Fatal(err)
	}
	cEph, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "Alpha 临时", Ephemeral: true})
	if err != nil {
		t.Fatal(err)
	}
	cOther, err := cs.Create(ctx, domain.Conversation{AssistantID: otherA.ID, Title: "Alpha 其他助手"})
	if err != nil {
		t.Fatal(err)
	}
	_ = cEph
	_ = cOther

	if _, err := ms.Create(ctx, domain.Message{
		ID: "m-body-old", ConversationID: cBody.ID, Role: domain.RoleUser,
		Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "早期的 alpha 内容"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ms.Create(ctx, domain.Message{
		ID: "m-body-new", ConversationID: cBody.ID, Role: domain.RoleAssistant,
		Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "最新的 ALPHA 方案说明与细节"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ms.Create(ctx, domain.Message{
		ID: "m-sum", ConversationID: cSummary.ID, Role: domain.RoleUser,
		Blocks:    []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "正文不含关键词"}},
		GraphMeta: &domain.MessageGraphMeta{Summary: "这是 alpha 摘要胶囊"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ms.Create(ctx, domain.Message{
		ID: "m-noise", ConversationID: cNoise.ID, Role: domain.RoleAssistant,
		Blocks: []domain.ContentBlock{
			{Type: domain.BlockTypeThinking, Thinking: "alpha in thinking"},
			{Type: domain.BlockTypeImage, MimeType: "image/png", Data: "YWxwaGEalphaBase64Data"},
			{Type: domain.BlockTypeToolCall, ID: "tc1", Name: "alpha_tool"},
			{Type: domain.BlockTypeToolResult, ToolCallID: "tc1", Content: "alpha tool output"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	hits, err := cs.Search(ctx, domain.DefaultAssistantID, "  ALPHA ")
	if err != nil {
		t.Fatal(err)
	}
	// Expected canonical order: pinned cBody -> grouped cTitle -> ungrouped cSummary; excludes cNoise, cEph, cOther.
	if len(hits) != 3 {
		t.Fatalf("expected 3 hits, got %d: %+v", len(hits), hits)
	}
	if hits[0].ConversationID != cBody.ID || hits[0].MatchType != "message" || hits[0].MessageID != "m-body-new" || !strings.Contains(hits[0].Snippet, "ALPHA") {
		t.Fatalf("unexpected hit[0]: %+v", hits[0])
	}
	if hits[1].ConversationID != cTitle.ID || hits[1].MatchType != "title" || hits[1].MessageID != "" {
		t.Fatalf("unexpected hit[1]: %+v", hits[1])
	}
	if hits[2].ConversationID != cSummary.ID || hits[2].MatchType != "message" || hits[2].MessageID != "m-sum" || !strings.Contains(hits[2].Snippet, "alpha") {
		t.Fatalf("unexpected hit[2]: %+v", hits[2])
	}
	// Empty query returns empty slice.
	emptyHits, err := cs.Search(ctx, domain.DefaultAssistantID, "   ")
	if err != nil || len(emptyHits) != 0 {
		t.Fatalf("empty query: hits=%+v err=%v", emptyHits, err)
	}
}

func TestGraphExpandedNotesEdgesSideRefsAndImport(t *testing.T) {
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
	conv, err := cs.Create(ctx, domain.Conversation{ID: "g2", AssistantID: domain.DefaultAssistantID, Title: "Graph V2"})
	must(err)
	createMsg := func(id, role, text string) {
		t.Helper()
		_, err := ms.Create(ctx, domain.Message{
			ID: id, ConversationID: conv.ID, Role: role,
			Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: text}},
		})
		must(err)
	}
	createMsg("u1", domain.RoleUser, "q1")
	createMsg("a1", domain.RoleAssistant, "ans1")
	createMsg("u2", domain.RoleUser, "q2")
	createMsg("a2", domain.RoleAssistant, "ans2")
	createMsg("u3", domain.RoleUser, "q3")
	createMsg("a3", domain.RoleAssistant, "ans3")
	createMsg("cp1", domain.RoleCompaction, "summary")

	get := func() domain.Conversation { t.Helper(); c, e := cs.Get(ctx, conv.ID); must(e); return c }
	getMsg := func(id string) domain.Message { t.Helper(); m, e := ms.Get(ctx, id); must(e); return m }
	mutate := func(in GraphMutationInput) { t.Helper(); must(cs.ApplyGraphMutation(ctx, conv.ID, in)) }

	// Fork u3 under a1 so (u3->a3) is a sibling branch of (u2->a2).
	forkParent := "a1"
	mutate(GraphMutationInput{Op: "reparent", MessageID: "u3", ParentID: &forkParent})

	// 1. Expanded persistence + collapsed:true auto-clears expanded.
	tVal, fVal := true, false
	mutate(GraphMutationInput{Op: "setNodeMeta", MessageIDs: []string{"u1", "a1"}, GraphMeta: &GraphMetaPatch{Expanded: &tVal}})
	if !getMsg("u1").GraphMeta.Expanded || !getMsg("a1").GraphMeta.Expanded {
		t.Fatalf("expanded not persisted")
	}
	mutate(GraphMutationInput{Op: "setNodeMeta", MessageID: "u1", GraphMeta: &GraphMetaPatch{Collapsed: &tVal}})
	if m := getMsg("u1"); !m.GraphMeta.Collapsed || m.GraphMeta.Expanded {
		t.Fatalf("collapsed:true did not clear expanded: %+v", m.GraphMeta)
	}
	mutate(GraphMutationInput{Op: "setNodeMeta", MessageID: "a1", GraphMeta: &GraphMetaPatch{Expanded: &fVal}})
	if m := getMsg("a1"); m.GraphMeta != nil && m.GraphMeta.Expanded {
		t.Fatalf("expanded=false not persisted")
	}

	// 2. Notes CRUD & position updates.
	nx, ny := 120.0, 240.0
	mutate(GraphMutationInput{Op: "createNote", Text: "  标注内容  ", X: &nx, Y: &ny})
	notes := get().GraphState.Notes
	if len(notes) != 1 || notes[0].Text != "标注内容" || *notes[0].X != nx {
		t.Fatalf("createNote failed: %+v", notes)
	}
	noteID := notes[0].ID
	mutate(GraphMutationInput{Op: "updateNote", NoteID: noteID, Text: "更新后标注"})
	if get().GraphState.Notes[0].Text != "更新后标注" {
		t.Fatalf("updateNote failed")
	}
	nx2, ny2 := 300.0, 400.0
	mutate(GraphMutationInput{Op: "setNodeMeta", Positions: []GraphPosition{{NoteID: noteID, X: &nx2, Y: &ny2}}})
	if *get().GraphState.Notes[0].X != nx2 || *get().GraphState.Notes[0].Y != ny2 {
		t.Fatalf("note position update failed")
	}

	// 3. NoteEdges CRUD & validation (must involve at least one note).
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "createNoteEdge", SourceID: "u1", SourcePort: "right", TargetID: "a1", TargetPort: "left",
	}); err == nil {
		t.Fatal("expected non-note edge to fail")
	}
	mutate(GraphMutationInput{Op: "createNoteEdge", SourceID: noteID, SourcePort: "right", TargetID: "a2", TargetPort: "left"})
	// Idempotent port update on same endpoints.
	mutate(GraphMutationInput{Op: "createNoteEdge", SourceID: noteID, SourcePort: "bottom", TargetID: "a2", TargetPort: "top"})
	edges := get().GraphState.NoteEdges
	if len(edges) != 1 || edges[0].SourcePort != "bottom" || edges[0].TargetPort != "top" {
		t.Fatalf("createNoteEdge idempotent update failed: %+v", edges)
	}
	edgeID := edges[0].ID
	mutate(GraphMutationInput{Op: "deleteNoteEdge", EdgeID: edgeID})
	if len(get().GraphState.NoteEdges) != 0 {
		t.Fatalf("deleteNoteEdge failed")
	}
	mutate(GraphMutationInput{Op: "createNoteEdge", SourceID: noteID, SourcePort: "left", TargetID: "a3", TargetPort: "right"})

	// 4. SideRefs validation: reject compaction target, reject parent ancestor, reject joint DAG cycle.
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{Op: "addSideRef", MessageID: "cp1", SourceMessageID: "a3"}); err == nil {
		t.Fatal("expected compaction target to be rejected")
	}
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{Op: "addSideRef", MessageID: "a2", SourceMessageID: "a1"}); err == nil {
		t.Fatal("expected direct ancestor sideRef to be rejected")
	}
	mutate(GraphMutationInput{Op: "addSideRef", MessageID: "a2", SourceMessageID: "a3", Side: "left"})
	mutate(GraphMutationInput{Op: "addSideRef", MessageID: "a2", SourceMessageID: "a3", Side: "right"})
	if refs := getMsg("a2").GraphMeta.SideRefs; len(refs) != 1 || refs[0].Side != "right" {
		t.Fatalf("addSideRef idempotent side update failed: %+v", refs)
	}
	// Joint DAG cycle via addSideRef: a2 -> a3, now a3 -> a2 must fail.
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{Op: "addSideRef", MessageID: "a3", SourceMessageID: "a2"}); err == nil {
		t.Fatal("expected sideRef cycle to be rejected")
	}
	// Joint DAG cycle via reparent: u3 is ancestor of a3, a2 side-refs a3, so reparenting u3 under a2 creates a cycle!
	cycleParent := "a2"
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{Op: "reparent", MessageID: "u3", ParentID: &cycleParent}); err == nil {
		t.Fatal("expected reparent joint cycle to be rejected")
	}

	// 5. ImportConversation round-trip preserves expanded, notes, noteEdges, sideRefs.
	convSnap := get()
	msgsSnap, err := ms.ListByConversation(ctx, conv.ID)
	must(err)
	convSnap.ID = "g2-imported"
	for i := range msgsSnap {
		msgsSnap[i].ID = "imp-" + msgsSnap[i].ID
		msgsSnap[i].ConversationID = convSnap.ID
		if msgsSnap[i].ParentID != "" {
			msgsSnap[i].ParentID = "imp-" + msgsSnap[i].ParentID
		}
		if msgsSnap[i].GraphMeta != nil {
			for j := range msgsSnap[i].GraphMeta.SideRefs {
				msgsSnap[i].GraphMeta.SideRefs[j].SourceMessageID = "imp-" + msgsSnap[i].GraphMeta.SideRefs[j].SourceMessageID
			}
		}
	}
	if convSnap.ActiveLeafID != "" {
		convSnap.ActiveLeafID = "imp-" + convSnap.ActiveLeafID
	}
	importedConv, _, err := cs.ImportConversation(ctx, convSnap, msgsSnap, true)
	must(err)
	if len(importedConv.GraphState.Notes) != 1 || len(importedConv.GraphState.NoteEdges) != 1 {
		t.Fatalf("ImportConversation lost notes/edges: %+v", importedConv.GraphState)
	}
	impA2, err := ms.Get(ctx, "imp-a2")
	must(err)
	if impA2.GraphMeta == nil || len(impA2.GraphMeta.SideRefs) != 1 || impA2.GraphMeta.SideRefs[0].SourceMessageID != "imp-a3" {
		t.Fatalf("ImportConversation lost sideRefs: %+v", impA2.GraphMeta)
	}

	// 6. Cascade cleanup: deleting a3 via DeleteByID clears a2's sideRef and noteEdge pointing to a3.
	must(ms.DeleteByID(ctx, conv.ID, "a3"))
	if m := getMsg("a2"); m.GraphMeta != nil && len(m.GraphMeta.SideRefs) != 0 {
		t.Fatalf("DeleteByID did not cascade clean sideRefs: %+v", m.GraphMeta.SideRefs)
	}
	if len(get().GraphState.NoteEdges) != 0 {
		t.Fatalf("DeleteByID did not cascade clean noteEdges: %+v", get().GraphState.NoteEdges)
	}

	// 7. Mixed deleteNodes removes note + message atomically.
	mutate(GraphMutationInput{Op: "deleteNodes", MessageIDs: []string{"u3"}, NoteIDs: []string{noteID}})
	if len(get().GraphState.Notes) != 0 {
		t.Fatalf("deleteNodes did not remove note")
	}
}

func TestGraphCreateMessageAndNodeSideRefScope(t *testing.T) {
	ctx := t.Context()
	db, err := OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cs, ms := NewConversationStore(db), NewMessageStore(db)
	conv, err := cs.Create(ctx, domain.Conversation{AssistantID: domain.DefaultAssistantID, Title: "graph"})
	if err != nil {
		t.Fatal(err)
	}
	root, err := ms.Create(ctx, domain.Message{ConversationID: conv.ID, Role: domain.RoleUser, Blocks: []domain.ContentBlock{{Type: domain.BlockTypeText, Text: "root"}}})
	if err != nil {
		t.Fatal(err)
	}
	x, y := 42.0, 76.0
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "createMessage", Role: domain.RoleAssistant, Text: "created text", ParentMessageID: root.ID, X: &x, Y: &y,
	}); err != nil {
		t.Fatalf("createMessage: %v", err)
	}
	items, err := ms.ListByConversation(ctx, conv.ID)
	if err != nil || len(items) != 2 {
		t.Fatalf("expected created message, got %d err=%v", len(items), err)
	}
	created := items[1]
	if created.Role != domain.RoleAssistant || created.ParentID != root.ID || created.Blocks[0].Text != "created text" ||
		created.GraphMeta == nil || *created.GraphMeta.X != x || *created.GraphMeta.Y != y {
		t.Fatalf("unexpected created message: %+v", created)
	}
	if got, _ := cs.Get(ctx, conv.ID); got.ActiveLeafID != created.ID {
		t.Fatalf("creating after the active leaf must advance ActiveLeafID: %+v", got)
	}
	for _, bad := range []GraphMutationInput{
		{Op: "createMessage", Role: "system", Text: "x"},
		{Op: "createMessage", Role: domain.RoleUser, Text: "   "},
		{Op: "createMessage", Role: domain.RoleUser, Text: "x", ParentMessageID: "missing"},
	} {
		if err := cs.ApplyGraphMutation(ctx, conv.ID, bad); err == nil {
			t.Fatalf("expected %+v to be rejected", bad)
		}
	}
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "createMessage", Role: domain.RoleUser, Text: "independent",
	}); err != nil {
		t.Fatalf("create independent message: %v", err)
	}
	items, err = ms.ListByConversation(ctx, conv.ID)
	if err != nil || len(items) != 3 {
		t.Fatalf("expected independent message, got %d err=%v", len(items), err)
	}
	source := items[2]
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "addSideRef", MessageID: root.ID, SourceMessageID: source.ID, Side: "right", Scope: domain.SideRefScopeNode,
	}); err != nil {
		t.Fatalf("add node side ref: %v", err)
	}
	rootMsg, err := ms.Get(ctx, root.ID)
	if err != nil || rootMsg.GraphMeta == nil || len(rootMsg.GraphMeta.SideRefs) != 1 || rootMsg.GraphMeta.SideRefs[0].Scope != domain.SideRefScopeNode {
		t.Fatalf("node scope not persisted: %+v err=%v", rootMsg.GraphMeta, err)
	}
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "addSideRef", MessageID: root.ID, SourceMessageID: source.ID, Side: "left",
	}); err != nil {
		t.Fatalf("switch back to branch scope: %v", err)
	}
	rootMsg, _ = ms.Get(ctx, root.ID)
	if len(rootMsg.GraphMeta.SideRefs) != 1 || rootMsg.GraphMeta.SideRefs[0].Scope != "" || rootMsg.GraphMeta.SideRefs[0].Side != "left" {
		t.Fatalf("branch scope normalization failed: %+v", rootMsg.GraphMeta.SideRefs)
	}
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "addSideRef", MessageID: root.ID, SourceMessageID: source.ID, Scope: "weird",
	}); err == nil {
		t.Fatal("expected invalid scope to be rejected")
	}

	// Activating a blank branch leaves ActiveLeafID empty; creating an independent
	// message must not silently clear the active branch.
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{Op: "createBranch", Activate: true}); err != nil {
		t.Fatalf("create blank active branch: %v", err)
	}
	blank, err := cs.Get(ctx, conv.ID)
	if err != nil || blank.GraphState.ActiveBranchID == "" || blank.ActiveLeafID != "" {
		t.Fatalf("expected blank active branch, got %+v err=%v", blank.GraphState, err)
	}
	branchID := blank.GraphState.ActiveBranchID
	if err := cs.ApplyGraphMutation(ctx, conv.ID, GraphMutationInput{
		Op: "createMessage", Role: domain.RoleUser, Text: "standalone",
	}); err != nil {
		t.Fatalf("create independent message under blank branch: %v", err)
	}
	after, err := cs.Get(ctx, conv.ID)
	if err != nil || after.GraphState.ActiveBranchID != branchID || after.ActiveLeafID != "" {
		t.Fatalf("creating an independent message must preserve the active blank branch: %+v err=%v", after.GraphState, err)
	}
}
