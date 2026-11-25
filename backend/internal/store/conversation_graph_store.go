package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
)

type GraphMutationInput struct {
	Op              string          `json:"op"`
	MessageID       string          `json:"messageId,omitempty"`
	MessageIDs      []string        `json:"messageIds,omitempty"`
	BranchIDs       []string        `json:"branchIds,omitempty"`
	NoteIDs         []string        `json:"noteIds,omitempty"`
	ParentID        *string         `json:"parentId,omitempty"`
	GraphMeta       *GraphMetaPatch `json:"graphMeta,omitempty"`
	Collapsed       *bool           `json:"collapsed,omitempty"`
	Expanded        *bool           `json:"expanded,omitempty"`
	Summary         *string         `json:"summary,omitempty"`
	Positions       []GraphPosition `json:"positions,omitempty"`
	ParentMessageID string          `json:"parentMessageId,omitempty"`
	Label           string          `json:"label,omitempty"`
	X               *float64        `json:"x,omitempty"`
	Y               *float64        `json:"y,omitempty"`
	Activate        bool            `json:"activate,omitempty"`
	BranchID        string          `json:"branchId,omitempty"`
	LeafMessageID   string          `json:"leafMessageId,omitempty"`
	NoteID          string          `json:"noteId,omitempty"`
	Text            string          `json:"text,omitempty"`
	EdgeID          string          `json:"edgeId,omitempty"`
	SourceID        string          `json:"sourceId,omitempty"`
	SourcePort      string          `json:"sourcePort,omitempty"`
	TargetID        string          `json:"targetId,omitempty"`
	TargetPort      string          `json:"targetPort,omitempty"`
	SourceMessageID string          `json:"sourceMessageId,omitempty"`
	Side            string          `json:"side,omitempty"`
}

type GraphMetaPatch struct {
	Collapsed *bool    `json:"collapsed,omitempty"`
	Expanded  *bool    `json:"expanded,omitempty"`
	Summary   *string  `json:"summary,omitempty"`
	X         *float64 `json:"x,omitempty"`
	Y         *float64 `json:"y,omitempty"`
}

type GraphPosition struct {
	MessageID string   `json:"messageId,omitempty"`
	BranchID  string   `json:"branchId,omitempty"`
	NoteID    string   `json:"noteId,omitempty"`
	X         *float64 `json:"x"`
	Y         *float64 `json:"y"`
}

func graphConversationTx(ctx context.Context, tx *sql.Tx, id string) (domain.Conversation, error) {
	c, err := scanConversation(tx.QueryRowContext(ctx, `SELECT `+conversationSelectCols+` FROM conversations c WHERE c.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, domain.NewError(domain.ErrCodeNotFound, "conversation not found", err)
	}
	return c, err
}

func ensureGraphMaterializedTx(ctx context.Context, tx *sql.Tx, id string) (domain.Conversation, error) {
	c, err := graphConversationTx(ctx, tx, id)
	if err != nil || graphEnabled(c) {
		return c, err
	}
	// Materialize the same deterministic order used by ListByConversation.
	_, err = tx.ExecContext(ctx, `WITH ordered AS MATERIALIZED (
		SELECT id, LAG(id, 1, '') OVER (ORDER BY created_at, rowid) parent
		FROM messages WHERE conversation_id = ?
	) UPDATE messages SET parent_id = ordered.parent FROM ordered WHERE messages.id = ordered.id`, id)
	if err != nil {
		return c, err
	}
	c.ActiveLeafID, err = newestGraphMessageTx(ctx, tx, id, false)
	c.GraphState = &domain.ConversationGraphState{Enabled: true, Branches: []domain.ConversationBranchSlot{}}
	return c, err
}

func graphEnabled(c domain.Conversation) bool {
	return c.GraphState != nil && c.GraphState.Enabled
}

func newestGraphMessageTx(ctx context.Context, tx *sql.Tx, id string, leafOnly bool) (string, error) {
	var newest string
	err := tx.QueryRowContext(ctx, `SELECT m.id FROM messages m WHERE m.conversation_id = ?
		AND (NOT ? OR NOT EXISTS (SELECT 1 FROM messages child WHERE child.conversation_id = m.conversation_id AND child.parent_id = m.id))
		ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`, id, leafOnly).Scan(&newest)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return newest, err
}

func saveGraphStateTx(ctx context.Context, tx *sql.Tx, c domain.Conversation) error {
	data, err := json.Marshal(c.GraphState)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE conversations SET active_leaf_id = ?, graph_state_json = ?, updated_at = MAX(updated_at, ?) WHERE id = ?`,
		c.ActiveLeafID, string(data), formatTime(time.Now().UTC()), c.ID)
	return err
}

func graphMessageTx(ctx context.Context, tx *sql.Tx, conversationID, messageID string) (domain.Message, error) {
	m, err := scanMessage(tx.QueryRowContext(ctx, `SELECT `+messageSelectCols+` FROM messages WHERE conversation_id = ? AND id = ?`, conversationID, messageID))
	if errors.Is(err, sql.ErrNoRows) {
		return m, invalidGraph("消息不在当前话题中")
	}
	return m, err
}

func invalidGraph(message string) error {
	return domain.NewError(domain.ErrCodeInvalidArgument, message, nil)
}

func branchIndex(state *domain.ConversationGraphState, id string) int {
	return slices.IndexFunc(state.Branches, func(slot domain.ConversationBranchSlot) bool { return slot.ID == id })
}

func noteIndex(state *domain.ConversationGraphState, id string) int {
	return slices.IndexFunc(state.Notes, func(n domain.ConversationGraphNote) bool { return n.ID == id })
}

func validNotePort(port string) bool {
	return port == "top" || port == "bottom" || port == "left" || port == "right"
}

func normalizeNoteText(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", invalidGraph("标注内容不能为空")
	}
	if len([]rune(text)) > 4000 {
		return "", invalidGraph("标注内容不能超过 4000 字")
	}
	return text, nil
}

