//go:build !windows

package mcp

import "os/exec"

func configureStdioCmd(_ *exec.Cmd) {}
