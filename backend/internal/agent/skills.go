package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	"llmstudio/backend/internal/plugin"
)

const (
	maxAgentMDBytes         = 64 << 10
	maxSkillMDBytes         = 256 << 10
	maxSkillsLoaded         = 64
	maxSkillDescRunes       = 512
	maxSkillDirScanEntries  = 256
	maxSkillCompanionFiles  = 64
)

// SkillSummary describes an installed workspace skill discovered from SKILL.md metadata.
type SkillSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
}

// WorkspaceContext holds workspace-scoped instructions and discovered capability descriptors.
type WorkspaceContext struct {
	AgentMD     string
	AgentMDPath string
	Skills      []SkillSummary
	SubAgents   []SubAgentDescriptor
}

func skillTool() plugin.ChatTool {
	return plugin.ChatTool{
		Alias:       "skill",
		Description: "Load the full instructions and companion resource paths of an available workspace skill by name.",
		InputSchema: schema([]string{"name"}, map[string]string{"name": "string"}),
	}
}

// readWorkspaceAgentMD reads AGENTS.md (preferred) or AGENT.md from the workspace root.
// Checking one candidate at a time avoids duplicate injection on case-insensitive filesystems.
func readWorkspaceAgentMD(root *os.Root) (content, relPath string) {
	if root == nil {
		return "", ""
	}
	for _, candidate := range []string{"AGENTS.md", "AGENT.md"} {
		info, err := root.Lstat(candidate)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return "", ""
		}
		if !info.Mode().IsRegular() {
			return "", ""
		}
		f, err := root.Open(candidate)
		if err != nil {
			return "", ""
		}
		text, ok := readBoundedUTF8(f, maxAgentMDBytes)
		_ = f.Close()
		if !ok {
			return "", ""
		}
		if strings.TrimSpace(text) == "" {
			return "", ""
		}
		return text, candidate
	}
	return "", ""
}

func readBoundedUTF8(f *os.File, limit int64) (string, bool) {
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return "", false
	}
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return "", false
	}
	truncated := int64(len(raw)) > limit
	if truncated {
		raw = raw[:limit]
		// Step back over trailing continuation bytes so truncation stays on a UTF-8 rune boundary.
		for len(raw) > 0 && !utf8.RuneStart(raw[len(raw)-1]) {
			raw = raw[:len(raw)-1]
		}
		if len(raw) > 0 && !utf8.Valid(raw) {
			raw = raw[:len(raw)-1]
		}
	}
	if !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 {
		return "", false
	}
	text := string(raw)
	if truncated {
		text += "\n\n[truncated]"
	}
	return text, true
}

func readExactUTF8(root *os.Root, rel string, limit int64) (string, bool) {
	info, err := root.Lstat(rel)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return "", false
	}
	f, err := root.Open(rel)
	if err != nil {
		return "", false
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > limit {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", false
	}
	return string(data), true
}

func openRegularSubdir(root *os.Root, slashRel string) (*os.Root, bool) {
	parts := strings.Split(slashRel, "/")
	cur := root
	var opened []*os.Root
	closeOpened := func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = opened[i].Close()
		}
	}
	for _, part := range parts {
		info, err := cur.Lstat(part)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			closeOpened()
			return nil, false
		}
		next, err := cur.OpenRoot(part)
		if err != nil {
			closeOpened()
			return nil, false
		}
		opened = append(opened, next)
		cur = next
	}
	// Keep only the deepest root open.
	for i := len(opened) - 2; i >= 0; i-- {
		_ = opened[i].Close()
	}
	return cur, true
}