func loadGraphDependenciesTx(ctx context.Context, tx *sql.Tx, conversationID string) (map[string]string, map[string][]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, parent_id, graph_meta_json FROM messages WHERE conversation_id = ?`, conversationID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	parentOf := make(map[string]string)
	sideRefsOf := make(map[string][]string)
	for rows.Next() {
		var mid, pid, metaRaw string
		if err := rows.Scan(&mid, &pid, &metaRaw); err != nil {
			return nil, nil, err
		}
		parentOf[mid] = pid
		if metaRaw != "" && metaRaw != "null" && metaRaw != "{}" {
			var meta domain.MessageGraphMeta
			if json.Unmarshal([]byte(metaRaw), &meta) == nil && len(meta.SideRefs) > 0 {
				refs := make([]string, 0, len(meta.SideRefs))
				for _, ref := range meta.SideRefs {
					if ref.SourceMessageID != "" {
						refs = append(refs, ref.SourceMessageID)
					}
				}
				if len(refs) > 0 {
					sideRefsOf[mid] = refs
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return parentOf, sideRefsOf, nil
}

func isReachableInDepGraph(parentOf map[string]string, sideRefsOf map[string][]string, startID, targetID string) bool {
	if startID == "" || targetID == "" {
		return false
	}
	visited := map[string]bool{startID: true}
	queue := []string{startID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == targetID {
			return true
		}
		if p := parentOf[cur]; p != "" && !visited[p] {
			visited[p] = true
			queue = append(queue, p)
		}
		for _, src := range sideRefsOf[cur] {
			if src != "" && !visited[src] {
				visited[src] = true
				queue = append(queue, src)
			}
		}
	}
	return false
}

func pruneNoteEdges(state *domain.ConversationGraphState, deleted map[string]bool) {
	if state == nil || len(state.NoteEdges) == 0 || len(deleted) == 0 {
		return
	}
	kept := state.NoteEdges[:0]
	for _, edge := range state.NoteEdges {
		if deleted[edge.SourceID] || deleted[edge.TargetID] {
			continue
		}
		kept = append(kept, edge)
	}
	if len(kept) == 0 {
		state.NoteEdges = nil
	} else {
		state.NoteEdges = kept
	}
}

func pruneSideRefsTx(ctx context.Context, tx *sql.Tx, conversationID string, deletedMsgs map[string]bool) error {
	if len(deletedMsgs) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, graph_meta_json FROM messages WHERE conversation_id = ? AND graph_meta_json != '' AND graph_meta_json != '{}' AND graph_meta_json != 'null'`, conversationID)
	if err != nil {
		return err
	}
	type updateItem struct {
		id   string
		meta domain.MessageGraphMeta
	}
	var updates []updateItem
	for rows.Next() {
		var mid, metaRaw string
		if err := rows.Scan(&mid, &metaRaw); err != nil {
			rows.Close()
			return err
		}
		var meta domain.MessageGraphMeta
		if json.Unmarshal([]byte(metaRaw), &meta) != nil || len(meta.SideRefs) == 0 {
			continue
		}
		kept := make([]domain.MessageSideRef, 0, len(meta.SideRefs))
		changed := false
		for _, ref := range meta.SideRefs {
			if deletedMsgs[ref.SourceMessageID] {
				changed = true
				continue
			}
			kept = append(kept, ref)
		}
		if changed {
			if len(kept) == 0 {
				meta.SideRefs = nil
			} else {
				meta.SideRefs = kept
			}
			updates = append(updates, updateItem{id: mid, meta: meta})
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, u := range updates {
		data, err := json.Marshal(&u.meta)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE messages SET graph_meta_json = ? WHERE conversation_id = ? AND id = ?`, string(data), conversationID, u.id); err != nil {
			return err
		}
	}
	return nil
}

func dedupeNonEmpty(ids []string) []string {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func fallbackGraphLeafTx(ctx context.Context, tx *sql.Tx, conversationID string) (string, error) {
	leaf, err := newestGraphMessageTx(ctx, tx, conversationID, true)
	if err != nil || leaf != "" {
		return leaf, err
	}
	return newestGraphMessageTx(ctx, tx, conversationID, false)
}

func (s *ConversationStore) ApplyGraphMutation(ctx context.Context, id string, in GraphMutationInput) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	c, err := ensureGraphMaterializedTx(ctx, tx, id)
	if err != nil {
		return err
	}
	switch in.Op {
	case "reparent":
		err = applyGraphReparentTx(ctx, tx, id, in)
	case "setNodeMeta":
		err = applyGraphSetNodeMetaTx(ctx, tx, id, c.GraphState, in)
	case "deleteNodes":
		err = applyGraphDeleteNodesTx(ctx, tx, id, &c, in)
	case "createBranch", "deleteBranch", "activateBranch":
		err = applyGraphBranchMutationTx(ctx, tx, id, &c, in)
	case "createNote", "updateNote", "createNoteEdge", "deleteNoteEdge":
		err = applyGraphNoteMutationTx(ctx, tx, id, c.GraphState, in)
	case "addSideRef", "removeSideRef":
		err = applyGraphSideRefMutationTx(ctx, tx, id, in)
	default:
		return invalidGraph("不支持的图谱操作")
	}
	if err != nil {
		return err
	}
	if err := saveGraphStateTx(ctx, tx, c); err != nil {
		return err
	}
	return tx.Commit()
}

func applyGraphReparentTx(ctx context.Context, tx *sql.Tx, id string, in GraphMutationInput) error {
	if in.ParentID == nil {
		return invalidGraph("缺少 parentId")
	}
	if len(in.MessageIDs) > 0 {
		if *in.ParentID != "" {
			return invalidGraph("批量重连仅支持断开上下文")
		}
		msgIDs := dedupeNonEmpty(in.MessageIDs)
		if len(msgIDs) == 0 {
			return invalidGraph("请选择要操作的节点")
		}
		for _, mid := range msgIDs {
			if _, err := graphMessageTx(ctx, tx, id, mid); err != nil {
				return err
			}
		}
		for _, mid := range msgIDs {
			if _, err := tx.ExecContext(ctx, `UPDATE messages SET parent_id = '' WHERE conversation_id = ? AND id = ?`, id, mid); err != nil {
				return err
			}
		}
		return nil
	}
	if _, err := graphMessageTx(ctx, tx, id, in.MessageID); err != nil {
		return err
	}
	if *in.ParentID != "" {
		parentOf, sideRefsOf, err := loadGraphDependenciesTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, ok := parentOf[*in.ParentID]; !ok {
			return invalidGraph("父消息不在当前话题中")
		}
		if *in.ParentID == in.MessageID || isReachableInDepGraph(parentOf, sideRefsOf, *in.ParentID, in.MessageID) {
			return invalidGraph("不能形成循环上下文连接")
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE messages SET parent_id = ? WHERE id = ?`, *in.ParentID, in.MessageID)
	return err
}

func applyGraphSetNodeMetaTx(ctx context.Context, tx *sql.Tx, id string, state *domain.ConversationGraphState, in GraphMutationInput) error {
	if in.GraphMeta == nil && (in.Collapsed != nil || in.Expanded != nil || in.Summary != nil || in.X != nil || in.Y != nil) {
		in.GraphMeta = &GraphMetaPatch{Collapsed: in.Collapsed, Expanded: in.Expanded, Summary: in.Summary, X: in.X, Y: in.Y}
	}
	if in.GraphMeta == nil && len(in.Positions) == 0 {
		return invalidGraph("缺少节点元数据或坐标")
	}
	if in.GraphMeta != nil {
		if len(in.MessageIDs) > 0 {
			msgIDs := dedupeNonEmpty(in.MessageIDs)
			if len(msgIDs) == 0 {
				return invalidGraph("请选择要操作的节点")
			}
			for _, mid := range msgIDs {
				if err := updateGraphMetaTx(ctx, tx, id, mid, *in.GraphMeta); err != nil {
					return err
				}
			}
		} else {
			if err := updateGraphMetaTx(ctx, tx, id, in.MessageID, *in.GraphMeta); err != nil {
				return err
			}
		}
	}
	for _, pos := range in.Positions {
		targets := 0
		if pos.MessageID != "" {
			targets++
		}
		if pos.BranchID != "" {
			targets++
		}
		if pos.NoteID != "" {
			targets++
		}
		if targets != 1 || pos.X == nil || pos.Y == nil {
			return invalidGraph("节点坐标缺少目标或坐标")
		}
		if pos.MessageID != "" {
			if err := updateGraphMetaTx(ctx, tx, id, pos.MessageID, GraphMetaPatch{X: pos.X, Y: pos.Y}); err != nil {
				return err
			}
		} else if pos.BranchID != "" {
			if i := branchIndex(state, pos.BranchID); i >= 0 {
				state.Branches[i].X, state.Branches[i].Y = pos.X, pos.Y
			} else {
				return invalidGraph("话题内分支不存在")
			}
		} else if i := noteIndex(state, pos.NoteID); i >= 0 {
			state.Notes[i].X, state.Notes[i].Y = pos.X, pos.Y
		} else {
			return invalidGraph("文字标注不存在")
		}
	}
	return nil
}

func applyGraphDeleteNodesTx(ctx context.Context, tx *sql.Tx, id string, c *domain.Conversation, in GraphMutationInput) error {
	state := c.GraphState
	msgIDs := dedupeNonEmpty(in.MessageIDs)
	branchIDs := dedupeNonEmpty(in.BranchIDs)
	noteIDs := dedupeNonEmpty(in.NoteIDs)
	if len(msgIDs) == 0 && len(branchIDs) == 0 && len(noteIDs) == 0 {
		return invalidGraph("请选择要删除的节点")
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, parent_id FROM messages WHERE conversation_id = ?`, id)
	if err != nil {
		return err
	}
	parentOf := make(map[string]string)
	allMsgIDs := make([]string, 0)
	for rows.Next() {
		var mid, pid string
		if err := rows.Scan(&mid, &pid); err != nil {
			rows.Close()
			return err
		}
		parentOf[mid] = pid
		allMsgIDs = append(allMsgIDs, mid)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	deleteMsgSet := make(map[string]bool, len(msgIDs))
	for _, mid := range msgIDs {
		if _, ok := parentOf[mid]; !ok {
			return invalidGraph("消息不在当前话题中")
		}
		deleteMsgSet[mid] = true
	}
	deleteBranchSet := make(map[string]bool, len(branchIDs))
	for _, bid := range branchIDs {
		if branchIndex(state, bid) < 0 {
			return invalidGraph("话题内分支不存在")
		}
		deleteBranchSet[bid] = true
	}
	deleteNoteSet := make(map[string]bool, len(noteIDs))
	for _, nid := range noteIDs {
		if noteIndex(state, nid) < 0 {
			return invalidGraph("文字标注不存在")
		}
		deleteNoteSet[nid] = true
	}
	survivingAncestor := func(start string) string {
		seen := make(map[string]bool)
		for cur := start; cur != ""; {
			if !deleteMsgSet[cur] {
				return cur
			}
			if seen[cur] {
				return ""
			}
			seen[cur] = true
			cur = parentOf[cur]
		}
		return ""
	}
	for _, mid := range allMsgIDs {
		if deleteMsgSet[mid] {
			continue
		}
		if parent := parentOf[mid]; parent != "" && deleteMsgSet[parent] {
			if _, err := tx.ExecContext(ctx, `UPDATE messages SET parent_id = ? WHERE conversation_id = ? AND id = ?`, survivingAncestor(parent), id, mid); err != nil {
				return err
			}
		}
	}
	for _, mid := range msgIDs {
		if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE conversation_id = ? AND id = ?`, id, mid); err != nil {
			return err
		}
	}
	if err := pruneSideRefsTx(ctx, tx, id, deleteMsgSet); err != nil {
		return err
	}
	remaining := make([]domain.ConversationBranchSlot, 0, len(state.Branches))
	for _, slot := range state.Branches {
		if deleteBranchSet[slot.ID] {
			continue
		}
		if slot.ParentMessageID != "" && deleteMsgSet[slot.ParentMessageID] {
			slot.ParentMessageID = survivingAncestor(slot.ParentMessageID)
		}
		remaining = append(remaining, slot)
	}
	state.Branches = remaining
	if len(deleteNoteSet) > 0 {
		keptNotes := make([]domain.ConversationGraphNote, 0, len(state.Notes))
		for _, note := range state.Notes {
			if !deleteNoteSet[note.ID] {
				keptNotes = append(keptNotes, note)
			}
		}
		if len(keptNotes) == 0 {
			state.Notes = nil
		} else {
			state.Notes = keptNotes
		}
	}
	deletedAll := make(map[string]bool, len(deleteMsgSet)+len(deleteBranchSet)+len(deleteNoteSet))
	for k := range deleteMsgSet {
		deletedAll[k] = true
	}
	for k := range deleteBranchSet {
		deletedAll[k] = true
	}
	for k := range deleteNoteSet {
		deletedAll[k] = true
	}
	pruneNoteEdges(state, deletedAll)
	if state.ActiveBranchID != "" {
		if deleteBranchSet[state.ActiveBranchID] {
			state.ActiveBranchID = ""
			c.ActiveLeafID, err = fallbackGraphLeafTx(ctx, tx, id)
			if err != nil {
				return err
			}
		} else if i := branchIndex(state, state.ActiveBranchID); i >= 0 {
			c.ActiveLeafID = state.Branches[i].ParentMessageID
		}
	} else if c.ActiveLeafID != "" && deleteMsgSet[c.ActiveLeafID] {
		next := survivingAncestor(c.ActiveLeafID)
		if next == "" {
			next, err = fallbackGraphLeafTx(ctx, tx, id)
			if err != nil {
				return err
			}
		}
		c.ActiveLeafID = next
	}
	return nil
}

