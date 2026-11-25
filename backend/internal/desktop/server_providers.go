package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/httpapi"
	"llmstudio/backend/internal/service"
)

func (s *Server) handleListProviders(w http.ResponseWriter, r *http.Request) {
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		if providers, err := s.cfg.Cloud.refreshProviderSnapshot(ctx, s.cfg.Store); err == nil {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"providers": providers})
			return
		}
	}
	cached, err := s.cfg.Store.LoadCachedProviders(ctx)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"providers": cached})
}

func (s *Server) refreshProvidersCache(ctx context.Context) {
	_, _ = s.cfg.Cloud.refreshProviderSnapshot(ctx, s.cfg.Store)
}

func (s *Server) providerChanged(ctx context.Context, id string) error {
	if err := s.cfg.Store.invalidateProviderSnapshot(context.WithoutCancel(ctx), id); err != nil {
		return err
	}
	s.refreshProvidersCache(ctx)
	return checkCloudConnection(ctx)
}

func (s *Server) handleCreateProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.CreateProvider(ctx, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if err := s.providerChanged(ctx, ""); err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusCreated, raw)
}

func (s *Server) handleReorderProviders(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ReorderProviders(ctx, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	s.refreshProvidersCache(ctx)
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleUpdateProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	id := r.PathValue("id")
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.UpdateProvider(ctx, id, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if err := s.providerChanged(ctx, id); err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func (s *Server) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	id := r.PathValue("id")
	if err := s.cfg.Cloud.DeleteProvider(ctx, id); err != nil {
		writeDesktopError(w, err)
		return
	}
	if err := s.providerChanged(ctx, id); err != nil {
		writeDesktopError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type desktopProbeBody struct {
	service.ProviderProbeInput
	LocalRequest *bool `json:"localRequest,omitempty"`
}

func (s *Server) localProbeHTTPClient() *http.Client {
	if s.cfg.HTTPClient != nil {
		return s.cfg.HTTPClient
	}
	return &http.Client{
		Timeout:   15 * time.Second,
		Transport: NewDesktopHTTPTransport(),
	}
}

func equalStringMaps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

func hasLocalProbeDraftOverrides(saved domain.ProviderConfig, body desktopProbeBody) bool {
	if body.LocalRequest != nil && *body.LocalRequest != saved.LocalRequest {
		return true
	}
	if baseURL := strings.TrimSpace(body.BaseURL); baseURL != "" && baseURL != strings.TrimSpace(saved.BaseURL) {
		return true
	}
	if authType := strings.TrimSpace(body.AuthType); authType != "" {
		savedAuth := strings.TrimSpace(saved.AuthType)
		if savedAuth == "" {
			savedAuth = domain.AuthTypeBearer
		}
		if authType != savedAuth {
			return true
		}
	}
	if strings.TrimSpace(body.APIKey) != "" || body.ClearAPIKey {
		return true
	}
	if body.Headers != nil && !equalStringMaps(body.Headers, saved.Headers) {
		return true
	}
	return false
}

func (s *Server) resolveSavedProviderMeta(ctx context.Context, id string) (CachedProvider, bool, error) {
	if s.cfg.Cloud != nil && s.cfg.Cloud.IsConfigured() {
		_, _ = s.cfg.Cloud.refreshProviderSnapshot(ctx, s.cfg.Store)
	}
	providers, _, err := s.cfg.Store.providerSnapshot(ctx)
	if err != nil {
		return CachedProvider{}, false, err
	}
	for _, p := range providers {
		if p.ID == id {
			return p, true, nil
		}
	}
	return CachedProvider{}, false, nil
}

func (s *Server) executeDesktopLocalModelList(
	ctx context.Context,
	id string,
	probe desktopProbeBody,
) ([]domain.DiscoveredModel, error) {
	lookup := &DesktopProviderLookup{
		store:     s.cfg.Store,
		cloud:     s.cfg.Cloud,
		credCache: s.cfg.CredCache,
	}
	cfg, err := lookup.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if !cfg.LocalRequest {
		return nil, domain.NewError(domain.ErrCodeConflict, "请先保存本地请求配置更改后再执行测试或获取模型", nil)
	}
	if hasLocalProbeDraftOverrides(cfg, probe) {
		return nil, domain.NewError(domain.ErrCodeConflict, "请先保存本地请求配置更改后再执行测试或获取模型", nil)
	}
	prepared, err := service.PrepareModelListRequest(s.cfg.Adapters, cfg)
	if err != nil {
		return nil, err
	}
	return service.ExecuteModelListRequest(ctx, s.localProbeHTTPClient(), prepared, cfg.APIKey)
}

func decodeDesktopProbeBody(raw json.RawMessage) (desktopProbeBody, error) {
	var parsed desktopProbeBody
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return parsed, nil
	}
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return desktopProbeBody{}, domain.NewError(domain.ErrCodeInvalidArgument, "invalid JSON request body", err)
	}
	return parsed, nil
}

func (s *Server) handleTestProvider(w http.ResponseWriter, r *http.Request) {
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	id := r.PathValue("id")
	rawBody, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	probeBody, err := decodeDesktopProbeBody(rawBody)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	meta, found, err := s.resolveSavedProviderMeta(ctx, id)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if found && meta.LocalRequest {
		start := time.Now()
		models, err := s.executeDesktopLocalModelList(ctx, id, probeBody)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, service.ProviderConnectionResult{
			OK:         true,
			LatencyMs:  time.Since(start).Milliseconds(),
			ModelCount: len(models),
			Message:    "连接正常",
		})
		return
	}
	if probeBody.LocalRequest != nil && *probeBody.LocalRequest {
		writeDesktopError(w, domain.NewError(domain.ErrCodeConflict, "请先保存本地请求配置更改后再执行测试或获取模型", nil))
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.TestProvider(ctx, id, rawBody)
	proxyCloudRaw(w, http.StatusOK, raw, err)
}

func (s *Server) handleFetchProviderModels(w http.ResponseWriter, r *http.Request) {
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	id := r.PathValue("id")
	rawBody, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	probeBody, err := decodeDesktopProbeBody(rawBody)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	meta, found, err := s.resolveSavedProviderMeta(ctx, id)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if found && meta.LocalRequest {
		models, err := s.executeDesktopLocalModelList(ctx, id, probeBody)
		if err != nil {
			writeDesktopError(w, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"models": models})
		return
	}
	if probeBody.LocalRequest != nil && *probeBody.LocalRequest {
		writeDesktopError(w, domain.NewError(domain.ErrCodeConflict, "请先保存本地请求配置更改后再执行测试或获取模型", nil))
		return
	}
	if !s.requireCloud(w) {
		return
	}
	raw, err := s.cfg.Cloud.FetchProviderModels(ctx, id, rawBody)
	proxyCloudRaw(w, http.StatusOK, raw, err)
}

func (s *Server) handleImportProviderKey(w http.ResponseWriter, r *http.Request) {
	if !s.requireCloud(w) {
		return
	}
	ctx, release := s.cfg.Cloud.bind(r.Context())
	defer release()
	id := r.PathValue("id")
	body, err := readRawBody(r, 16*1024*1024)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	raw, err := s.cfg.Cloud.ImportProviderKey(ctx, id, body)
	if err != nil {
		writeDesktopError(w, err)
		return
	}
	if err := s.providerChanged(ctx, id); err != nil {
		writeDesktopError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}
