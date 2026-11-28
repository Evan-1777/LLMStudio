package format

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"llmstudio/backend/internal/domain"
)

type blockProvenance struct {
	ProviderFormat            string          `json:"providerFormat,omitempty"`
	ItemID                    string          `json:"itemId,omitempty"`
	EncryptedContent          string          `json:"encryptedContent,omitempty"`
	ThoughtSignature          string          `json:"thoughtSignature,omitempty"`
	AnthropicRedactedThinking string          `json:"anthropicRedactedThinking,omitempty"`
	StructuredContent         json.RawMessage `json:"structuredContent,omitempty"`
}

func parseBlockProvenance(extra json.RawMessage) blockProvenance {
	trimmed := bytes.TrimSpace(extra)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return blockProvenance{}
	}
	var p blockProvenance
	if err := json.Unmarshal(trimmed, &p); err != nil {
		return blockProvenance{}
	}
	return p
}

func makeProviderExtra(providerFormat string, fields map[string]any) json.RawMessage {
	obj := make(map[string]any, len(fields)+1)
	if providerFormat != "" {
		obj["providerFormat"] = providerFormat
	}
	for k, v := range fields {
		if v != "" && v != nil {
			obj[k] = v
		}
	}
	raw, err := json.Marshal(obj)
	if err != nil {
		return nil
	}
	return raw
}

func extractThoughtSignature(b domain.ContentBlock, targetFormat string) string {
	prov := parseBlockProvenance(b.Extra)
	switch targetFormat {
	case FormatIDAnthropicMessages:
		if prov.ProviderFormat != "" && prov.ProviderFormat != FormatIDAnthropicMessages {
			return ""
		}
		return strings.TrimSpace(b.Signature)
	case FormatIDGoogleGenAI:
		if prov.ProviderFormat != FormatIDGoogleGenAI {
			return ""
		}
		if sig := strings.TrimSpace(prov.ThoughtSignature); sig != "" {
			return sig
		}
		return strings.TrimSpace(b.Signature)
	case FormatIDOpenAIResponses:
		if prov.ProviderFormat != FormatIDOpenAIResponses {
			return ""
		}
		if enc := strings.TrimSpace(prov.EncryptedContent); enc != "" {
			return enc
		}
		return strings.TrimSpace(b.Signature)
	default:
		return ""
	}
}

func formatToolResultContent(b domain.ContentBlock) string {
	prov := parseBlockProvenance(b.Extra)
	sc := strings.TrimSpace(string(prov.StructuredContent))
	content := b.Content
	if sc != "" && sc != "null" {
		if content == "" {
			return sc
		}
		if !strings.Contains(content, sc) {
			return content + "\n" + sc
		}
	}
	return content
}

func toolArgsObject(raw json.RawMessage) map[string]any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return map[string]any{}
	}
	var obj map[string]any
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return map[string]any{}
	}
	return obj
}

func rawArgumentsObjectString(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return "{}"
	}
	var obj map[string]any
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return "{}"
	}
	return string(trimmed)
}

const interruptedToolResultContent = "[工具调用已中断，未返回结果]"

type pendingToolCall struct {
	originalID   string
	normalizedID string
	name         string
}

