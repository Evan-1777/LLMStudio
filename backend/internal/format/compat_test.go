package format

import (
	"testing"

	"llmstudio/backend/internal/domain"
)

func TestMergeCompat(t *testing.T) {
	base := domain.CompatConfig{
		MaxTokensField:        "max_completion_tokens",
		SupportsDeveloperRole: domain.BoolPtr(true),
		SupportsStreamOptions: domain.BoolPtr(true),
		ThinkingFormat:        "openai",
		CacheMode:             domain.CacheModeExplicit,
		ExtraHeaders:          map[string]string{"X-Base": "1", "X-Shared": "base"},
		ExtraBody: map[string]any{
			"top_p": 0.9,
			"nested": map[string]any{
				"a": 1,
				"b": 2,
			},
		},
	}
	override := domain.CompatConfig{
		MaxTokensField:        "max_tokens",
		SupportsDeveloperRole: domain.BoolPtr(false),
		ExtraHeaders:          map[string]string{"X-Shared": "override", "X-New": "3"},
		ExtraBody: map[string]any{
			"nested": map[string]any{
				"b": 20,
				"c": 30,
			},
		},
	}

	merged := MergeCompat(base, override)
	if merged.MaxTokensField != "max_tokens" {
		t.Fatalf("expected overridden MaxTokensField, got %q", merged.MaxTokensField)
	}
	if merged.DeveloperRoleSupported() {
		t.Fatal("expected explicit false override on SupportsDeveloperRole")
	}
	if !merged.StreamOptionsSupported() {
		t.Fatal("expected inherited true on SupportsStreamOptions")
	}
	if merged.ThinkingFormat != "openai" {
		t.Fatalf("expected inherited ThinkingFormat, got %q", merged.ThinkingFormat)
	}
	if merged.CacheMode != domain.CacheModeExplicit {
		t.Fatalf("expected unset CacheMode to inherit %q, got %q", domain.CacheModeExplicit, merged.CacheMode)
	}
	if merged.ExtraHeaders["X-Base"] != "1" || merged.ExtraHeaders["X-Shared"] != "override" || merged.ExtraHeaders["X-New"] != "3" {
		t.Fatalf("unexpected merged ExtraHeaders: %v", merged.ExtraHeaders)
	}
	nested := merged.ExtraBody["nested"].(map[string]any)
	if nested["a"] != 1 || nested["b"] != 20 || nested["c"] != 30 {
		t.Fatalf("unexpected merged nested ExtraBody: %v", nested)
	}
	// Ensure base map was not mutated.
	if base.ExtraBody["nested"].(map[string]any)["b"] != 2 {
		t.Fatal("MergeCompat mutated base ExtraBody")
	}

	// Explicit "auto" overrides base non-auto mode, as do "disabled" and "implicit".
	if got := MergeCompat(base, domain.CompatConfig{CacheMode: domain.CacheModeAuto}); got.CacheMode != domain.CacheModeAuto {
		t.Fatalf("expected explicit auto override, got %q", got.CacheMode)
	}
	if got := MergeCompat(base, domain.CompatConfig{CacheMode: domain.CacheModeDisabled}); got.CacheMode != domain.CacheModeDisabled {
		t.Fatalf("expected disabled override, got %q", got.CacheMode)
	}
	if got := MergeCompat(base, domain.CompatConfig{CacheMode: domain.CacheModeImplicit}); got.CacheMode != domain.CacheModeImplicit {
		t.Fatalf("expected implicit override, got %q", got.CacheMode)
	}
}