func applyGraphBranchMutationTx(ctx context.Context, tx *sql.Tx, id string, c *domain.Conversation, in GraphMutationInput) error {
	state := c.GraphState
	switch in.Op {
	case "createBranch":
		if in.ParentMessageID != "" {
			if _, err := graphMessageTx(ctx, tx, id, in.ParentMessageID); err != nil {
				return err
			}
		}
		label := in.Label
		if label == "" {
			labels := make(map[string]bool, len(state.Branches))
			for _, slot := range state.Branches {
				labels[slot.Label] = true
			}
			for n := 1; ; n++ {
				label = "分支 " + strconv.Itoa(n)
				if !labels[label] {
					break
				}
			}
		}
		slot := domain.ConversationBranchSlot{ID: domain.NewUUID(), Label: label, ParentMessageID: in.ParentMessageID, X: in.X, Y: in.Y, CreatedAt: time.Now().UTC()}
		state.Branches = append(state.Branches, slot)
		if in.Activate {
			state.ActiveBranchID, c.ActiveLeafID = slot.ID, slot.ParentMessageID
		}
	case "deleteBranch":
		i := branchIndex(state, in.BranchID)
		if i < 0 {
			return invalidGraph("话题内分支不存在")
		}
		state.Branches = slices.Delete(state.Branches, i, i+1)
		pruneNoteEdges(state, map[string]bool{in.BranchID: true})
		if state.ActiveBranchID == in.BranchID {
			state.ActiveBranchID = ""
			var err error
			c.ActiveLeafID, err = newestGraphMessageTx(ctx, tx, id, true)
			if err != nil {
				return err
			}
		}
	case "activateBranch":
		if (in.BranchID == "") == (in.LeafMessageID == "") {
			return invalidGraph("请选择一个分支目标")
		}
		if in.BranchID != "" {
			i := branchIndex(state, in.BranchID)
			if i < 0 {
				return invalidGraph("话题内分支不存在")
			}
			state.ActiveBranchID, c.ActiveLeafID = in.BranchID, state.Branches[i].ParentMessageID
		} else {
			if _, err := graphMessageTx(ctx, tx, id, in.LeafMessageID); err != nil {
				return err
			}
			state.ActiveBranchID, c.ActiveLeafID = "", in.LeafMessageID
		}
	}
	return nil
}

