package service

import (
	"context"
	"slices"

	"llmstudio/backend/internal/domain"

	"llmstudio/backend/internal/store"
)

type GraphMutationInput = store.GraphMutationInput

func graphEnabled(conv domain.Conversation) bool {
	return conv.GraphState != nil && conv.GraphState.Enabled
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
