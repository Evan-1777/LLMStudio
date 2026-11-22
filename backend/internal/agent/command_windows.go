package agent

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const shellSyntax = "Windows PowerShell syntax"

func commandPath() string {
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return ""
	}
	exe := filepath.Join(dir, "WindowsPowerShell", "v1.0", "powershell.exe")
	if fi, err := os.Stat(exe); err == nil && fi.Mode().IsRegular() {
		return exe
	}
	return ""
}

func launchCommand(ctx context.Context, shell, dir, command string, output *os.File) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}
	nul, err := os.Open("NUL")
	if err != nil {
		return err
	}
	defer nul.Close()
	own := windows.CurrentProcess()
	handles := make([]windows.Handle, 2)
	for i, h := range []uintptr{nul.Fd(), output.Fd()} {
		if err := windows.DuplicateHandle(own, windows.Handle(h), own, &handles[i], 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return err
		}
		defer windows.CloseHandle(handles[i])
	}
	attrs, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return err
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), unsafe.Sizeof(handles[0])*2); err != nil {
		return err
	}
	// PROC_THREAD_ATTRIBUTE_JOB_LIST (Windows 10+) assigns the job before user code runs.
	const jobList = 0x0002000D
	if err := attrs.Update(jobList, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return err
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.StdInput, startup.StdOutput, startup.StdErr = handles[0], handles[1], handles[1]
	// Windows PowerShell expects UTF-16LE for -EncodedCommand. This preserves quotes and newlines.
	script := "[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + command
	var scriptBytes []byte
	for _, unit := range utf16.Encode([]rune(script)) {
		scriptBytes = binary.LittleEndian.AppendUint16(scriptBytes, unit)
	}
	encoded := base64.StdEncoding.EncodeToString(scriptBytes)
	if len(encoded) > 32000 {
		return fmt.Errorf("command exceeds Windows PowerShell length limit")
	}
	args, _ := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded}))
	exe, _ := windows.UTF16PtrFromString(shell)
	folder, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	names := commandEnvironment()
	slices.SortFunc(names, func(a, b string) int { return strings.Compare(strings.ToUpper(a), strings.ToUpper(b)) })
	env := append(utf16.Encode([]rune(strings.Join(names, "\x00"))), 0, 0)
	var process windows.ProcessInformation
	err = windows.CreateProcess(exe, args, nil, nil, true, windows.CREATE_NO_WINDOW|windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT, &env[0], folder, &startup.StartupInfo, &process)
	runtime.KeepAlive(handles)
	runtime.KeepAlive(job)
	if err != nil {
		return err
	}
	windows.CloseHandle(process.Thread)
	defer windows.CloseHandle(process.Process)
	done := make(chan error, 1)
	go func() {
		_, err := windows.WaitForSingleObject(process.Process, windows.INFINITE)
		if err == nil {
			var code uint32
			err = windows.GetExitCodeProcess(process.Process, &code)
			if err == nil && code != 0 {
				err = fmt.Errorf("exit status %d", code)
			}
		}
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = windows.TerminateJobObject(job, 1)
		<-done
		return ctx.Err()
	}
}