// discoverSkills scans .agent/skills and .agents/skills (former takes precedence on duplicate names)
// and returns deterministically sorted skill metadata.
func discoverSkills(ctx context.Context, root *os.Root) []SkillSummary {
	if root == nil || ctx.Err() != nil {
		return []SkillSummary{}
	}
	byName := make(map[string]SkillSummary)
	for _, baseSlash := range []string{".agent/skills", ".agents/skills"} {
		if ctx.Err() != nil {
			return []SkillSummary{}
		}
		skillsRoot, ok := openRegularSubdir(root, baseSlash)
		if !ok {
			continue
		}
		entries, err := fs.ReadDir(skillsRoot.FS(), ".")
		if err != nil {
			_ = skillsRoot.Close()
			continue
		}
		scanned := 0
		for _, entry := range entries {
			if ctx.Err() != nil {
				_ = skillsRoot.Close()
				return []SkillSummary{}
			}
			if scanned >= maxSkillDirScanEntries {
				break
			}
			scanned++
			if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			skillDir, err := skillsRoot.OpenRoot(entry.Name())
			if err != nil {
				continue
			}
			content, ok := readExactUTF8(skillDir, "SKILL.md", maxSkillMDBytes)
			_ = skillDir.Close()
			if !ok {
				continue
			}
			name, desc := parseSkillFrontmatter(content, entry.Name())
			if _, exists := byName[name]; exists {
				continue
			}
			byName[name] = SkillSummary{
				Name:        name,
				Description: truncateRunes(desc, maxSkillDescRunes),
				Path:        path.Join(baseSlash, entry.Name(), "SKILL.md"),
			}
		}
		_ = skillsRoot.Close()
	}
	out := make([]SkillSummary, 0, len(byName))
	for _, item := range byName {
		out = append(out, item)
	}
	slices.SortFunc(out, func(a, b SkillSummary) int {
		return strings.Compare(a.Name, b.Name)
	})
	if len(out) > maxSkillsLoaded {
		out = out[:maxSkillsLoaded]
	}
	return out
}

func truncateRunes(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if maxRunes <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == maxRunes {
			return strings.TrimSpace(s[:i])
		}
		count++
	}
	return s
}

func parseSkillFrontmatter(content, fallbackName string) (name, description string) {
	content = strings.TrimPrefix(content, "\uFEFF")
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return fallbackName, ""
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "---" || trimmed == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return fallbackName, ""
	}
	fm := lines[1:end]
	for i := 0; i < len(fm); i++ {
		rawLine := fm[i]
		if len(rawLine) == 0 || rawLine[0] == ' ' || rawLine[0] == '\t' || strings.HasPrefix(strings.TrimSpace(rawLine), "#") {
			continue
		}
		colon := strings.IndexByte(rawLine, ':')
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(rawLine[:colon])
		if key != "name" && key != "description" {
			continue
		}
		valPart := strings.TrimSpace(rawLine[colon+1:])
		var val string
		if valPart == "|" || valPart == "|-" || valPart == ">" || valPart == ">-" {
			folded := valPart[0] == '>'
			chompStrip := strings.HasSuffix(valPart, "-")
			var blockLines []string
			j := i + 1
			for j < len(fm) {
				next := fm[j]
				if strings.TrimSpace(next) == "" {
					blockLines = append(blockLines, "")
					j++
					continue
				}
				if next[0] != ' ' && next[0] != '\t' {
					break
				}
				blockLines = append(blockLines, next)
				j++
			}
			i = j - 1
			val = decodeYAMLBlockScalar(blockLines, folded, chompStrip)
		} else {
			val = unquoteYAMLScalar(valPart)
		}
		switch key {
		case "name":
			if trimmed := strings.TrimSpace(val); trimmed != "" {
				name = trimmed
			}
		case "description":
			description = strings.TrimSpace(val)
		}
	}
	if name == "" {
		name = fallbackName
	}
	return name, description
}

func decodeYAMLBlockScalar(lines []string, folded, chompStrip bool) string {
	indent := -1
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		n := 0
		for n < len(line) && (line[n] == ' ' || line[n] == '\t') {
			n++
		}
		if indent < 0 || n < indent {
			indent = n
		}
	}
	if indent < 0 {
		return ""
	}
	stripped := make([]string, len(lines))
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			stripped[i] = ""
			continue
		}
		if len(line) >= indent {
			stripped[i] = line[indent:]
		} else {
			stripped[i] = strings.TrimLeft(line, " \t")
		}
	}
	for len(stripped) > 0 && stripped[len(stripped)-1] == "" {
		stripped = stripped[:len(stripped)-1]
	}
	if len(stripped) == 0 {
		return ""
	}
	var out string
	if !folded {
		out = strings.Join(stripped, "\n")
	} else {
		var b strings.Builder
		for idx, line := range stripped {
			if idx > 0 {
				if line == "" || stripped[idx-1] == "" {
					b.WriteByte('\n')
				} else {
					b.WriteByte(' ')
				}
			}
			b.WriteString(line)
		}
		out = b.String()
	}
	if chompStrip {
		out = strings.TrimRight(out, "\n")
	}
	return out
}

