package format

import (
	"maps"

	"llmstudio/backend/internal/domain"
)

// MergeCompat merges non-zero override fields onto base without mutating either input.
func MergeCompat(base, override domain.CompatConfig) domain.CompatConfig {
	out := domain.CompatConfig{
		MaxTokensField:       base.MaxTokensField,
		ThinkingFormat:       base.ThinkingFormat,
		ReasoningEffortField: base.ReasoningEffortField,
		PathOverride:         base.PathOverride,
	}
	if base.SupportsDeveloperRole != nil {
		out.SupportsDeveloperRole = domain.BoolPtr(*base.SupportsDeveloperRole)
	}
	if base.SupportsStreamOptions != nil {
		out.SupportsStreamOptions = domain.BoolPtr(*base.SupportsStreamOptions)
	}
	if len(base.ExtraHeaders) > 0 {
		out.ExtraHeaders = maps.Clone(base.ExtraHeaders)
	}
	if len(base.ExtraBody) > 0 {
		out.ExtraBody = cloneBodyMap(base.ExtraBody)
	}

	if override.MaxTokensField != "" {
		out.MaxTokensField = override.MaxTokensField
	}
	if override.SupportsDeveloperRole != nil {
		out.SupportsDeveloperRole = domain.BoolPtr(*override.SupportsDeveloperRole)
	}
	if override.SupportsStreamOptions != nil {
		out.SupportsStreamOptions = domain.BoolPtr(*override.SupportsStreamOptions)
	}
	if override.ThinkingFormat != "" {
		out.ThinkingFormat = override.ThinkingFormat
	}
	if override.ReasoningEffortField != "" {
		out.ReasoningEffortField = override.ReasoningEffortField
	}
	if override.PathOverride != "" {
		out.PathOverride = override.PathOverride
	}
	if len(override.ExtraHeaders) > 0 {
		if out.ExtraHeaders == nil {
			out.ExtraHeaders = make(map[string]string, len(override.ExtraHeaders))
		}
		maps.Copy(out.ExtraHeaders, override.ExtraHeaders)
	}
	if len(override.ExtraBody) > 0 {
		if out.ExtraBody == nil {
			out.ExtraBody = make(map[string]any, len(override.ExtraBody))
		}
		MergeBodyMap(out.ExtraBody, override.ExtraBody)
	}
	return out
}

// MergeBodyMap recursively merges src keys into dst; nested maps are merged, scalars and slices overwrite.
func MergeBodyMap(dst, src map[string]any) {
	for k, v := range src {
		if srcMap, ok := v.(map[string]any); ok {
			if dstMap, exists := dst[k].(map[string]any); exists {
				MergeBodyMap(dstMap, srcMap)
				continue
			}
			cloned := make(map[string]any, len(srcMap))
			MergeBodyMap(cloned, srcMap)
			dst[k] = cloned
			continue
		}
		dst[k] = v
	}
}

func cloneBodyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	out := make(map[string]any, len(src))
	MergeBodyMap(out, src)
	return out
}
