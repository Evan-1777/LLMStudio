package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
	"llmstudio/backend/internal/service"
)

// CloudConnectionTestResult describes the outcome of probing a remote LLMStudio gateway.
type CloudConnectionTestResult struct {
	OK           bool   `json:"ok"`
	AuthRequired bool   `json:"authRequired"`
	LatencyMs    int64  `json:"latencyMs"`
	Message      string `json:"message"`
}

// CloudClient communicates with the remote LLMStudio gateway over HTTP/JSON.
type CloudClient struct {
	mu           sync.RWMutex
	connection   *cloudConnection
	stdClient    *http.Client
	streamClient *http.Client
}

// NewCloudClient constructs a CloudClient targeting baseURL with optional Bearer accessToken.
func NewCloudClient(baseURL, accessToken string) *CloudClient {
	return &CloudClient{
		connection:   newCloudConnection(baseURL, accessToken),
		stdClient:    &http.Client{Timeout: 20 * time.Second},
		streamClient: &http.Client{},
	}
}

// SetHTTPClient overrides the HTTP clients used by CloudClient (primarily for tests).
func (c *CloudClient) SetHTTPClient(client *http.Client) {
	if client == nil {
		return
	}
	c.mu.Lock()
	c.stdClient = client
	c.streamClient = client
	c.mu.Unlock()
}

type cloudConnection struct {
	baseURL, token string
	lifetime       context.Context
	cancel         context.CancelFunc
	requests       map[context.Context]context.CancelFunc
}

type cloudConnectionKey struct{}

func newCloudConnection(baseURL, token string) *cloudConnection {
	ctx, cancel := context.WithCancel(context.Background())
	return &cloudConnection{strings.TrimRight(strings.TrimSpace(baseURL), "/"), strings.TrimSpace(token), ctx, cancel, make(map[context.Context]context.CancelFunc)}
}

func (c *CloudClient) bind(ctx context.Context) (context.Context, func()) {
	if c == nil || ctx.Value(cloudConnectionKey{}) != nil {
		return ctx, func() {}
	}
	c.mu.Lock()
	conn := c.connection
	bound, cancel := context.WithCancel(context.WithValue(ctx, cloudConnectionKey{}, conn))
	conn.requests[bound] = cancel
	c.mu.Unlock()
	return bound, func() {
		cancel()
		c.mu.Lock()
		delete(conn.requests, bound)
		c.mu.Unlock()
	}
}

func checkCloudConnection(ctx context.Context) error {
	if conn, _ := ctx.Value(cloudConnectionKey{}).(*cloudConnection); conn != nil && conn.lifetime.Err() != nil {
		return domain.NewError(domain.ErrCodeConflict, "cloud connection changed", nil)
	}
	return ctx.Err()
}

// SetCredentials updates the target atomically and cancels in-flight bound operations.
func (c *CloudClient) SetCredentials(baseURL, accessToken string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setCredentials(baseURL, accessToken)
}

func (c *CloudClient) setCredentials(baseURL, accessToken string) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	accessToken = strings.TrimSpace(accessToken)
	if c.connection.baseURL == baseURL && c.connection.token == accessToken {
		return
	}
	c.connection.cancel()
	for _, cancel := range c.connection.requests {
		cancel()
	}
	c.connection = newCloudConnection(baseURL, accessToken)
}

// Credentials returns the current gateway base URL and token snapshot.
func (c *CloudClient) Credentials() (baseURL, accessToken string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connection.baseURL, c.connection.token
}

// IsConfigured reports whether a remote gateway URL is currently configured.
func (c *CloudClient) IsConfigured() bool {
	baseURL, _ := c.Credentials()
	return baseURL != ""
}

func (c *CloudClient) clients() (*http.Client, *http.Client) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.stdClient, c.streamClient
}

