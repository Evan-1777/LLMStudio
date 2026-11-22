package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
)

type apiErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WriteJSON encodes payload as JSON with the given status code.
func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// WriteError writes a standardized JSON error payload.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, apiErrorBody{
		Code:    code,
		Message: message,
	})
}

// CORSMiddleware applies CORS headers based on configured allowed origins and handles OPTIONS preflight.
func CORSMiddleware(allowedOrigins []string, next http.Handler) http.Handler {
	allowAll := len(allowedOrigins) == 0 || slices.Contains(allowedOrigins, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowAll {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if origin != "" && slices.Contains(allowedOrigins, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Font-Name, If-None-Match")
		w.Header().Set("Access-Control-Expose-Headers", "ETag, Content-Disposition")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AuthRequiredForConfig reports whether /api/ routes require authentication
// for the given access token and devMode setting.
func AuthRequiredForConfig(accessToken string, devMode bool) bool {
	return accessToken != "" || !devMode
}

// AuthMiddleware enforces Bearer token verification on /api/ routes when accessToken is configured.
// Health check (/healthz) and static web assets remain exempt.
func AuthMiddleware(accessToken string, devMode bool, next http.Handler) http.Handler {
	expectedHash := sha256.Sum256([]byte(accessToken))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requiresAuth(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if !AuthRequiredForConfig(accessToken, devMode) {
			next.ServeHTTP(w, r)
			return
		}
		if accessToken == "" {
			WriteError(w, http.StatusUnauthorized, "UNAUTHORIZED", "access token is not configured")
			return
		}

		token, ok := extractBearerToken(r.Header.Get("Authorization"))
		if !ok {
			WriteError(w, http.StatusUnauthorized, "UNAUTHORIZED", "missing or invalid bearer token")
			return
		}
		actualHash := sha256.Sum256([]byte(token))
		if subtle.ConstantTimeCompare(actualHash[:], expectedHash[:]) != 1 {
			WriteError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requiresAuth(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

func extractBearerToken(header string) (string, bool) {
	if len(header) < 7 || !strings.EqualFold(header[:7], "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(header[7:])
	if token == "" {
		return "", false
	}
	return token, true
}
