package format

import (
	"encoding/json"
	"fmt"
	"strings"

	"llmstudio/backend/internal/domain"
)

func resolveGenerationParams(model domain.ModelConfig, req domain.GenerationParams) domain.GenerationParams {
	out := domain.GenerationParams{
		ReasoningEffort: model.DefaultParams.ReasoningEffort,
	}
	if model.DefaultParams.Temperature != nil {
		v := *model.DefaultParams.Temperature
		out.Temperature = &v
	}
	if model.DefaultParams.MaxTokens != nil {
		v := *model.DefaultParams.MaxTokens
		out.MaxTokens = &v
	} else if model.MaxTokens > 0 {
		v := model.MaxTokens
		out.MaxTokens = &v
	}

	if req.Temperature != nil {
		v := *req.Temperature
		out.Temperature = &v
	}
	if req.MaxTokens != nil {
		v := *req.MaxTokens
		out.MaxTokens = &v
	}
	if req.ReasoningEffort != "" {
		out.ReasoningEffort = req.ReasoningEffort
	}
	return out
}

func setNestedField(dst map[string]any, dottedPath string, val any) {
	parts := strings.Split(dottedPath, ".")
	cur := dst
	for i := 0; i < len(parts)-1; i++ {
		key := parts[i]
		if existing, ok := cur[key].(map[string]any); ok {
			cur = existing
		} else {
			next := make(map[string]any)
			cur[key] = next
			cur = next
		}
	}
	cur[parts[len(parts)-1]] = val
}

func imageBlockDataURL(b domain.ContentBlock) string {
	if strings.TrimSpace(b.URL) != "" {
		return strings.TrimSpace(b.URL)
	}
	if strings.TrimSpace(b.Data) == "" {
		return ""
	}
	mime := strings.TrimSpace(b.MimeType)
	if mime == "" {
		mime = "image/png"
	}
	return fmt.Sprintf("data:%s;base64,%s", mime, b.Data)
}

func rawArgumentsString(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "{}"
	}
	if strings.HasPrefix(trimmed, "\"") {
		var unquoted string
		if err := json.Unmarshal(raw, &unquoted); err == nil {
			return unquoted
		}
	}
	return trimmed
}

func rawArgumentsJSON(args string) json.RawMessage {
	trimmed := strings.TrimSpace(args)
	if trimmed == "" {
		return json.RawMessage(`{}`)
	}
	if json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	encoded, _ := json.Marshal(trimmed)
	return json.RawMessage(encoded)
}

func cloneBlock(b domain.ContentBlock) *domain.ContentBlock {
	cp := b
	return &cp
}

func emitBlockDelta(emit func(domain.StreamEvent) error, idx int, blockType, deltaType, delta string) error {
	return emit(domain.StreamEvent{
		Type:      domain.StreamEventBlockDelta,
		Index:     domain.IntPtr(idx),
		BlockType: blockType,
		DeltaType: deltaType,
		Delta:     delta,
	})
}

func emitBlockEnd(emit func(domain.StreamEvent) error, idx int, b domain.ContentBlock) error {
	return emit(domain.StreamEvent{
		Type:      domain.StreamEventBlockEnd,
		Index:     domain.IntPtr(idx),
		BlockType: b.Type,
		Block:     cloneBlock(b),
	})
}