func (c *CloudClient) doRequest(
	ctx context.Context,
	client *http.Client,
	overrideBaseURL string,
	overrideToken string,
	useOverride bool,
	method string,
	pathAndQuery string,
	body any,
	out any,
) error {
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	var baseURL, token string
	if conn, _ := ctx.Value(cloudConnectionKey{}).(*cloudConnection); conn != nil {
		baseURL, token = conn.baseURL, conn.token
	} else {
		baseURL, token = c.Credentials()
	}
	if useOverride {
		baseURL = strings.TrimRight(strings.TrimSpace(overrideBaseURL), "/")
		token = strings.TrimSpace(overrideToken)
	}
	if baseURL == "" {
		return domain.NewError(domain.ErrCodeUnauthorized, "cloud gateway is not connected", nil)
	}
	if !strings.HasPrefix(pathAndQuery, "/") {
		pathAndQuery = "/" + pathAndQuery
	}

	var reader io.Reader
	if body != nil {
		switch raw := body.(type) {
		case []byte:
			reader = bytes.NewReader(raw)
		case json.RawMessage:
			reader = bytes.NewReader(raw)
		default:
			encoded, err := json.Marshal(body)
			if err != nil {
				return domain.NewError(domain.ErrCodeInvalidArgument, "encode cloud request failed", err)
			}
			reader = bytes.NewReader(encoded)
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, baseURL+pathAndQuery, reader)
	if err != nil {
		return domain.NewError(domain.ErrCodeInvalidArgument, "construct cloud request failed", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := client.Do(req)
	if err != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, fmt.Sprintf("cloud gateway unreachable: %v", err), err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024*1024))
	if err != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, "failed to read cloud gateway response", err)
	}
	if err := checkCloudConnection(ctx); err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseCloudHTTPError(resp.StatusCode, respBytes)
	}
	if out == nil || len(bytes.TrimSpace(respBytes)) == 0 {
		return nil
	}
	if rawOut, ok := out.(*json.RawMessage); ok {
		*rawOut = append((*rawOut)[:0], respBytes...)
		return nil
	}
	if err := json.Unmarshal(respBytes, out); err != nil {
		return domain.NewError(domain.ErrCodeUpstreamError, "decode cloud gateway response failed", err)
	}
	return nil
}

func (c *CloudClient) doJSON(ctx context.Context, method, pathAndQuery string, body, out any) error {
	std, _ := c.clients()
	return c.doRequest(ctx, std, "", "", false, method, pathAndQuery, body, out)
}

func (c *CloudClient) doLongJSON(ctx context.Context, method, pathAndQuery string, body, out any) error {
	_, long := c.clients()
	return c.doRequest(ctx, long, "", "", false, method, pathAndQuery, body, out)
}

func parseCloudHTTPError(status int, body []byte) error {
	var parsed struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &parsed)
	msg := strings.TrimSpace(parsed.Message)
	if msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	code := strings.TrimSpace(parsed.Code)
	if code == "" {
		switch status {
		case http.StatusUnauthorized:
			code = domain.ErrCodeUnauthorized
		case http.StatusConflict:
			code = domain.ErrCodeConflict
		case http.StatusNotFound:
			code = domain.ErrCodeNotFound
		case http.StatusBadRequest:
			code = domain.ErrCodeInvalidArgument
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			code = domain.ErrCodeUpstreamError
		default:
			code = domain.ErrCodeInternalError
		}
	}
	return domain.NewError(code, msg, nil)
}

// HealthCheck probes /healthz on the configured cloud gateway.
func (c *CloudClient) HealthCheck(ctx context.Context) (bool, error) {
	var res struct {
		OK           bool `json:"ok"`
		AuthRequired bool `json:"authRequired"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/healthz", nil, &res); err != nil {
		return false, err
	}
	return res.AuthRequired, nil
}

// TestConnection tests reachability and authentication against baseURL and accessToken.
func (c *CloudClient) TestConnection(ctx context.Context, baseURL, accessToken string) (CloudConnectionTestResult, error) {
	std, _ := c.clients()
	start := time.Now()
	var health struct {
		OK           bool `json:"ok"`
		AuthRequired bool `json:"authRequired"`
	}
	if err := c.doRequest(ctx, std, baseURL, accessToken, true, http.MethodGet, "/healthz", nil, &health); err != nil {
		return CloudConnectionTestResult{}, err
	}
	var settingsProbe json.RawMessage
	if err := c.doRequest(ctx, std, baseURL, accessToken, true, http.MethodGet, "/api/v1/settings", nil, &settingsProbe); err != nil {
		return CloudConnectionTestResult{}, err
	}
	return CloudConnectionTestResult{
		OK:           true,
		AuthRequired: health.AuthRequired,
		LatencyMs:    time.Since(start).Milliseconds(),
		Message:      "云端连接正常",
	}, nil
}

func (c *CloudClient) ListProviders(ctx context.Context) ([]CachedProvider, error) {
	var res struct {
		Providers []CachedProvider `json:"providers"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/providers", nil, &res); err != nil {
		return nil, err
	}
	if res.Providers == nil {
		return []CachedProvider{}, nil
	}
	return res.Providers, nil
}

func (c *CloudClient) CreateProvider(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/providers", payload, &out)
	return out, err
}

func (c *CloudClient) UpdateProvider(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPut, "/api/v1/providers/"+url.PathEscape(id), payload, &out)
	return out, err
}

func (c *CloudClient) DeleteProvider(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/v1/providers/"+url.PathEscape(id), nil, nil)
}

func (c *CloudClient) ReorderProviders(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/providers/reorder", payload, &out)
	return out, err
}

func (c *CloudClient) TestProvider(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/providers/"+url.PathEscape(id)+"/test", payload, &out)
	return out, err
}

func (c *CloudClient) FetchProviderModels(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/providers/"+url.PathEscape(id)+"/models/fetch", payload, &out)
	return out, err
}

