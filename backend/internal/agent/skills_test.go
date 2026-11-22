package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/store"
)

func createAgentConv(id string) domain.Conversation {
	return domain.Conversation{
		ID:          id,
		AssistantID: domain.DefaultAssistantID,
		Title:       id,
		Mode:        domain.ConversationModeAgent,
	}
}

func openTestAgentRuntime(t *testing.T, dir string) (*Runtime, *store.ConversationStore) {
	t.Helper()
	ctx := t.Context()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewGateway(store.NewAgentStore(db), dir, true), store.NewConversationStore(db)
}

func TestAgentExtensionsMigrationDefaultsAndPartialPatch(t *testing.T) {
	ctx := t.Context()
	db, err := store.OpenSQLite(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	// Simulate an existing 016 database upgrading to 017.
	if _, err := db.ExecContext(ctx, `
		DELETE FROM schema_migrations WHERE version = '017_agent_extensions.sql';
		ALTER TABLE agent_settings DROP COLUMN inject_agent_md;
		ALTER TABLE agent_settings DROP COLUMN markdown_visual_render;
	`); err != nil {
		t.Fatalf("downgrade to 016: %v", err)
	}
	if err := store.RunMigrations(ctx, db); err != nil {
		t.Fatalf("RunMigrations upgrade: %v", err)
	}

	rt := NewGateway(store.NewAgentStore(db), t.TempDir(), true)
	cfg, err := rt.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if !cfg.InjectAgentMD || cfg.MarkdownVisualRender {
		t.Fatalf("unexpected defaults: inject=%v visual=%v", cfg.InjectAgentMD, cfg.MarkdownVisualRender)
	}
	if !slices.Contains(cfg.AvailableTools, "skill") {
		t.Fatalf("expected skill in availableTools: %v", cfg.AvailableTools)
	}
	if cfg.Skills == nil || len(cfg.Skills) != 0 {
		t.Fatalf("expected non-nil empty skills slice, got %#v", cfg.Skills)
	}

	falseVal := false
	trueVal := true
	allowed := []string{"read", "skill"}
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatalf("UpdateSettings allowedTools: %v", err)
	}
	cfg, err = rt.UpdateSettings(ctx, SettingsPatch{InjectAgentMD: &falseVal, MarkdownVisualRender: &trueVal})
	if err != nil {
		t.Fatalf("UpdateSettings flags: %v", err)
	}
	if cfg.InjectAgentMD || !cfg.MarkdownVisualRender || !slices.Equal(cfg.AllowedTools, allowed) {
		t.Fatalf("partial patch clobbered fields: %+v", cfg)
	}

	bad := []string{"nonexistent"}
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{AllowedTools: &bad}); err == nil {
		t.Fatal("expected unknown tool to be rejected")
	}
}

