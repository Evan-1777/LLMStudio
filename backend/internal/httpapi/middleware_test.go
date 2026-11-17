package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"llmstudio/backend/internal/config"
	"llmstudio/backend/internal/plugin"
)

func TestAuthMiddlewareAndHealthz(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", HandleHealthz)
	mux.HandleFunc("GET /api/v1/protected", func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	t.Run("token configured protects api routes and allows healthz", func(t *testing.T) {
		handler := CORSMiddleware([]string{"*"}, AuthMiddleware("secret-123", false, mux))

		reqHealth := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		recHealth := httptest.NewRecorder()
		handler.ServeHTTP(recHealth, reqHealth)
		if recHealth.Code != http.StatusOK {
			t.Fatalf("expected 200 on /healthz, got %d", recHealth.Code)
		}
		var healthBody map[string]any
		if err := json.Unmarshal(recHealth.Body.Bytes(), &healthBody); err != nil {
			t.Fatalf("invalid health json: %v", err)
		}
		if healthBody["status"] != "ok" || healthBody["version"] != "0.1.0" {
			t.Fatalf("unexpected health body: %v", healthBody)
		}

		reqUnauth := httptest.NewRequest(http.MethodGet, "/api/v1/protected", nil)
		recUnauth := httptest.NewRecorder()
		handler.ServeHTTP(recUnauth, reqUnauth)
		if recUnauth.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 without token, got %d", recUnauth.Code)
		}
		var errBody apiErrorBody
		if err := json.Unmarshal(recUnauth.Body.Bytes(), &errBody); err != nil {
			t.Fatalf("invalid error json: %v", err)
		}
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("expected UNAUTHORIZED code, got %q", errBody.Code)
		}

		reqWrong := httptest.NewRequest(http.MethodGet, "/api/v1/protected", nil)
		reqWrong.Header.Set("Authorization", "Bearer wrong-token")
		recWrong := httptest.NewRecorder()
		handler.ServeHTTP(recWrong, reqWrong)
		if recWrong.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 with wrong token, got %d", recWrong.Code)
		}

		reqValid := httptest.NewRequest(http.MethodGet, "/api/v1/protected", nil)
		reqValid.Header.Set("Authorization", "Bearer secret-123")
		recValid := httptest.NewRecorder()
		handler.ServeHTTP(recValid, reqValid)
		if recValid.Code != http.StatusOK {
			t.Fatalf("expected 200 with valid token, got %d", recValid.Code)
		}

		reqPreflight := httptest.NewRequest(http.MethodOptions, "/api/v1/protected", nil)
		reqPreflight.Header.Set("Origin", "http://localhost:3000")
		recPreflight := httptest.NewRecorder()
		handler.ServeHTTP(recPreflight, reqPreflight)
		if recPreflight.Code != http.StatusNoContent {
			t.Fatalf("expected 204 for preflight, got %d", recPreflight.Code)
		}
	})

	t.Run("dev mode allows empty token", func(t *testing.T) {
		handler := AuthMiddleware("", true, mux)
		req := httptest.NewRequest(http.MethodGet, "/api/v1/protected", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 in dev mode, got %d", rec.Code)
		}
	})
}

func TestHealthzAuthRequiredMatchesMiddlewareMatrix(t *testing.T) {
	cases := []struct {
		name             string
		token            string
		devMode          bool
		wantAuthRequired bool
		wantUnauthStatus int
		wantAuthStatus   int
	}{
		{
			name:             "devMode_without_token",
			token:            "",
			devMode:          true,
			wantAuthRequired: false,
			wantUnauthStatus: http.StatusOK,
			wantAuthStatus:   http.StatusOK,
		},
		{
			name:             "devMode_with_token",
			token:            "dev-secret",
			devMode:          true,
			wantAuthRequired: true,
			wantUnauthStatus: http.StatusUnauthorized,
			wantAuthStatus:   http.StatusOK,
		},
		{
			name:             "prod_with_token",
			token:            "prod-secret",
			devMode:          false,
			wantAuthRequired: true,
			wantUnauthStatus: http.StatusUnauthorized,
			wantAuthStatus:   http.StatusOK,
		},
		{
			name:             "prod_without_token",
			token:            "",
			devMode:          false,
			wantAuthRequired: true,
			wantUnauthStatus: http.StatusUnauthorized,
			wantAuthStatus:   http.StatusUnauthorized,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := NewRouter(RouterDeps{
				Config: config.Config{
					AccessToken: tc.token,
					DevMode:     tc.devMode,
					CORSOrigins: []string{"*"},
				},
				Formats: plugin.NewFormatRegistry(),
			})

			healthReq := httptest.NewRequest(http.MethodGet, "/healthz", nil)
			healthRec := httptest.NewRecorder()
			router.ServeHTTP(healthRec, healthReq)
			if healthRec.Code != http.StatusOK {
				t.Fatalf("expected 200 on /healthz, got %d", healthRec.Code)
			}
			var health map[string]any
			if err := json.Unmarshal(healthRec.Body.Bytes(), &health); err != nil {
				t.Fatalf("decode /healthz: %v", err)
			}
			if health["authRequired"] != tc.wantAuthRequired {
				t.Fatalf("authRequired=%v, want %v", health["authRequired"], tc.wantAuthRequired)
			}

			unauthReq := httptest.NewRequest(http.MethodGet, "/api/v1/formats", nil)
			unauthRec := httptest.NewRecorder()
			router.ServeHTTP(unauthRec, unauthReq)
			if unauthRec.Code != tc.wantUnauthStatus {
				t.Fatalf("unauthenticated /api/v1/formats status=%d, want %d", unauthRec.Code, tc.wantUnauthStatus)
			}

			if tc.token != "" {
				authReq := httptest.NewRequest(http.MethodGet, "/api/v1/formats", nil)
				authReq.Header.Set("Authorization", "Bearer "+tc.token)
				authRec := httptest.NewRecorder()
				router.ServeHTTP(authRec, authReq)
				if authRec.Code != tc.wantAuthStatus {
					t.Fatalf("authenticated /api/v1/formats status=%d, want %d", authRec.Code, tc.wantAuthStatus)
				}
			}
		})
	}
}
