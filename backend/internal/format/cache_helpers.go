package format

import (
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

func shouldApplyInlineCache(input plugin.ChatInput, compat domain.CompatConfig, allowAuto bool) bool {
	if !input.AutoCreateCache {
		return false
	}
	if input.PromptCache != nil && input.PromptCache.Unsupported {
		return false
	}
	mode := strings.ToLower(strings.TrimSpace(compat.CacheMode))
	switch mode {
	case domain.CacheModeDisabled, domain.CacheModeImplicit:
		return false
	case domain.CacheModeExplicit:
		return true
	case "", domain.CacheModeAuto:
		return allowAuto
	default:
		return false
	}
}

func classifyInlineCacheError(statusCode int, body []byte, keywords ...string) plugin.CacheFailureAction {
	if statusCode != 400 && statusCode != 422 {
		return plugin.CacheFailureAction{}
	}
	lower := strings.ToLower(string(body))
	matchedKeyword := false
	for _, kw := range keywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			matchedKeyword = true
			break
		}
	}
	if !matchedKeyword {
		return plugin.CacheFailureAction{}
	}
	rejectionTerms := []string{
		"unsupported",
		"not supported",
		"does not support",
		"unknown",
		"unrecognized",
		"invalid",
		"unexpected",
		"extra inputs are not permitted",
		"not allowed",
		"not permitted",
	}
	for _, term := range rejectionTerms {
		if strings.Contains(lower, term) {
			return plugin.CacheFailureAction{
				MarkUnsupported:   true,
				RetryWithoutCache: true,
			}
		}
	}
	return plugin.CacheFailureAction{}
}

func hasExtraBodyKey(extra map[string]any, key string) bool {
	if len(extra) == 0 {
		return false
	}
	_, ok := extra[key]
	return ok
}
