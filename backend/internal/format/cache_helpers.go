package format

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/url"
	"strings"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

// cachePolicy is the caching intent resolved from the gateway-side automatic
// preference and the model's cache mode. One snapshot serves a generation and
// all of its tool-continuation rounds.
type cachePolicy struct {
	mode        string
	autoEnabled bool
}

func resolveCachePolicy(input plugin.ChatInput, compat domain.CompatConfig) cachePolicy {
	return cachePolicy{
		mode:        strings.ToLower(strings.TrimSpace(compat.CacheMode)),
		autoEnabled: input.AutoCreateCache,
	}
}

// autoManaged reports whether the application may add cache fields: an explicit
// model mode always opts in, "auto"/unset follows the persisted preference, and
// implicit/disabled never add application fields.
func (p cachePolicy) autoManaged() bool {
	switch p.mode {
	case domain.CacheModeExplicit:
		return true
	case "", domain.CacheModeAuto:
		return p.autoEnabled
	default:
		return false
	}
}

// explicitOnly is the narrow gate for compatibility cache extensions that
// unconfirmed endpoints may reject: only an explicit model mode opts in.
func (p cachePolicy) explicitOnly() bool {
	return p.mode == domain.CacheModeExplicit
}

func cacheStateUnsupported(state *plugin.PromptCacheState) bool {
	return state != nil && state.Unsupported
}

const openAIOfficialHost = "api.openai.com"

// isOpenAIOfficialEndpoint reports whether the resolved generation URL is the
// documented OpenAI API host and route for expectedPath. Proxies, lookalike
// hosts, non-default ports and non-standard routes stay on the compatibility path.
func isOpenAIOfficialEndpoint(generationURL, expectedPath string) bool {
	u, err := url.Parse(strings.TrimSpace(generationURL))
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), openAIOfficialHost) {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	path := strings.TrimRight(u.Path, "/")
	expected := strings.TrimRight(expectedPath, "/")
	return path != "" && path == expected
}

// openAIPromptCacheKey derives a stable routing key for the documented OpenAI
// prompt cache. It carries no credential, prompt text, timestamp or request ID,
// and stays identical across the turns of one conversation.
func openAIPromptCacheKey(input plugin.ChatInput, formatID string) string {
	h := sha256.New()
	for _, part := range []string{input.ConversationID, input.Provider.ID, formatID, input.Model.ID} {
		_, _ = io.WriteString(h, part)
		_, _ = h.Write([]byte{0})
	}
	return "llmstudio-" + hex.EncodeToString(h.Sum(nil)[:16])
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
