//go:build linux || darwin

package agent

import (
	"context"
	"os"
	"os/exec"
	"syscall"
)

const shellSyntax = "Bash syntax"

func commandPath() string { path, _ := exec.LookPath("bash"); return path }

func launchCommand(ctx context.Context, shell, dir, command string, output *os.File) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd := exec.Command(shell, "--noprofile", "--norc", "-c", command)
	cmd.Dir, cmd.Env, cmd.Stdout, cmd.Stderr = dir, commandEnvironment(), output, output
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// ponytail: the job owns the process group; deliberately detached sessions require an OS sandbox.
	kill := func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	defer kill()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		kill()
		<-done
		return ctx.Err()
	}
}
