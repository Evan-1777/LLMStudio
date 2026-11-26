package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"

	"llmstudio/backend/internal/domain"
)

func bucketKeyOf(groupID *string) string {
	if groupID == nil {
		return ""
	}
	return *groupID
}

func nullableString(p *string) sql.NullString {
	if p == nil || *p == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: *p, Valid: true}
}

func scanConversationGroup(row rowScanner) (domain.ConversationGroup, error) {
	var (
		g          domain.ConversationGroup
		createdRaw string
	)
	if err := row.Scan(&g.ID, &g.AssistantID, &g.Name, &g.SortOrder, &createdRaw); err != nil {
		return domain.ConversationGroup{}, err
	}
	var err error
	if g.CreatedAt, err = parseTime(createdRaw); err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("parse conversation group created_at: %w", err)
	}
	return g, nil
}

// ListGroups returns conversation groups filtered by assistantID when non-empty.
func (s *ConversationStore) ListGroups(ctx context.Context, assistantID string) ([]domain.ConversationGroup, error) {
	return listGroups(ctx, s.db, assistantID)
}

func listGroups(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, assistantID string) ([]domain.ConversationGroup, error) {
	query := `
		SELECT id, assistant_id, name, sort_order, created_at
		FROM conversation_groups
	`
	var args []any
	if assistantID != "" {
		query += ` WHERE assistant_id = ?`
		args = append(args, assistantID)
	}
	query += ` ORDER BY sort_order ASC, created_at ASC, id ASC`

	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list conversation groups: %w", err)
	}
	defer rows.Close()

	groups := make([]domain.ConversationGroup, 0)
	for rows.Next() {
		g, err := scanConversationGroup(rows)
		if err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate conversation groups: %w", err)
	}
	return groups, nil
}

// ReorderGroups changes only the positions of groups that belong to assistantID.
func (s *ConversationStore) ReorderGroups(ctx context.Context, assistantID, id string, beforeID *string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	groups, err := listGroups(ctx, tx, assistantID)
	if err != nil {
		return err
	}
	index := func(id string) int {
		return slices.IndexFunc(groups, func(g domain.ConversationGroup) bool { return g.ID == id })
	}
	from := index(id)
	if from < 0 {
		return domain.NewError(domain.ErrCodeNotFound, "group not found for assistant", nil)
	}
	to := len(groups)
	if beforeID != nil {
		to = index(*beforeID)
		if to < 0 {
			return domain.NewError(domain.ErrCodeNotFound, "anchor group not found for assistant", nil)
		}
	}
	if from < to {
		to--
	}
	if from == to {
		return nil
	}
	moved := groups[from]
	groups = slices.Insert(slices.Delete(groups, from, from+1), to, moved)
	for i, group := range groups {
		if group.SortOrder == i+1 {
			continue
		}
		if _, err := tx.ExecContext(ctx, "UPDATE conversation_groups SET sort_order = ? WHERE assistant_id = ? AND id = ?", i+1, assistantID, group.ID); err != nil {
			return fmt.Errorf("reorder groups: %w", err)
		}
	}
	return tx.Commit()
}

// GetGroup fetches a conversation group by ID.
func (s *ConversationStore) GetGroup(ctx context.Context, id string) (domain.ConversationGroup, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, assistant_id, name, sort_order, created_at
		FROM conversation_groups
		WHERE id = ?
	`, id)
	g, err := scanConversationGroup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ConversationGroup{}, domain.NewError(domain.ErrCodeNotFound, "conversation group not found", err)
	}
	if err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("get conversation group %s: %w", id, err)
	}
	return g, nil
}

// CreateGroup creates a new single-level conversation group for assistantID.
func (s *ConversationStore) CreateGroup(ctx context.Context, assistantID, name string) (domain.ConversationGroup, error) {
	id := domain.NewUUID()
	now := time.Now().UTC()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("begin create group tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var nextOrder int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(sort_order), 0) + 1 FROM conversation_groups WHERE assistant_id = ?
	`, assistantID).Scan(&nextOrder); err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("compute group sort_order: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO conversation_groups (id, assistant_id, name, sort_order, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, id, assistantID, name, nextOrder, formatTime(now)); err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("insert conversation group: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("commit create group tx: %w", err)
	}
	return s.GetGroup(ctx, id)
}