func applyGraphNoteMutationTx(ctx context.Context, tx *sql.Tx, id string, state *domain.ConversationGraphState, in GraphMutationInput) error {
	switch in.Op {
	case "createNote":
		text, err := normalizeNoteText(in.Text)
		if err != nil {
			return err
		}
		state.Notes = append(state.Notes, domain.ConversationGraphNote{
			ID:        domain.NewUUID(),
			Text:      text,
			X:         in.X,
			Y:         in.Y,
			CreatedAt: time.Now().UTC(),
		})
	case "updateNote":
		i := noteIndex(state, in.NoteID)
		if i < 0 {
			return invalidGraph("文字标注不存在")
		}
		text, err := normalizeNoteText(in.Text)
		if err != nil {
			return err
		}
		state.Notes[i].Text = text
	case "createNoteEdge":
		if in.SourceID == "" || in.TargetID == "" || in.SourceID == in.TargetID {
			return invalidGraph("标注连线端点无效")
		}
		if !validNotePort(in.SourcePort) || !validNotePort(in.TargetPort) {
			return invalidGraph("标注连线端口无效")
		}
		sourceIsNote := noteIndex(state, in.SourceID) >= 0
		targetIsNote := noteIndex(state, in.TargetID) >= 0
		if !sourceIsNote && !targetIsNote {
			return invalidGraph("标注连线至少一端必须为文字标注")
		}
		nodeExists := func(nodeID string) (bool, error) {
			if noteIndex(state, nodeID) >= 0 || branchIndex(state, nodeID) >= 0 {
				return true, nil
			}
			var found string
			err := tx.QueryRowContext(ctx, `SELECT id FROM messages WHERE conversation_id = ? AND id = ?`, id, nodeID).Scan(&found)
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			return err == nil, err
		}
		if ok, err := nodeExists(in.SourceID); err != nil {
			return err
		} else if !ok {
			return invalidGraph("连线源节点不在当前话题中")
		}
		if ok, err := nodeExists(in.TargetID); err != nil {
			return err
		} else if !ok {
			return invalidGraph("连线目标节点不在当前话题中")
		}
		updated := false
		for i := range state.NoteEdges {
			e := &state.NoteEdges[i]
			if (e.SourceID == in.SourceID && e.TargetID == in.TargetID) || (e.SourceID == in.TargetID && e.TargetID == in.SourceID) {
				e.SourceID = in.SourceID
				e.SourcePort = in.SourcePort
				e.TargetID = in.TargetID
				e.TargetPort = in.TargetPort
				updated = true
				break
			}
		}
		if !updated {
			state.NoteEdges = append(state.NoteEdges, domain.ConversationGraphNoteEdge{
				ID:         domain.NewUUID(),
				SourceID:   in.SourceID,
				SourcePort: in.SourcePort,
				TargetID:   in.TargetID,
				TargetPort: in.TargetPort,
			})
		}
	case "deleteNoteEdge":
		if in.EdgeID == "" {
			return invalidGraph("缺少标注连线 ID")
		}
		idx := slices.IndexFunc(state.NoteEdges, func(e domain.ConversationGraphNoteEdge) bool { return e.ID == in.EdgeID })
		if idx < 0 {
			return invalidGraph("标注连线不存在")
		}
		state.NoteEdges = slices.Delete(state.NoteEdges, idx, idx+1)
		if len(state.NoteEdges) == 0 {
			state.NoteEdges = nil
		}
	}
	return nil
}

