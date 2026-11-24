package service

import (
	"context"
	"slices"
	"strings"

	"llmstudio/backend/internal/domain"

	"llmstudio/backend/internal/store"
)

type GraphMutationInput = store.GraphMutationInput

func graphEnabled(conv domain.Conversation) bool {
	return conv.GraphState != nil && conv.GraphState.Enabled
}

// expandSideReferences injects single-level side-branch assistant replies immediately
// after each target message in activePath as an independent User message wrapped in
// <reference_materials>...</reference_materials>.
func expandSideReferences(all []domain.Message, activePath []domain.Message) []domain.Message {
	hasSideRefs := false
	for _, m := range activePath {
		if m.GraphMeta != nil && len(m.GraphMeta.SideRefs) > 0 {
			hasSideRefs = true
			break
		}
	}
	if !hasSideRefs {
		return activePath
	}

	byID := make(map[string]domain.Message, len(all))
	for _, m := range all {
		if m.ID != "" {
			byID[m.ID] = m
		}
	}

	mainAncestors := make(map[string]bool, len(activePath))
	out := make([]domain.Message, 0, len(activePath)+2)
	for _, m := range activePath {
		if m.ID != "" {
			mainAncestors[m.ID] = true
		}
		out = append(out, m)
		if m.GraphMeta == nil || len(m.GraphMeta.SideRefs) == 0 {
			continue
		}

		seenAssistant := make(map[string]bool)
		var refParts []string
		for _, ref := range m.GraphMeta.SideRefs {
			if ref.SourceMessageID == "" {
				continue
			}
			var branchMsgs []domain.Message
			walkVisited := make(map[string]bool)
			for curID := ref.SourceMessageID; curID != ""; {
				if mainAncestors[curID] || walkVisited[curID] {
					break
				}
				walkVisited[curID] = true
				cur, ok := byID[curID]
				if !ok {
					break
				}
				branchMsgs = append(branchMsgs, cur)
				curID = cur.ParentID
			}
			slices.Reverse(branchMsgs)
			for _, bm := range branchMsgs {
				if bm.Role != domain.RoleAssistant || seenAssistant[bm.ID] {
					continue
				}
				seenAssistant[bm.ID] = true
				if text := extractAssistantTextBlocks(bm.Blocks); text != "" {
					refParts = append(refParts, text)
				}
			}
		}

		if len(refParts) > 0 {
			wrapped := "<reference_materials>\n" + strings.Join(refParts, "\n\n---\n\n") + "\n</reference_materials>"
			out = append(out, domain.Message{
				ConversationID: m.ConversationID,
				Role:           domain.RoleUser,
				Blocks: []domain.ContentBlock{{
					Type: domain.BlockTypeText,
					Text: wrapped,
				}},
				CreatedAt: m.CreatedAt,
			})
		}
	}
	return out
}

func extractAssistantTextBlocks(blocks []domain.ContentBlock) string {
	var parts []string
	for _, b := range blocks {
		if b.Type == domain.BlockTypeText {
			if t := strings.TrimSpace(b.Text); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

func resolveActiveBranchPath(conv domain.Conversation, all []domain.Message) []domain.Message {
	if !graphEnabled(conv) {
		return all
	}
	target := conv.ActiveLeafID
	if conv.GraphState.ActiveBranchID != "" {
		for _, slot := range conv.GraphState.Branches {
			if slot.ID == conv.GraphState.ActiveBranchID {
				target = slot.ParentMessageID
				break
			}
		}
	}
	path, err := resolvePathUpToMessage(all, target)
	if err != nil {
		return []domain.Message{}
	}
	return path
}

func resolvePathUpToMessage(all []domain.Message, targetID string) ([]domain.Message, error) {
	byID := make(map[string]domain.Message, len(all))
	for _, msg := range all {
		byID[msg.ID] = msg
	}
	path := []domain.Message{}
	for id := targetID; id != ""; {
		msg, ok := byID[id]
		if !ok {
			return nil, domain.NewError(domain.ErrCodeInvalidArgument, "图谱路径中的消息缺失或形成循环", nil)
		}
		delete(byID, id)
		path = append(path, msg)
		id = msg.ParentID
	}
	slices.Reverse(path)
	return path, nil
}

func (s *ConversationService) MutateGraph(ctx context.Context, id string, in GraphMutationInput) (ConversationDetail, error) {
	if err := s.convs.ApplyGraphMutation(ctx, id, in); err != nil {
		return ConversationDetail{}, err
	}
	return s.GetDetail(ctx, id)
}
