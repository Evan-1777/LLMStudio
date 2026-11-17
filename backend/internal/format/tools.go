package format

import (
	"bytes"
	"encoding/json"
	"strings"

	"llmstudio/backend/internal/domain"
)

type blockProvenance struct {
	ProviderFormat           string          `json:"providerFormat,omitempty"`
	ItemID                   string          `json:"itemId,omitempty"`
	EncryptedContent         string          `json:"encryptedContent,omitempty"`
	ThoughtSignature         string          `json:"thoughtSignature,omitempty"`
	AnthropicRedactedThinking string         `json:"anthropicRedactedThinking,omitempty"`
	StructuredContent        json.RawMessage `json:"structuredContent,omitempty"`
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

func toolArgsObject(raw json.RawMessage) any {
	var argsObj any = map[string]any{}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
		_ = json.Unmarshal(trimmed, &argsObj)
	}
	if argsObj == nil {
		return map[string]any{}
	}
	return argsObj
}