func (c *CloudClient) ImportProviderKey(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/providers/"+url.PathEscape(id)+"/keys/import", payload, &out)
	return out, err
}

func (c *CloudClient) GetProviderCredential(ctx context.Context, providerID string) (service.ProviderRuntimeCredential, error) {
	var cred service.ProviderRuntimeCredential
	err := c.doJSON(ctx, http.MethodGet, "/api/v1/providers/"+url.PathEscape(providerID)+"/credential", nil, &cred)
	return cred, err
}

func (c *CloudClient) ListAssistants(ctx context.Context) ([]domain.Assistant, error) {
	var res struct {
		Assistants []domain.Assistant `json:"assistants"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/assistants", nil, &res); err != nil {
		return nil, err
	}
	if res.Assistants == nil {
		return []domain.Assistant{}, nil
	}
	return res.Assistants, nil
}

func (c *CloudClient) CreateAssistant(ctx context.Context, payload json.RawMessage) (domain.Assistant, error) {
	var res struct {
		Assistant domain.Assistant `json:"assistant"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/assistants", payload, &res)
	return res.Assistant, err
}

func (c *CloudClient) UpdateAssistant(ctx context.Context, id string, payload json.RawMessage) (domain.Assistant, error) {
	var res struct {
		Assistant domain.Assistant `json:"assistant"`
	}
	err := c.doJSON(ctx, http.MethodPut, "/api/v1/assistants/"+url.PathEscape(id), payload, &res)
	return res.Assistant, err
}

func (c *CloudClient) DeleteAssistant(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/v1/assistants/"+url.PathEscape(id), nil, nil)
}

func (c *CloudClient) GetSettings(ctx context.Context) (domain.Preferences, bool, error) {
	var res struct {
		Preferences domain.Preferences `json:"preferences"`
		Initialized bool               `json:"initialized"`
	}
	err := c.doJSON(ctx, http.MethodGet, "/api/v1/settings", nil, &res)
	return res.Preferences, res.Initialized, err
}

func (c *CloudClient) PatchSettings(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPatch, "/api/v1/settings", payload, &out)
	return out, err
}

func (c *CloudClient) ImportSettingsOnce(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/settings/import", payload, &out)
	return out, err
}

func (c *CloudClient) ListSearchEngines(ctx context.Context) ([]service.SearchEngineView, error) {
	var res struct {
		Engines []service.SearchEngineView `json:"engines"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/plugins/search", nil, &res); err != nil {
		return nil, err
	}
	if res.Engines == nil {
		return []service.SearchEngineView{}, nil
	}
	return res.Engines, nil
}

func (c *CloudClient) UpdateSearchEngine(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPut, "/api/v1/plugins/search/"+url.PathEscape(id), payload, &out)
	return out, err
}

func (c *CloudClient) TestSearchEngine(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/plugins/search/"+url.PathEscape(id)+"/test", payload, &out)
	return out, err
}

func (c *CloudClient) GetSearchCredential(ctx context.Context, engineID string) (service.SearchEngineRuntimeCredential, error) {
	var cred service.SearchEngineRuntimeCredential
	err := c.doJSON(ctx, http.MethodGet, "/api/v1/plugins/search/"+url.PathEscape(engineID)+"/credential", nil, &cred)
	return cred, err
}

func (c *CloudClient) ListMCPServers(ctx context.Context) ([]domain.MCPServerConfig, error) {
	var res struct {
		Servers []domain.MCPServerConfig `json:"servers"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/mcp/servers", nil, &res); err != nil {
		return nil, err
	}
	if res.Servers == nil {
		return []domain.MCPServerConfig{}, nil
	}
	return res.Servers, nil
}

func (c *CloudClient) CreateMCPServer(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/mcp/servers", payload, &out)
	return out, err
}

func (c *CloudClient) UpdateMCPServer(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPut, "/api/v1/mcp/servers/"+url.PathEscape(id), payload, &out)
	return out, err
}

func (c *CloudClient) DeleteMCPServer(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/v1/mcp/servers/"+url.PathEscape(id), nil, nil)
}

