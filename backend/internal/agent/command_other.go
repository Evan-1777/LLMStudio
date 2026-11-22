//go:build !windows && !linux && !darwin

package agent

import (
	"context"
	"errors"
	"os"
)

const shellSyntax = "unavailable shell syntax"

func commandPath() string { return "" }
func launchCommand(context.Context, string, string, string, *os.File) error {
	return errors.New("shell unavailable")
}