// RenameGroup updates a group's name while preserving its ID and order.
func (s *ConversationStore) RenameGroup(ctx context.Context, id, name string) (domain.ConversationGroup, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE conversation_groups SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("rename conversation group %s: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return domain.ConversationGroup{}, fmt.Errorf("rows affected rename group %s: %w", id, err)
	}
	if affected == 0 {
		return domain.ConversationGroup{}, domain.NewError(domain.ErrCodeNotFound, "conversation group not found", nil)
	}
	return s.GetGroup(ctx, id)
}

// DeleteGroup deletes a group while retaining all conversations: unpinned items move to the tail
// of ungrouped in their relative order, and pinned items keep their pinned order with group_id cleared.
func (s *ConversationStore) DeleteGroup(ctx context.Context, id string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin delete group tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var assistantID string
	err = tx.QueryRowContext(ctx, `SELECT assistant_id FROM conversation_groups WHERE id = ?`, id).Scan(&assistantID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", domain.NewError(domain.ErrCodeNotFound, "conversation group not found", err)
	}
	if err != nil {
		return "", fmt.Errorf("lookup group %s: %w", id, err)
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT id FROM conversations
		WHERE assistant_id = ? AND pinned = 0 AND group_id = ?
		ORDER BY sort_order ASC, id ASC
	`, assistantID, id)
	if err != nil {
		return "", fmt.Errorf("list unpinned group conversations: %w", err)
	}
	var unpinnedIDs []string
	for rows.Next() {
		var cid string
		if scanErr := rows.Scan(&cid); scanErr != nil {
			_ = rows.Close()
			return "", scanErr
		}
		unpinnedIDs = append(unpinnedIDs, cid)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return "", err
	}
	_ = rows.Close()

	var maxUngrouped int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(sort_order), 0)
		FROM conversations
		WHERE assistant_id = ? AND pinned = 0 AND group_id IS NULL
	`, assistantID).Scan(&maxUngrouped); err != nil {
		return "", fmt.Errorf("max ungrouped sort_order: %w", err)
	}

	for i, cid := range unpinnedIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE conversations SET group_id = NULL, sort_order = ? WHERE id = ?
		`, maxUngrouped+1+i, cid); err != nil {
			return "", fmt.Errorf("move group conversation %s to ungrouped: %w", cid, err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE conversations SET group_id = NULL WHERE assistant_id = ? AND pinned = 1 AND group_id = ?
	`, assistantID, id); err != nil {
		return "", fmt.Errorf("clear group_id on pinned conversations: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM conversation_groups WHERE id = ?`, id); err != nil {
		return "", fmt.Errorf("delete conversation group %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit delete group tx: %w", err)
	}
	return assistantID, nil
}

// MoveToAssistantUngroupedHead moves a conversation across assistants inside a transaction,
// clearing any source group and placing it at the ungrouped head of targetAssistantID.
func (s *ConversationStore) MoveToAssistantUngroupedHead(ctx context.Context, id, targetAssistantID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin assistant move tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var nextHead int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MIN(sort_order), 1) - 1 FROM conversations WHERE assistant_id = ? AND pinned = 0 AND group_id IS NULL
	`, targetAssistantID).Scan(&nextHead); err != nil {
		return fmt.Errorf("compute target assistant ungrouped head: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE conversations SET assistant_id = ?, group_id = NULL, pinned = 0, sort_order = ? WHERE id = ?
	`, targetAssistantID, nextHead, id); err != nil {
		return fmt.Errorf("move conversation %s to assistant %s: %w", id, targetAssistantID, err)
	}
	return tx.Commit()
}