func applyGraphSideRefMutationTx(ctx context.Context, tx *sql.Tx, id string, in GraphMutationInput) error {
	switch in.Op {
	case "addSideRef":
		if in.MessageID == "" || in.SourceMessageID == "" {
			return invalidGraph("缺少目标或源消息")
		}
		if in.MessageID == in.SourceMessageID {
			return invalidGraph("不能形成循环上下文连接")
		}
		side := strings.TrimSpace(in.Side)
		if side == "" {
			side = "left"
		}
		if side != "left" && side != "right" {
			return invalidGraph("侧边接入方向仅支持 left 或 right")
		}
		targetMsg, err := graphMessageTx(ctx, tx, id, in.MessageID)
		if err != nil {
			return err
		}
		if targetMsg.Role != domain.RoleUser && targetMsg.Role != domain.RoleAssistant {
			return invalidGraph("仅支持向用户或助手消息接入侧边分支")
		}
		if _, err := graphMessageTx(ctx, tx, id, in.SourceMessageID); err != nil {
			return err
		}
		parentOf, sideRefsOf, err := loadGraphDependenciesTx(ctx, tx, id)
		if err != nil {
			return err
		}
		seenAnc := map[string]bool{in.MessageID: true}
		for cur := parentOf[in.MessageID]; cur != ""; {
			if cur == in.SourceMessageID {
				return invalidGraph("该节点已在当前主干上下文中")
			}
			if seenAnc[cur] {
				break
			}
			seenAnc[cur] = true
			cur = parentOf[cur]
		}
		if isReachableInDepGraph(parentOf, sideRefsOf, in.SourceMessageID, in.MessageID) {
			return invalidGraph("不能形成循环上下文连接")
		}
		if targetMsg.GraphMeta == nil {
			targetMsg.GraphMeta = &domain.MessageGraphMeta{}
		}
		existingIdx := slices.IndexFunc(targetMsg.GraphMeta.SideRefs, func(r domain.MessageSideRef) bool {
			return r.SourceMessageID == in.SourceMessageID
		})
		if existingIdx >= 0 {
			targetMsg.GraphMeta.SideRefs[existingIdx].Side = side
		} else {
			targetMsg.GraphMeta.SideRefs = append(targetMsg.GraphMeta.SideRefs, domain.MessageSideRef{
				SourceMessageID: in.SourceMessageID,
				Side:            side,
			})
		}
		data, err := json.Marshal(targetMsg.GraphMeta)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE messages SET graph_meta_json = ? WHERE conversation_id = ? AND id = ?`, string(data), id, targetMsg.ID)
		return err
	case "removeSideRef":
		targetMsg, err := graphMessageTx(ctx, tx, id, in.MessageID)
		if err != nil {
			return err
		}
		if targetMsg.GraphMeta == nil || len(targetMsg.GraphMeta.SideRefs) == 0 {
			return nil
		}
		if in.SourceMessageID == "" {
			targetMsg.GraphMeta.SideRefs = nil
		} else {
			kept := make([]domain.MessageSideRef, 0, len(targetMsg.GraphMeta.SideRefs))
			for _, ref := range targetMsg.GraphMeta.SideRefs {
				if ref.SourceMessageID != in.SourceMessageID {
					kept = append(kept, ref)
				}
			}
			if len(kept) == 0 {
				targetMsg.GraphMeta.SideRefs = nil
			} else {
				targetMsg.GraphMeta.SideRefs = kept
			}
		}
		data, err := json.Marshal(targetMsg.GraphMeta)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE messages SET graph_meta_json = ? WHERE conversation_id = ? AND id = ?`, string(data), id, targetMsg.ID)
		return err
	}
	return nil
}

