package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"time"

	"llmstudio/backend/internal/domain"
)

type GraphMutationInput struct {
	Op              string          `json:"op"`
	MessageID       string          `json:"messageId,omitempty"`
	ParentID        *string         `json:"parentId,omitempty"`
	GraphMeta       *GraphMetaPatch `json:"graphMeta,omitempty"`
	Collapsed       *bool           `json:"collapsed,omitempty"`
	Summary         *string         `json:"summary,omitempty"`
	Positions       []GraphPosition `json:"positions,omitempty"`
	ParentMessageID string          `json:"parentMessageId,omitempty"`
	Label           string          `json:"label,omitempty"`
	X               *float64        `json:"x,omitempty"`
	Y               *float64        `json:"y,omitempty"`
	Activate        bool            `json:"activate,omitempty"`
	BranchID        string          `json:"branchId,omitempty"`
	LeafMessageID   string          `json:"leafMessageId,omitempty"`
}

type GraphMetaPatch struct {
	Collapsed *bool    `json:"collapsed,omitempty"`
	Summary   *string  `json:"summary,omitempty"`
	X         *float64 `json:"x,omitempty"`
	Y         *float64 `json:"y,omitempty"`
}

type GraphPosition struct {
	MessageID string   `json:"messageId,omitempty"`
	BranchID  string   `json:"branchId,omitempty"`
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
	state := c.GraphState
	switch in.Op {
	case "reparent":
		if in.ParentID == nil {
			return invalidGraph("缺少 parentId")
		}
		if _, err := graphMessageTx(ctx, tx, id, in.MessageID); err != nil {
			return err
		}
		seen := map[string]bool{in.MessageID: true}
		for parent := *in.ParentID; parent != ""; {
			if seen[parent] {
				return invalidGraph("不能形成循环上下文连接")
			}
			seen[parent] = true
			err := tx.QueryRowContext(ctx, `SELECT parent_id FROM messages WHERE conversation_id = ? AND id = ?`, id, parent).Scan(&parent)
			if errors.Is(err, sql.ErrNoRows) {
				return invalidGraph("父消息不在当前话题中")
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE messages SET parent_id = ? WHERE id = ?`, *in.ParentID, in.MessageID); err != nil {
			return err
		}
	case "setNodeMeta":
		if in.GraphMeta == nil && (in.Collapsed != nil || in.Summary != nil || in.X != nil || in.Y != nil) {
			in.GraphMeta = &GraphMetaPatch{Collapsed: in.Collapsed, Summary: in.Summary, X: in.X, Y: in.Y}
		}
		if in.GraphMeta == nil && len(in.Positions) == 0 {
			return invalidGraph("缺少节点元数据或坐标")
		}
		if in.GraphMeta != nil {
			if err := updateGraphMetaTx(ctx, tx, id, in.MessageID, *in.GraphMeta); err != nil {
				return err
			}
		}
		for _, pos := range in.Positions {
			if (pos.MessageID == "") == (pos.BranchID == "") || pos.X == nil || pos.Y == nil {
				return invalidGraph("节点坐标缺少目标或坐标")
			}
			if pos.MessageID != "" {
				if err := updateGraphMetaTx(ctx, tx, id, pos.MessageID, GraphMetaPatch{X: pos.X, Y: pos.Y}); err != nil {
					return err
				}
			} else if i := branchIndex(state, pos.BranchID); i >= 0 {
				state.Branches[i].X, state.Branches[i].Y = pos.X, pos.Y
			} else {
				return invalidGraph("话题内分支不存在")
			}
		}
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
		if state.ActiveBranchID == in.BranchID {
			state.ActiveBranchID = ""
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
	default:
		return invalidGraph("不支持的图谱操作")
	}
	if err := saveGraphStateTx(ctx, tx, c); err != nil {
		return err
	}
	return tx.Commit()
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
