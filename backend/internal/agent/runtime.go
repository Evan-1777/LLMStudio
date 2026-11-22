package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"llmstudio/backend/internal/domain"
	"llmstudio/backend/internal/plugin"
)

const (
	DirectoryReady       = "ready"
	DirectoryUnset       = "unset"
	DirectoryUnavailable = "unavailable"
)

type PolicyStore interface {
	AgentSettings(context.Context) (string, []string, error)
	UpdateAgentSettings(context.Context, *string, *[]string) error
	AgentTopic(context.Context, string) (string, string, error)
	SetAgentDirectory(context.Context, string, string) error
}

// Runtime belongs to exactly one execution endpoint. Gateway roots are explicit,
// including when no root was configured; desktop directories are absolute.
type Runtime struct {
	store         PolicyStore
	gateway       bool
	base          string
	authenticated bool
}

func NewGateway(store PolicyStore, base string, authenticated bool) *Runtime {
	return &Runtime{store: store, gateway: true, base: base, authenticated: authenticated}
}

func NewDesktop(store PolicyStore) *Runtime {
	return &Runtime{store: store, authenticated: true}
}

type Directory struct {
	Path     string `json:"path"`
	Status   string `json:"status"`
	Override bool   `json:"override,omitempty"`
}

type Settings struct {
	Directory      Directory `json:"directory"`
	AllowedTools   []string  `json:"allowedTools"`
	AvailableTools []string  `json:"availableTools"`
}

type SettingsPatch struct {
	DefaultDirectory *string   `json:"defaultDirectory"`
	AllowedTools     *[]string `json:"allowedTools"`
}

type DirectoryListing struct {
	Path        string   `json:"path"`
	Directories []string `json:"directories"`
}

func unavailable() error {
	return domain.NewError(domain.ErrCodeInvalidArgument, "Agent 工作目录不可用", nil)
}

func (a *Runtime) IsGateway() bool { return a.gateway }

func (a *Runtime) RequireAccess() error {
	if a == nil || !a.authenticated {
		return domain.NewError(domain.ErrCodeUnauthorized, "Agent 需要已认证的连接", nil)
	}
	return nil
}

func (a *Runtime) open(path string) (*os.Root, error) {
	if !a.gateway {
		if !filepath.IsAbs(path) {
			return nil, unavailable()
		}
		return openDirectory(path)
	}
	if !filepath.IsAbs(a.base) {
		return nil, unavailable()
	}
	rel, err := relative(path)
	if err != nil {
		return nil, err
	}
	base, err := openDirectory(a.base)
	if err != nil {
		return nil, err
	}
	if rel == "." {
		return base, nil
	}
	defer base.Close()
	if info, err := base.Stat(rel); err != nil || !info.IsDir() {
		return nil, unavailable()
	}
	return base.OpenRoot(rel)
}

func openDirectory(path string) (*os.Root, error) {
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		return nil, unavailable()
	}
	return os.OpenRoot(path)
}

func (a *Runtime) directory(path string, override bool) Directory {
	if a.gateway && path == "" {
		path = "."
	}
	d := Directory{Path: path, Override: override, Status: DirectoryUnavailable}
	if path == "" {
		d.Status = DirectoryUnset
		return d
	}
	root, err := a.open(path)
	if err == nil {
		root.Close()
		d.Status = DirectoryReady
	}
	return d
}

func definitions() []plugin.ChatTool {
	tools := slices.Clone(fileTools)
	if commandPath() != "" {
		tools = append(tools, commandTool())
	}
	return tools
}

func (a *Runtime) Settings(ctx context.Context) (Settings, error) {
	if err := a.RequireAccess(); err != nil {
		return Settings{}, err
	}
	path, allowed, err := a.store.AgentSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	available := []string{}
	for _, tool := range definitions() {
		available = append(available, tool.Alias)
	}
	return Settings{a.directory(path, false), allowed, available}, nil
}

func (a *Runtime) UpdateSettings(ctx context.Context, patch SettingsPatch) (Settings, error) {
	if err := a.RequireAccess(); err != nil {
		return Settings{}, err
	}
	if patch.DefaultDirectory != nil && *patch.DefaultDirectory != "" {
		path, err := a.validatePath(*patch.DefaultDirectory)
		if err != nil {
			return Settings{}, err
		}
		patch.DefaultDirectory = &path
	}
	if patch.AllowedTools != nil {
		seen := map[string]bool{}
		for _, name := range *patch.AllowedTools {
			if seen[name] || (name != "bash" && !slices.ContainsFunc(fileTools, func(tool plugin.ChatTool) bool { return tool.Alias == name })) {
				return Settings{}, domain.NewError(domain.ErrCodeInvalidArgument, "无效的 Agent 工具名单", nil)
			}
			seen[name] = true
		}
	}
	if err := a.store.UpdateAgentSettings(ctx, patch.DefaultDirectory, patch.AllowedTools); err != nil {
		return Settings{}, err
	}
	return a.Settings(ctx)
}

