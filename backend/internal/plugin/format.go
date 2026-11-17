package plugin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
)

// ChatTool describes an executable MCP tool offered to a model request under a format-safe alias.
type ChatTool struct {
	Alias       string          `json:"alias"`
	ServerID    string          `json:"serverId,omitempty"`
	ServerName  string          `json:"serverName,omitempty"`
	ToolName    string          `json:"toolName,omitempty"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// BuildChatToolAlias derives a deterministic, collision-free tool name obeying OpenAI/Anthropic/Gemini identifier rules.
func BuildChatToolAlias(serverID, toolName string, used map[string]struct{}) string {
	var slug strings.Builder
	for i := 0; i < len(toolName); i++ {
		c := toolName[i]
		isValid := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'
		if isValid {
			slug.WriteByte(c)
		} else {
			slug.WriteByte('_')
		}
	}
	cleaned := strings.Trim(slug.String(), "_")
	if cleaned == "" {
		cleaned = "tool"
	}
	first := cleaned[0]
	if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_') {
		cleaned = "t_" + cleaned
	}

	sum := sha256.Sum256([]byte(serverID + "\x00" + toolName))
	hashSuffix := hex.EncodeToString(sum[:4]) // 8 hex chars

	formatCandidate := func(extra string) string {
		suffix := "__" + hashSuffix + extra
		maxPrefix := 64 - len(suffix)
		prefix := cleaned
		if len(prefix) > maxPrefix {
			prefix = prefix[:maxPrefix]
		}
		return prefix + suffix
	}

	candidate := formatCandidate("")
	if used != nil {
		for n := 2; ; n++ {
			if _, exists := used[candidate]; !exists {
				used[candidate] = struct{}{}
				break
			}
			candidate = formatCandidate(fmt.Sprintf("_%d", n))
		}
	}
	return candidate
}

// NormalizeToolSchema keeps valid JSON object schemas intact and defaults missing/empty schemas to an empty object schema.
func NormalizeToolSchema(raw json.RawMessage) any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || !json.Valid(trimmed) {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	var obj map[string]any
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	if _, hasType := obj["type"]; !hasType {
		obj["type"] = "object"
	}
	return obj
}

// ChatInput holds all inputs needed by an APIFormat plugin to encode an upstream request.
type ChatInput struct {
	ConversationID  string
	MessageID       string
	Provider        domain.ProviderConfig
	Model           domain.ModelConfig
	SystemPrompt    string
	Messages        []domain.Message
	Params          domain.GenerationParams
	Compat          domain.CompatConfig
	Tools           []ChatTool
	AutoCreateCache bool
	PromptCache     *PromptCacheState
}

// PromptCacheScope isolates cached references by provider, endpoint, auth material, format, and model.
type PromptCacheScope struct {
	ProviderID string `json:"providerId"`
	Endpoint   string `json:"endpoint"`
	AuthHash   string `json:"authHash"`
	FormatID   string `json:"formatId"`
	ModelID    string `json:"modelId"`
}

// PromptCacheState stores an active cache handle or negative capability marker for a single scope.
type PromptCacheState struct {
	ResourceName     string    `json:"resourceName,omitempty"`
	PrefixHash       string    `json:"prefixHash,omitempty"`
	PrefixCount      int       `json:"prefixCount,omitempty"`
	ToolsHash        string    `json:"toolsHash,omitempty"`
	SystemHash       string    `json:"systemHash,omitempty"`
	ExpireTime       time.Time `json:"expireTime,omitempty"`
	Unsupported      bool      `json:"unsupported,omitempty"`
	FailedPrefixHash string    `json:"failedPrefixHash,omitempty"`
}

// CachePlan describes an optional pre-request step before encoding the main chat request.
type CachePlan struct {
	CreateRequest *EncodedRequest   `json:"createRequest,omitempty"`
	PlanKey       string            `json:"planKey,omitempty"`
	ReuseState    *PromptCacheState `json:"reuseState,omitempty"`
	InlineCache   bool              `json:"inlineCache,omitempty"`
}

// CacheResolutionInput carries the HTTP status and body produced by executing CachePlan.CreateRequest.
type CacheResolutionInput struct {
	StatusCode int
	Body       []byte
	PlanKey    string
}

// CacheResolutionResult describes the outcome parsed by PromptCachePlanner.ResolveCache.
type CacheResolutionResult struct {
	State     *PromptCacheState
	Degrade   bool
	HardError error
}

// CacheFailureAction instructs ChatService how to handle an upstream rejection when caching was active.
type CacheFailureAction struct {
	InvalidateScope   bool
	MarkUnsupported   bool
	RetryWithoutCache bool
	ReplanCache       bool
}

// PromptCachePlanner is optionally implemented by APIFormat plugins that support prompt/context caching.
type PromptCachePlanner interface {
	PlanCache(ctx context.Context, input ChatInput, current *PromptCacheState) (CachePlan, error)
	ResolveCache(ctx context.Context, input ChatInput, plan CachePlan, res CacheResolutionInput) (CacheResolutionResult, error)
	ClassifyCacheError(statusCode int, body []byte, usedCache *PromptCacheState) CacheFailureAction
}

// EncodedRequest describes the HTTP request payload and metadata produced by an APIFormat.
type EncodedRequest struct {
	Method      string
	DefaultPath string
	Query       url.Values
	Headers     http.Header
	Body        []byte
}

// APIFormat defines encoding and streaming decoding for an upstream LLM wire protocol.
type APIFormat interface {
	ID() string
	DisplayName() string
	DefaultPath() string
	DefaultCompat() domain.CompatConfig
	EncodeRequest(ctx context.Context, input ChatInput) (EncodedRequest, error)
	DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error
}

// FormatInfo is the public metadata view returned by FormatRegistry.List.
type FormatInfo struct {
	ID            string              `json:"id"`
	DisplayName   string              `json:"displayName"`
	DefaultPath   string              `json:"defaultPath"`
	DefaultCompat domain.CompatConfig `json:"defaultCompat"`
}

// FormatRegistry manages registered APIFormat plugins in a concurrency-safe map.
type FormatRegistry struct {
	mu      sync.RWMutex
	formats map[string]APIFormat
}

// NewFormatRegistry creates an empty FormatRegistry.
func NewFormatRegistry() *FormatRegistry {
	return &FormatRegistry{
		formats: make(map[string]APIFormat),
	}
}

// Register adds a format plugin to the registry, rejecting empty or duplicate IDs.
func (r *FormatRegistry) Register(format APIFormat) error {
	if format == nil || format.ID() == "" {
		return fmt.Errorf("format plugin must have a non-empty ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.formats[format.ID()]; exists {
		return fmt.Errorf("duplicate format plugin %q", format.ID())
	}
	r.formats[format.ID()] = format
	return nil
}

// MustRegister registers a format plugin and panics if registration fails.
func (r *FormatRegistry) MustRegister(format APIFormat) {
	if err := r.Register(format); err != nil {
		panic(err)
	}
}

// Get retrieves a format plugin by ID.
func (r *FormatRegistry) Get(id string) (APIFormat, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	f, ok := r.formats[id]
	return f, ok
}

// Has reports whether a format ID is registered.
func (r *FormatRegistry) Has(id string) bool {
	_, ok := r.Get(id)
	return ok
}

// List returns metadata for all registered formats sorted by ID.
func (r *FormatRegistry) List() []FormatInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]FormatInfo, 0, len(r.formats))
	for _, f := range r.formats {
		out = append(out, FormatInfo{
			ID:            f.ID(),
			DisplayName:   f.DisplayName(),
			DefaultPath:   f.DefaultPath(),
			DefaultCompat: f.DefaultCompat(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}