func unquoteYAMLScalar(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		inner := raw[1 : len(raw)-1]
		inner = strings.ReplaceAll(inner, `\"`, `"`)
		inner = strings.ReplaceAll(inner, `\\`, `\`)
		inner = strings.ReplaceAll(inner, `\n`, "\n")
		return inner
	}
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		return strings.ReplaceAll(raw[1:len(raw)-1], "''", "'")
	}
	return raw
}

func runSkill(ctx context.Context, root *os.Root, raw json.RawMessage) (string, error) {
	var args struct {
		Name string `json:"name"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil || strings.TrimSpace(args.Name) == "" {
		return "", errors.New("skill name is required")
	}
	skills := discoverSkills(ctx, root)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	var matched *SkillSummary
	names := make([]string, 0, len(skills))
	for i := range skills {
		names = append(names, skills[i].Name)
		if skills[i].Name == args.Name {
			matched = &skills[i]
		}
	}
	if matched == nil {
		if len(names) == 0 {
			return "", fmt.Errorf("unknown skill %q; no workspace skills are available", args.Name)
		}
		return "", fmt.Errorf("unknown skill %q; available skills: %s", args.Name, strings.Join(names, ", "))
	}

	skillDirSlash := path.Dir(matched.Path)
	skillRoot, ok := openRegularSubdir(root, skillDirSlash)
	if !ok {
		return "", errors.New("skill directory unavailable")
	}
	defer skillRoot.Close()

	content, ok := readExactUTF8(skillRoot, "SKILL.md", maxSkillMDBytes)
	if !ok {
		return "", errors.New("SKILL.md is unreadable or exceeds size limit")
	}

	companions := listSkillCompanionFiles(ctx, skillRoot)
	var out strings.Builder
	fmt.Fprintf(&out, "Skill: %s\nDirectory: %s\n", matched.Name, skillDirSlash)
	if len(companions) > 0 {
		out.WriteString("Companion files:\n")
		for _, rel := range companions {
			fmt.Fprintf(&out, "- %s\n", rel)
		}
	}
	out.WriteByte('\n')
	out.WriteString(content)
	return out.String(), nil
}

func listSkillCompanionFiles(ctx context.Context, skillRoot *os.Root) []string {
	var files []string
	_ = fs.WalkDir(skillRoot.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return nil
		}
		if p == "." {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if p == "SKILL.md" || !d.Type().IsRegular() {
			return nil
		}
		files = append(files, p)
		if len(files) >= maxSkillCompanionFiles {
			return errOutputLimit
		}
		return nil
	})
	slices.Sort(files)
	return files
}

func formatWorkspaceInstructionsPrompt(agentMD, agentMDPath string, skills []SkillSummary) string {
	var sections []string
	if agentMD != "" && agentMDPath != "" {
		sections = append(sections, fmt.Sprintf("<workspace_instructions path=%q>\n%s\n</workspace_instructions>", agentMDPath, agentMD))
	}
	if len(skills) > 0 {
		var b strings.Builder
		b.WriteString("<available_skills>\n")
		b.WriteString("Use the skill tool with a skill name to load its full instructions when relevant.\n")
		for _, s := range skills {
			fmt.Fprintf(&b, "<skill name=%q path=%q>%s</skill>\n", s.Name, s.Path, s.Description)
		}
		b.WriteString("</available_skills>")
		sections = append(sections, b.String())
	}
	return strings.Join(sections, "\n\n")
}