func (c *CloudClient) ListMCPServerTools(ctx context.Context, id string) ([]plugin.MCPToolDescriptor, error) {
	var res struct {
		Tools []plugin.MCPToolDescriptor `json:"tools"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/mcp/servers/"+url.PathEscape(id)+"/tools", nil, &res); err != nil {
		return nil, err
	}
	if res.Tools == nil {
		return []plugin.MCPToolDescriptor{}, nil
	}
	return res.Tools, nil
}

func (c *CloudClient) TestMCPServer(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/mcp/servers/"+url.PathEscape(id)+"/test", nil, &out)
	return out, err
}

func (c *CloudClient) ExecuteCloudMCPTools(ctx context.Context, calls []service.StatelessToolCallInput) ([]domain.ContentBlock, error) {
	var res struct {
		ToolResults []domain.ContentBlock `json:"toolResults"`
	}
	err := c.doLongJSON(ctx, http.MethodPost, "/api/v1/mcp/tools/execute", map[string]any{
		"calls": calls,
	}, &res)
	if err != nil {
		return nil, err
	}
	return res.ToolResults, nil
}

func (c *CloudClient) ListConversations(ctx context.Context, assistantID string) (json.RawMessage, error) {
	path := "/api/v1/conversations"
	if strings.TrimSpace(assistantID) != "" {
		path += "?assistantId=" + url.QueryEscape(strings.TrimSpace(assistantID))
	}
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

func (c *CloudClient) CreateConversation(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversations", payload, &out)
	return out, err
}

func (c *CloudClient) GetConversationDetail(ctx context.Context, id string) (service.ConversationDetail, error) {
	var out service.ConversationDetail
	err := c.doJSON(ctx, http.MethodGet, "/api/v1/conversations/"+url.PathEscape(id), nil, &out)
	return out, err
}

func (c *CloudClient) PatchConversation(ctx context.Context, id string, payload any) (domain.Conversation, error) {
	var res struct {
		Conversation domain.Conversation `json:"conversation"`
	}
	err := c.doJSON(ctx, http.MethodPatch, "/api/v1/conversations/"+url.PathEscape(id), payload, &res)
	return res.Conversation, err
}

func (c *CloudClient) DeleteConversation(ctx context.Context, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/v1/conversations/"+url.PathEscape(id), nil, nil)
}

func (c *CloudClient) BranchConversation(ctx context.Context, convID, msgID string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversations/"+url.PathEscape(convID)+"/messages/"+url.PathEscape(msgID)+"/branch", nil, &out)
	return out, err
}

func (c *CloudClient) ImportConversation(ctx context.Context, conv domain.Conversation, messages []domain.Message, force bool) (service.ConversationDetail, error) {
	var out service.ConversationDetail
	err := c.doLongJSON(ctx, http.MethodPost, "/api/v1/conversations/import", service.ImportConversationInput{
		Conversation: conv,
		Messages:     messages,
		Force:        force,
	}, &out)
	return out, err
}

func (c *CloudClient) CreateMessage(ctx context.Context, convID string, in service.CreateMessageInput) (service.CreateMessageResult, error) {
	var out service.CreateMessageResult
	err := c.doLongJSON(ctx, http.MethodPost, "/api/v1/conversations/"+url.PathEscape(convID)+"/messages", in, &out)
	return out, err
}

func (c *CloudClient) UpdateMessage(ctx context.Context, convID, msgID string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPatch, "/api/v1/conversations/"+url.PathEscape(convID)+"/messages/"+url.PathEscape(msgID), payload, &out)
	return out, err
}

func (c *CloudClient) DeleteMessage(ctx context.Context, convID, msgID string) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/v1/conversations/"+url.PathEscape(convID)+"/messages/"+url.PathEscape(msgID), nil, nil)
}

func (c *CloudClient) ListGroups(ctx context.Context, assistantID string) (json.RawMessage, error) {
	path := "/api/v1/conversation-groups"
	if strings.TrimSpace(assistantID) != "" {
		path += "?assistantId=" + url.QueryEscape(strings.TrimSpace(assistantID))
	}
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

func (c *CloudClient) CreateGroup(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversation-groups", payload, &out)
	return out, err
}

func (c *CloudClient) ReorderGroups(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversation-groups/reorder", payload, &out)
	return out, err
}

func (c *CloudClient) RenameGroup(ctx context.Context, id string, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPatch, "/api/v1/conversation-groups/"+url.PathEscape(id), payload, &out)
	return out, err
}

func (c *CloudClient) DeleteGroup(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodDelete, "/api/v1/conversation-groups/"+url.PathEscape(id), nil, &out)
	return out, err
}

func (c *CloudClient) BatchConversations(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversations/batch", payload, &out)
	return out, err
}

func (c *CloudClient) ReorderConversations(ctx context.Context, payload json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversations/reorder", payload, &out)
	return out, err
}

func (c *CloudClient) CleanupUngrouped(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/conversations/cleanup-ungrouped", nil, &out)
	return out, err
}

func (c *CloudClient) GetStorage(ctx context.Context) (domain.StorageUsage, error) {
	var out domain.StorageUsage
	err := c.doJSON(ctx, http.MethodGet, "/api/v1/storage", nil, &out)
	return out, err
}

func (c *CloudClient) CompactStorage(ctx context.Context) (domain.StorageCompactResult, error) {
	var out domain.StorageCompactResult
	err := c.doLongJSON(ctx, http.MethodPost, "/api/v1/storage/compact", nil, &out)
	return out, err
}