func (s *ConversationStore) listByAssistantTx(ctx context.Context, tx *sql.Tx, assistantID string) ([]domain.Conversation, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT `+conversationSelectCols+`
		FROM conversations c
		LEFT JOIN conversation_groups g ON c.group_id = g.id
		WHERE c.assistant_id = ? AND c.ephemeral = 0
	`+conversationOrderByClause, assistantID)
	if err != nil {
		return nil, fmt.Errorf("list conversations in tx: %w", err)
	}
	defer rows.Close()

	convs := make([]domain.Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		convs = append(convs, c)
	}
	return convs, rows.Err()
}

func verifyAssistantConversationIDs(convs []domain.Conversation, ids []string) (map[string]domain.Conversation, error) {
	byID := make(map[string]domain.Conversation, len(convs))
	for _, c := range convs {
		byID[c.ID] = c
	}
	for _, id := range ids {
		if _, ok := byID[id]; !ok {
			return nil, domain.NewError(domain.ErrCodeNotFound, fmt.Sprintf("conversation %s not found for assistant", id), nil)
		}
	}
	return byID, nil
}

func verifyGroupInAssistantTx(ctx context.Context, tx *sql.Tx, assistantID, groupID string) error {
	var owner string
	err := tx.QueryRowContext(ctx, `SELECT assistant_id FROM conversation_groups WHERE id = ?`, groupID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.NewError(domain.ErrCodeNotFound, "conversation group not found", err)
	}
	if err != nil {
		return fmt.Errorf("check group %s: %w", groupID, err)
	}
	if owner != assistantID {
		return domain.NewError(domain.ErrCodeInvalidArgument, "group does not belong to assistant", nil)
	}
	return nil
}

// BatchDelete atomically deletes all specified conversations belonging to assistantID.
func (s *ConversationStore) BatchDelete(ctx context.Context, assistantID string, ids []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin batch delete tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	convs, err := s.listByAssistantTx(ctx, tx, assistantID)
	if err != nil {
		return err
	}
	if _, err := verifyAssistantConversationIDs(convs, ids); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `DELETE FROM conversations WHERE id = ? AND assistant_id = ?`, id, assistantID); err != nil {
			return fmt.Errorf("batch delete conversation %s: %w", id, err)
		}
	}
	return tx.Commit()
}

// CleanupUngrouped deletes the ungrouped and unpinned topics across all assistants.
func (s *ConversationStore) CleanupUngrouped(ctx context.Context) ([]domain.DeletedConversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `DELETE FROM conversations
   WHERE group_id IS NULL AND pinned = 0 AND ephemeral = 0 RETURNING id, assistant_id`)
	if err != nil {
		return nil, fmt.Errorf("cleanup ungrouped conversations: %w", err)
	}
	defer rows.Close()
	deleted := make([]domain.DeletedConversation, 0)
	for rows.Next() {
		var item domain.DeletedConversation
		if err := rows.Scan(&item.ID, &item.AssistantID); err != nil {
			return nil, err
		}
		deleted = append(deleted, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return deleted, nil
}

// BatchMove atomically moves conversations to targetGroupID (nil for ungrouped) within assistantID.
// Unpinned items are prepended to the target bucket head in source order; pinned items update group_id while keeping pinned order.
func (s *ConversationStore) BatchMove(ctx context.Context, assistantID string, ids []string, targetGroupID *string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin batch move tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if targetGroupID != nil {
		if err := verifyGroupInAssistantTx(ctx, tx, assistantID, *targetGroupID); err != nil {
			return err
		}
	}
	convs, err := s.listByAssistantTx(ctx, tx, assistantID)
	if err != nil {
		return err
	}
	if _, err := verifyAssistantConversationIDs(convs, ids); err != nil {
		return err
	}

	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}

	targetKey := bucketKeyOf(targetGroupID)
	var existingTargetUnpinned []string
	var movedUnpinned []string
	var movedPinned []string
	for _, c := range convs {
		if selected[c.ID] {
			if c.Pinned {
				movedPinned = append(movedPinned, c.ID)
			} else {
				movedUnpinned = append(movedUnpinned, c.ID)
			}
			continue
		}
		if !c.Pinned && bucketKeyOf(c.GroupID) == targetKey {
			existingTargetUnpinned = append(existingTargetUnpinned, c.ID)
		}
	}

	targetArg := nullableString(targetGroupID)
	for _, id := range movedPinned {
		if _, err := tx.ExecContext(ctx, `UPDATE conversations SET group_id = ? WHERE id = ?`, targetArg, id); err != nil {
			return fmt.Errorf("update pinned conversation %s group: %w", id, err)
		}
	}

	merged := append(movedUnpinned, existingTargetUnpinned...)
	for i, id := range merged {
		if _, err := tx.ExecContext(ctx, `UPDATE conversations SET group_id = ?, sort_order = ? WHERE id = ?`, targetArg, i+1, id); err != nil {
			return fmt.Errorf("reorder moved conversation %s: %w", id, err)
		}
	}
	return tx.Commit()
}

// BatchPin atomically pins selected conversations to the head of the pinned bucket or unpins them
// to the tail of their respective original groups, always preserving group_id.
func (s *ConversationStore) BatchPin(ctx context.Context, assistantID string, ids []string, pinned bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin batch pin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	convs, err := s.listByAssistantTx(ctx, tx, assistantID)
	if err != nil {
		return err
	}
	if _, err := verifyAssistantConversationIDs(convs, ids); err != nil {
		return err
	}

	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		selected[id] = true
	}

	if pinned {
		var newlyPinned []string
		var existingPinned []string
		for _, c := range convs {
			if c.Pinned {
				existingPinned = append(existingPinned, c.ID)
			} else if selected[c.ID] {
				newlyPinned = append(newlyPinned, c.ID)
			}
		}
		merged := append(newlyPinned, existingPinned...)
		for i, id := range merged {
			if _, err := tx.ExecContext(ctx, `UPDATE conversations SET pinned = 1, sort_order = ? WHERE id = ?`, i+1, id); err != nil {
				return fmt.Errorf("pin conversation %s: %w", id, err)
			}
		}
		return tx.Commit()
	}

	// Unpin: keep group_id intact and append each unpinned item to the tail of its own group (or ungrouped).
	existingByBucket := make(map[string][]string)
	unpinnedByBucket := make(map[string][]string)
	var affectedBuckets []string
	seenBucket := make(map[string]bool)

	for _, c := range convs {
		key := bucketKeyOf(c.GroupID)
		if !c.Pinned {
			existingByBucket[key] = append(existingByBucket[key], c.ID)
			continue
		}
		if selected[c.ID] {
			unpinnedByBucket[key] = append(unpinnedByBucket[key], c.ID)
			if !seenBucket[key] {
				seenBucket[key] = true
				affectedBuckets = append(affectedBuckets, key)
			}
		}
	}

	for _, key := range affectedBuckets {
		merged := append(existingByBucket[key], unpinnedByBucket[key]...)
		for i, id := range merged {
			if _, err := tx.ExecContext(ctx, `UPDATE conversations SET pinned = 0, sort_order = ? WHERE id = ?`, i+1, id); err != nil {
				return fmt.Errorf("unpin conversation %s: %w", id, err)
			}
		}
	}
	return tx.Commit()
}

// Reorder atomically places ids (in the order provided) inside the target bucket before beforeID (or at tail if nil),
// normalizing integer sort_order for that bucket without overwriting concurrent conversations outside ids.
func (s *ConversationStore) Reorder(ctx context.Context, assistantID string, ids []string, pinned bool, groupID *string, beforeID *string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin reorder tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if !pinned && groupID != nil {
		if err := verifyGroupInAssistantTx(ctx, tx, assistantID, *groupID); err != nil {
			return err
		}
	}
	convs, err := s.listByAssistantTx(ctx, tx, assistantID)
	if err != nil {
		return err
	}
	if _, err := verifyAssistantConversationIDs(convs, ids); err != nil {
		return err
	}

	movingSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		if beforeID != nil && id == *beforeID {
			return domain.NewError(domain.ErrCodeInvalidArgument, "beforeId must not be included in ids", nil)
		}
		movingSet[id] = true
	}

	targetKey := bucketKeyOf(groupID)
	var remaining []string
	for _, c := range convs {
		if movingSet[c.ID] {
			continue
		}
		if pinned {
			if c.Pinned {
				remaining = append(remaining, c.ID)
			}
		} else if !c.Pinned && bucketKeyOf(c.GroupID) == targetKey {
			remaining = append(remaining, c.ID)
		}
	}

	insertIdx := len(remaining)
	if beforeID != nil {
		found := false
		for i, rid := range remaining {
			if rid == *beforeID {
				insertIdx = i
				found = true
				break
			}
		}
		if !found {
			return domain.NewError(domain.ErrCodeInvalidArgument, "beforeId is not in the target bucket", nil)
		}
	}

	newOrder := make([]string, 0, len(remaining)+len(ids))
	newOrder = append(newOrder, remaining[:insertIdx]...)
	newOrder = append(newOrder, ids...)
	newOrder = append(newOrder, remaining[insertIdx:]...)

	if pinned {
		for i, id := range newOrder {
			if _, err := tx.ExecContext(ctx, `UPDATE conversations SET pinned = 1, sort_order = ? WHERE id = ?`, i+1, id); err != nil {
				return fmt.Errorf("reorder pinned conversation %s: %w", id, err)
			}
		}
	} else {
		groupArg := nullableString(groupID)
		for i, id := range newOrder {
			if _, err := tx.ExecContext(ctx, `UPDATE conversations SET pinned = 0, group_id = ?, sort_order = ? WHERE id = ?`, groupArg, i+1, id); err != nil {
				return fmt.Errorf("reorder conversation %s: %w", id, err)
			}
		}
	}
	return tx.Commit()
}
