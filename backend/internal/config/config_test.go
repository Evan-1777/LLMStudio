package config

import "testing"

func TestLoadFromLookup(t *testing.T) {
	t.Run("empty token with devMode false fails", func(t *testing.T) {
		_, err := LoadFromLookup(func(string) string { return "" })
		if err == nil {
			t.Fatal("expected validation error when token is empty and dev mode is false")
		}
	})

	t.Run("empty token with devMode true passes with defaults", func(t *testing.T) {
		env := map[string]string{
			"LLMSTUDIO_DEV_MODE": "true",
		}
		cfg, err := LoadFromLookup(func(k string) string { return env[k] })
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !cfg.DevMode {
			t.Fatal("expected DevMode to be true")
		}
		if cfg.Port != "8080" || cfg.DBPath != "./data/llmstudio.db" {
			t.Fatalf("unexpected defaults: port=%q dbPath=%q", cfg.Port, cfg.DBPath)
		}
		if len(cfg.CORSOrigins) != 1 || cfg.CORSOrigins[0] != "*" {
			t.Fatalf("unexpected CORSOrigins: %v", cfg.CORSOrigins)
		}
	})

	t.Run("configured token and custom values pass", func(t *testing.T) {
		env := map[string]string{
			"LLMSTUDIO_PORT":         "9090",
			"LLMSTUDIO_DB_PATH":      "/tmp/test.db",
			"LLMSTUDIO_ACCESS_TOKEN": "secret-token",
			"LLMSTUDIO_CORS_ORIGINS": "http://localhost:3000, https://app.example.com",
			"LLMSTUDIO_STATIC_DIR":   "/srv/web",
		}
		cfg, err := LoadFromLookup(func(k string) string { return env[k] })
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Addr() != ":9090" || cfg.AccessToken != "secret-token" || cfg.StaticDir != "/srv/web" {
			t.Fatalf("unexpected parsed config: %+v", cfg)
		}
		if len(cfg.CORSOrigins) != 2 || cfg.CORSOrigins[1] != "https://app.example.com" {
			t.Fatalf("unexpected CORSOrigins: %v", cfg.CORSOrigins)
		}
	})

	t.Run("invalid dev mode bool returns error", func(t *testing.T) {
		env := map[string]string{
			"LLMSTUDIO_ACCESS_TOKEN": "tok",
			"LLMSTUDIO_DEV_MODE":     "not-a-bool",
		}
		if _, err := LoadFromLookup(func(k string) string { return env[k] }); err == nil {
			t.Fatal("expected parse error for invalid LLMSTUDIO_DEV_MODE")
		}
	})
}
