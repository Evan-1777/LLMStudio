package plugin

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"sync"

	"llmstudio/backend/internal/domain"
)

// ChatInput holds all inputs needed by an APIFormat plugin to encode an upstream request.
type ChatInput struct {
	ConversationID string
	MessageID      string
	Provider       domain.ProviderConfig
	Model          domain.ModelConfig
	SystemPrompt   string
	Messages       []domain.Message
	Params         domain.GenerationParams
	Compat         domain.CompatConfig
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
	DefaultCompat() domain.CompatConfig
	EncodeRequest(ctx context.Context, input ChatInput) (EncodedRequest, error)
	DecodeStream(ctx context.Context, body io.Reader, emit func(domain.StreamEvent) error) error
}

// FormatInfo is the public metadata view returned by FormatRegistry.List.
type FormatInfo struct {
	ID            string              `json:"id"`
	DisplayName   string              `json:"displayName"`
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
			DefaultCompat: f.DefaultCompat(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}