func (a *Runtime) validatePath(path string) (string, error) {
	root, err := a.open(path)
	if err != nil {
		return "", unavailable()
	}
	root.Close()
	if a.gateway {
		return filepath.ToSlash(filepath.Clean(path)), nil
	}
	return filepath.Clean(path), nil
}

func (a *Runtime) TopicDirectory(ctx context.Context, id string) (Directory, error) {
	if err := a.RequireAccess(); err != nil {
		return Directory{}, err
	}
	_, path, err := a.store.AgentTopic(ctx, id)
	if err != nil {
		return Directory{}, err
	}
	override := path != ""
	if !override {
		path, _, err = a.store.AgentSettings(ctx)
		if err != nil {
			return Directory{}, err
		}
	}
	return a.directory(path, override), nil
}

func (a *Runtime) UpdateTopic(ctx context.Context, id, path string) (Directory, error) {
	if err := a.RequireAccess(); err != nil {
		return Directory{}, err
	}
	if _, _, err := a.store.AgentTopic(ctx, id); err != nil {
		return Directory{}, err
	}
	if path != "" {
		v, err := a.validatePath(path)
		if err != nil {
			return Directory{}, err
		}
		path = v
	}
	if err := a.store.SetAgentDirectory(ctx, id, path); err != nil {
		return Directory{}, err
	}
	return a.TopicDirectory(ctx, id)
}

func (a *Runtime) ListDirectories(ctx context.Context, path string) (DirectoryListing, error) {
	if err := a.RequireAccess(); err != nil {
		return DirectoryListing{}, err
	}
	if !a.gateway {
		return DirectoryListing{}, domain.NewError(domain.ErrCodeNotFound, "请使用系统目录选择器", nil)
	}
	rel, err := relative(path)
	if err != nil {
		return DirectoryListing{}, unavailable()
	}
	root, err := a.open(path)
	if err != nil {
		return DirectoryListing{}, unavailable()
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return DirectoryListing{}, unavailable()
	}
	listing := DirectoryListing{filepath.ToSlash(rel), []string{}}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return DirectoryListing{}, err
		}
		if e.IsDir() && e.Type()&os.ModeSymlink == 0 {
			if child, err := root.OpenRoot(e.Name()); err == nil {
				child.Close()
				listing.Directories = append(listing.Directories, e.Name())
			}
		}
	}
	return listing, nil
}

func (a *Runtime) authorized(ctx context.Context, id string) (*os.Root, []string, error) {
	if err := a.RequireAccess(); err != nil {
		return nil, nil, err
	}
	mode, path, err := a.store.AgentTopic(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if mode != domain.ConversationModeAgent {
		return nil, nil, errors.New("Agent mode is not active")
	}
	fallback, tools, err := a.store.AgentSettings(ctx)
	if err != nil {
		return nil, nil, err
	}
	if path == "" {
		path = fallback
	}
	root, err := a.open(path)
	if err != nil {
		return nil, nil, unavailable()
	}
	return root, tools, nil
}

func (a *Runtime) Tools(ctx context.Context, id string) ([]plugin.ChatTool, error) {
	root, allowed, err := a.authorized(ctx, id)
	if err != nil {
		return nil, err
	}
	root.Close()
	var tools []plugin.ChatTool
	for _, def := range definitions() {
		if slices.Contains(allowed, def.Alias) {
			tools = append(tools, def)
		}
	}
	return tools, nil
}

func (a *Runtime) Execute(ctx context.Context, id, name string, args json.RawMessage) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	root, allowed, err := a.authorized(ctx, id)
	if err != nil {
		return "", errors.New("Agent workspace or tool authorization unavailable")
	}
	defer root.Close()
	if !slices.Contains(allowed, name) {
		return "", errors.New("Agent tool is disabled")
	}
	if name == "bash" {
		return runCommand(ctx, root, args)
	}
	if !slices.ContainsFunc(fileTools, func(def plugin.ChatTool) bool { return def.Alias == name }) {
		return "", errors.New("unknown Agent tool")
	}
	return runFile(ctx, root, name, args)
}