func appendGraphMessageTx(ctx context.Context, tx *sql.Tx, c *domain.Conversation, m *domain.Message) error {
	opts := m.GraphWrite
	if !graphEnabled(*c) {
		if opts != nil && (opts.ConsumeBranchID != "" || opts.ParentID != nil && *opts.ParentID != "") {
			return invalidGraph("当前话题尚未启用图谱")
		}
		return nil
	}
	state := c.GraphState
	parent, consume := c.ActiveLeafID, state.ActiveBranchID
	if opts != nil {
		if opts.ParentID != nil {
			parent = *opts.ParentID
		}
		consume = opts.ConsumeBranchID
	} else if m.ParentID != "" {
		parent, consume = m.ParentID, ""
	}
	if consume != "" {
		i := branchIndex(state, consume)
		if i < 0 {
			return invalidGraph("话题内分支不存在")
		}
		slot := state.Branches[i]
		if opts != nil && opts.ParentID != nil && parent != slot.ParentMessageID {
			return invalidGraph("分支父消息已变更")
		}
		parent = slot.ParentMessageID
		if m.Role == domain.RoleCompaction {
			state.Branches[i].ParentMessageID = m.ID
		} else {
			state.Branches = slices.Delete(state.Branches, i, i+1)
		}
	}
	if parent != "" {
		if _, err := graphMessageTx(ctx, tx, c.ID, parent); err != nil {
			return err
		}
	}
	m.ParentID = parent
	if state.ActiveBranchID == consume && c.ActiveLeafID == parent {
		c.ActiveLeafID = m.ID
		if m.Role != domain.RoleCompaction {
			state.ActiveBranchID = ""
		}
	}
	return saveGraphStateTx(ctx, tx, *c)
}

