package agent

import (
	"context"
	"os"
)

// SubAgentsDir is the reserved workspace directory for future SubAgent definitions.
// 预留接口，尚未启用。
const SubAgentsDir = ".agent/subagents"

// SubAgentDescriptor describes a discoverable workspace SubAgent definition.
// 预留接口，尚未启用。
type SubAgentDescriptor struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Path         string   `json:"path"`
	Model        string   `json:"model,omitempty"`
	AllowedTools []string `json:"allowedTools,omitempty"`
}

// SubAgentRequest carries a single delegated SubAgent execution request.
// 预留接口，尚未启用。
type SubAgentRequest struct {
	Name       string `json:"name"`
	Prompt     string `json:"prompt"`
	WorkingDir string `json:"workingDir,omitempty"`
}

// SubAgentResult carries the outcome of a SubAgent execution.
// 预留接口，尚未启用。
type SubAgentResult struct {
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

// SubAgentRunner defines the reserved execution contract for future SubAgent orchestration.
// 预留接口，尚未启用，当前不挂载至运行时工具或 HTTP 路由。
type SubAgentRunner interface {
	Discover(ctx context.Context, root *os.Root) ([]SubAgentDescriptor, error)
	Run(ctx context.Context, root *os.Root, req SubAgentRequest) (SubAgentResult, error)
}