func TestWorkspaceAgentMDAndSkillsDiscoveryAndExecution(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	outside := t.TempDir()

	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("OUTSIDE_SECRET"), 0600); err != nil {
		t.Fatal(err)
	}

	// Both AGENTS.md and AGENT.md exist: AGENTS.md must win without duplicating.
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Primary AGENTS instructions"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "AGENT.md"), []byte("Fallback AGENT instructions"), 0600); err != nil {
		t.Fatal(err)
	}

	// Populate .agent/skills and .agents/skills, testing override, multiline YAML, and sorting.
	mustWrite := func(rel, body string) {
		t.Helper()
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}

	mustWrite(".agent/skills/zeta/SKILL.md", "---\nname: zeta\ndescription: >-\n  First folded line\n  second folded line\n---\n# Zeta Body\nUse zeta carefully.\n")
	mustWrite(".agent/skills/zeta/references/guide.md", "guide content")
	mustWrite(".agent/skills/zeta/scripts/check.sh", "#!/bin/sh\necho ok\n")
	mustWrite(".agent/skills/shared/SKILL.md", "---\nname: shared-skill\ndescription: \"From .agent\"\n---\n# Preferred .agent\n")
	mustWrite(".agents/skills/shared/SKILL.md", "---\nname: shared-skill\ndescription: 'From .agents'\n---\n# Shadowed .agents\n")
	mustWrite(".agents/skills/alpha/SKILL.md", "---\ndescription: |\n  Alpha literal line 1\n  Alpha literal line 2\n---\n# Alpha Body\n")

	// Symlink escape attempts inside .agent/skills must be ignored.
	_ = os.Symlink(outside, filepath.Join(dir, ".agent", "skills", "escaped-dir"))
	if err := os.MkdirAll(filepath.Join(dir, ".agent", "skills", "escaped-file"), 0755); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(dir, ".agent", "skills", "escaped-file", "SKILL.md"))

	rt, convs := openTestAgentRuntime(t, dir)
	if _, err := convs.Create(ctx, createAgentConv("topic-1")); err != nil {
		t.Fatal(err)
	}

	// 1. Settings exposes discovered skills in lexical order with .agent winning over .agents.
	cfg, err := rt.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if len(cfg.Skills) != 3 {
		t.Fatalf("expected 3 skills, got %+v", cfg.Skills)
	}
	if cfg.Skills[0].Name != "alpha" || cfg.Skills[1].Name != "shared-skill" || cfg.Skills[2].Name != "zeta" {
		t.Fatalf("unexpected skill order: %+v", cfg.Skills)
	}
	if cfg.Skills[0].Description != "Alpha literal line 1\nAlpha literal line 2" {
		t.Fatalf("unexpected alpha description: %q", cfg.Skills[0].Description)
	}
	if cfg.Skills[1].Description != "From .agent" || cfg.Skills[1].Path != ".agent/skills/shared/SKILL.md" {
		t.Fatalf("expected .agent precedence: %+v", cfg.Skills[1])
	}
	if cfg.Skills[2].Description != "First folded line second folded line" {
		t.Fatalf("unexpected folded description: %q", cfg.Skills[2].Description)
	}

	// 2. Without skill authorized, skill tool & catalog are NOT exposed, but AGENTS.md is injected.
	onlyRead := []string{"read"}
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{AllowedTools: &onlyRead}); err != nil {
		t.Fatal(err)
	}
	suffix, tools, err := rt.PrepareContext(ctx, "topic-1")
	if err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	if !strings.Contains(suffix, "Primary AGENTS instructions") || strings.Contains(suffix, "Fallback AGENT instructions") {
		t.Fatalf("unexpected AGENTS.md injection: %q", suffix)
	}
	if strings.Contains(suffix, "<available_skills>") {
		t.Fatalf("skills catalog leaked without authorization: %q", suffix)
	}
	if len(tools) != 1 || tools[0].Alias != "read" {
		t.Fatalf("expected only read tool, got %+v", tools)
	}
	if _, err := rt.Execute(ctx, "topic-1", "skill", json.RawMessage(`{"name":"zeta"}`)); err == nil {
		t.Fatal("expected unauthorized skill call to fail")
	}

	// 3. Authorize skill tool: catalog & tool exposed, execution returns full SKILL.md and companions.
	withSkill := []string{"read", "skill"}
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{AllowedTools: &withSkill}); err != nil {
		t.Fatal(err)
	}
	suffix, tools, err = rt.PrepareContext(ctx, "topic-1")
	if err != nil {
		t.Fatalf("PrepareContext with skill: %v", err)
	}
	if !strings.Contains(suffix, "<available_skills>") || !strings.Contains(suffix, `name="zeta"`) {
		t.Fatalf("missing skills catalog: %q", suffix)
	}
	if len(tools) != 2 || tools[1].Alias != "skill" {
		t.Fatalf("expected read+skill tools, got %+v", tools)
	}
	out, err := rt.Execute(ctx, "topic-1", "skill", json.RawMessage(`{"name":"zeta"}`))
	if err != nil {
		t.Fatalf("Execute skill: %v", err)
	}
	if !strings.Contains(out, "# Zeta Body") || !strings.Contains(out, "references/guide.md") || !strings.Contains(out, "scripts/check.sh") {
		t.Fatalf("unexpected skill output: %q", out)
	}
	if _, err := rt.Execute(ctx, "topic-1", "skill", json.RawMessage(`{"name":"../secret"}`)); err == nil || !strings.Contains(err.Error(), "zeta") {
		t.Fatalf("expected unknown skill error listing available skills, got %v", err)
	}

	// 4. Disabling injectAgentMd stops AGENTS.md injection while keeping skills.
	off := false
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{InjectAgentMD: &off}); err != nil {
		t.Fatal(err)
	}
	suffix, _, err = rt.PrepareContext(ctx, "topic-1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(suffix, "Primary AGENTS instructions") || !strings.Contains(suffix, "<available_skills>") {
		t.Fatalf("unexpected suffix when injectAgentMd=false: %q", suffix)
	}

	// 5. Fallback to AGENT.md when AGENTS.md is absent, and symlinked AGENT.md is ignored.
	on := true
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{InjectAgentMD: &on}); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(dir, "AGENTS.md"))
	suffix, _, err = rt.PrepareContext(ctx, "topic-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(suffix, "Fallback AGENT instructions") {
		t.Fatalf("expected AGENT.md fallback, got %q", suffix)
	}
	_ = os.Remove(filepath.Join(dir, "AGENT.md"))
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(dir, "AGENTS.md")); err == nil {
		suffix, _, err = rt.PrepareContext(ctx, "topic-1")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(suffix, "OUTSIDE_SECRET") {
			t.Fatalf("symlinked AGENTS.md leaked outside content: %q", suffix)
		}
	}
}

func TestNoSkillsDoesNotExposeSkillToolOrCatalog(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	rt, convs := openTestAgentRuntime(t, dir)
	if _, err := convs.Create(ctx, createAgentConv("topic-empty")); err != nil {
		t.Fatal(err)
	}
	allowed := []string{"read", "skill"}
	if _, err := rt.UpdateSettings(ctx, SettingsPatch{AllowedTools: &allowed}); err != nil {
		t.Fatal(err)
	}
	suffix, tools, err := rt.PrepareContext(ctx, "topic-empty")
	if err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	if suffix != "" {
		t.Fatalf("expected empty suffix, got %q", suffix)
	}
	if len(tools) != 1 || tools[0].Alias != "read" {
		t.Fatalf("expected skill tool omitted when workspace has no skills, got %+v", tools)
	}
}