// Splice only the selected path: siblings retain their existing contexts.
func spliceActiveGraphPathTx(ctx context.Context, tx *sql.Tx, c domain.Conversation, afterID, nextID string) error {
	if c.ActiveLeafID == afterID {
		c.ActiveLeafID = nextID
		if i := branchIndex(c.GraphState, c.GraphState.ActiveBranchID); i >= 0 {
			c.GraphState.Branches[i].ParentMessageID = nextID
		}
		return saveGraphStateTx(ctx, tx, c)
	}
	// UNION also terminates on a corrupt imported cycle.
	var childID string
	err := tx.QueryRowContext(ctx, `WITH RECURSIVE path(id, parent_id) AS (
		SELECT id, parent_id FROM messages WHERE conversation_id = ? AND id = ?
		UNION SELECT m.id, m.parent_id FROM messages m JOIN path ON m.id = path.parent_id WHERE m.conversation_id = ?
	) SELECT id FROM path WHERE parent_id = ? LIMIT 1`, c.ID, c.ActiveLeafID, c.ID, afterID).Scan(&childID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE messages SET parent_id = ? WHERE id = ?`, nextID, childID)
	return err
}

func reconnectGraphChildrenTx(ctx context.Context, tx *sql.Tx, c domain.Conversation, id, parentID string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE messages SET parent_id = ? WHERE conversation_id = ? AND parent_id = ?`, parentID, c.ID, id); err != nil {
		return err
	}
	if err := pruneSideRefsTx(ctx, tx, c.ID, map[string]bool{id: true}); err != nil {
		return err
	}
	pruneNoteEdges(c.GraphState, map[string]bool{id: true})
	for i, slot := range c.GraphState.Branches {
		if slot.ParentMessageID == id {
			c.GraphState.Branches[i].ParentMessageID = parentID
		}
	}
	if c.ActiveLeafID == id {
		c.ActiveLeafID = parentID
		if parentID == "" && c.GraphState.ActiveBranchID == "" {
			newest, err := newestGraphMessageTx(ctx, tx, c.ID, false)
			if err != nil {
				return err
			}
			c.ActiveLeafID = newest
		}
	}
	return saveGraphStateTx(ctx, tx, c)
}

func updateGraphMetaTx(ctx context.Context, tx *sql.Tx, id, messageID string, patch GraphMetaPatch) error {
	m, err := graphMessageTx(ctx, tx, id, messageID)
	if err != nil {
		return err
	}
	if m.GraphMeta == nil {
		m.GraphMeta = &domain.MessageGraphMeta{}
	}
	if patch.Collapsed != nil && m.Role == domain.RoleUser {
		m.GraphMeta.Collapsed = *patch.Collapsed
		if *patch.Collapsed && (patch.Expanded == nil || !*patch.Expanded) {
			m.GraphMeta.Expanded = false
		}
	}
	if patch.Expanded != nil {
		m.GraphMeta.Expanded = *patch.Expanded
	}
	if patch.Summary != nil {
		m.GraphMeta.Summary = *patch.Summary
	}
	if patch.X != nil {
		m.GraphMeta.X = patch.X
	}
	if patch.Y != nil {
		m.GraphMeta.Y = patch.Y
	}
	data, err := json.Marshal(m.GraphMeta)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE messages SET graph_meta_json = ? WHERE id = ?`, string(data), messageID)
	return err
}