// normalizeMessagesForEncoding repairs interrupted or imported tool history so
// every protocol receives unique call IDs and a strict 1:1 call/result pairing.
func normalizeMessagesForEncoding(messages []domain.Message) []domain.Message {
	out := make([]domain.Message, 0, len(messages))
	seenIDs := make(map[string]struct{})
	seq := 0
	for i := 0; i < len(messages); i++ {
		msg := messages[i]
		switch msg.Role {
		case domain.RoleAssistant:
			blocks, pending := normalizeAssistantBlocks(msg.Blocks, seenIDs, &seq)
			if len(pending) > 0 {
				matched := make(map[string]domain.ContentBlock, len(pending))
				j := i + 1
				for j < len(messages) && messages[j].Role == domain.RoleToolResult {
					for _, b := range messages[j].Blocks {
						if b.Type != domain.BlockTypeToolResult {
							continue
						}
						for _, pc := range pending {
							if strings.TrimSpace(b.ToolCallID) != pc.originalID {
								continue
							}
							if _, exists := matched[pc.normalizedID]; !exists {
								matched[pc.normalizedID] = normalizeToolResultBlock(b, pc)
							}
							break
						}
					}
					j++
				}
				for _, pc := range pending {
					if result, ok := matched[pc.normalizedID]; ok {
						blocks = append(blocks, result)
						continue
					}
					blocks = append(blocks, domain.ContentBlock{
						Type:       domain.BlockTypeToolResult,
						ToolCallID: pc.normalizedID,
						ToolName:   pc.name,
						Content:    interruptedToolResultContent,
						IsError:    true,
					})
				}
				i = j - 1
			}
			if len(blocks) == 0 {
				continue
			}
			msg.Blocks = blocks
			out = append(out, msg)
		case domain.RoleToolResult:
			// A standalone result with no immediately preceding assistant call is
			// orphaned by normalization; dropping it prevents protocol 400s.
			continue
		default:
			out = append(out, msg)
		}
	}
	return out
}

func normalizeAssistantBlocks(
	blocks []domain.ContentBlock,
	seenIDs map[string]struct{},
	seq *int,
) ([]domain.ContentBlock, []pendingToolCall) {
	out := make([]domain.ContentBlock, 0, len(blocks))
	pending := make([]pendingToolCall, 0)
	indexByOriginal := make(map[string]int)

	flush := func() {
		for _, pc := range pending {
			out = append(out, domain.ContentBlock{
				Type:       domain.BlockTypeToolResult,
				ToolCallID: pc.normalizedID,
				ToolName:   pc.name,
				Content:    interruptedToolResultContent,
				IsError:    true,
			})
		}
		pending = pending[:0]
		indexByOriginal = make(map[string]int)
	}

	for _, b := range blocks {
		switch b.Type {
		case domain.BlockTypeWebSearch:
			continue
		case domain.BlockTypeToolCall:
			name := strings.TrimSpace(b.Name)
			if name == "" {
				continue
			}
			original := strings.TrimSpace(b.ID)
			normalized := allocateNormalizedToolCallID(original, seenIDs, seq)
			b.ID = normalized
			b.Name = name
			out = append(out, b)
			pending = append(pending, pendingToolCall{originalID: original, normalizedID: normalized, name: name})
			if original != "" {
				indexByOriginal[original] = len(pending) - 1
			}
		case domain.BlockTypeToolResult:
			original := strings.TrimSpace(b.ToolCallID)
			idx, ok := indexByOriginal[original]
			if !ok {
				continue
			}
			pc := pending[idx]
			out = append(out, normalizeToolResultBlock(b, pc))
			pending = append(pending[:idx], pending[idx+1:]...)
			indexByOriginal = make(map[string]int, len(pending))
			for i, item := range pending {
				if item.originalID != "" {
					indexByOriginal[item.originalID] = i
				}
			}
		default:
			if (b.Type == domain.BlockTypeText && strings.TrimSpace(b.Text) == "") ||
				(b.Type == domain.BlockTypeThinking && strings.TrimSpace(b.Thinking) == "" && strings.TrimSpace(b.Signature) == "") {
				continue
			}
			if len(pending) > 0 {
				flush()
			}
			out = append(out, b)
		}
	}
	return out, pending
}

func allocateNormalizedToolCallID(raw string, seenIDs map[string]struct{}, seq *int) string {
	id := strings.TrimSpace(raw)
	if id != "" {
		if _, exists := seenIDs[id]; !exists {
			seenIDs[id] = struct{}{}
			return id
		}
	}
	for {
		*seq++
		candidate := fmt.Sprintf("call_norm_%d", *seq)
		if _, exists := seenIDs[candidate]; exists {
			continue
		}
		seenIDs[candidate] = struct{}{}
		return candidate
	}
}

func normalizeToolResultBlock(b domain.ContentBlock, pc pendingToolCall) domain.ContentBlock {
	b.ToolCallID = pc.normalizedID
	if strings.TrimSpace(b.ToolName) == "" {
		b.ToolName = pc.name
	}
	return b
}
