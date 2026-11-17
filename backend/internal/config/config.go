package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds runtime settings loaded from environment variables.
type Config struct {
	Port        string
	DBPath      string
	AccessToken string
	DevMode     bool
	CORSOrigins []string
	StaticDir   string
}

// Load reads configuration from process environment variables and validates it.
func Load() (Config, error) {
	return LoadFromLookup(os.Getenv)
}

// LoadFromLookup reads configuration using the provided env lookup function and validates it.
func LoadFromLookup(lookup func(string) string) (Config, error) {
	cfg := Config{
		Port:        strings.TrimSpace(lookup("LLMSTUDIO_PORT")),
		DBPath:      strings.TrimSpace(lookup("LLMSTUDIO_DB_PATH")),
		AccessToken: strings.TrimSpace(lookup("LLMSTUDIO_ACCESS_TOKEN")),
		StaticDir:   strings.TrimSpace(lookup("LLMSTUDIO_STATIC_DIR")),
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	if cfg.DBPath == "" {
		cfg.DBPath = "./data/llmstudio.db"
	}

	if rawDev := strings.TrimSpace(lookup("LLMSTUDIO_DEV_MODE")); rawDev != "" {
		parsed, err := strconv.ParseBool(rawDev)
		if err != nil {
			return Config{}, fmt.Errorf("invalid LLMSTUDIO_DEV_MODE %q: %w", rawDev, err)
		}
		cfg.DevMode = parsed
	}

	rawOrigins := strings.TrimSpace(lookup("LLMSTUDIO_CORS_ORIGINS"))
	if rawOrigins == "" {
		cfg.CORSOrigins = []string{"*"}
	} else {
		for _, part := range strings.Split(rawOrigins, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				cfg.CORSOrigins = append(cfg.CORSOrigins, trimmed)
			}
		}
		if len(cfg.CORSOrigins) == 0 {
			cfg.CORSOrigins = []string{"*"}
		}
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate enforces startup security invariants.
func (c Config) Validate() error {
	if c.AccessToken == "" && !c.DevMode {
		return errors.New("LLMSTUDIO_ACCESS_TOKEN must be set when LLMSTUDIO_DEV_MODE is false")
	}
	return nil
}

// Addr returns the HTTP listen address formatted for net/http.Server.
func (c Config) Addr() string {
	if strings.Contains(c.Port, ":") {
		return c.Port
	}
	return ":" + c.Port
}
