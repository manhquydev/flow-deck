package flow

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"syscall"
	"time"
)

const (
	CheckTimeout = 30 * time.Second
	GitTimeout   = 5 * time.Second
)

// cmd.exe metacharacters. Card ids and verbs (`check`, `ready`) are safe.
var cmdSafeArg = regexp.MustCompile(`^[A-Za-z0-9._+\-:]+$`)

type execResult struct {
	RC       int
	Stdout   string
	Stderr   string
	TimedOut bool
	ExecKind string
}

func spawnFlow(bin string, args []string, cwd string, timeout time.Duration) execResult {
	if needsArgAllowlist(bin) {
		for _, a := range args {
			if !cmdSafeArg.MatchString(a) {
				return execResult{
					RC:       1,
					Stderr:   "refusing to spawn flow.cmd with unsafe args",
					ExecKind: "refused",
				}
			}
		}
	}
	if timeout <= 0 {
		timeout = CheckTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	cmd.SysProcAttr = sysProcAttr()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded
	out, errb := stdout.String(), stderr.String()
	if err != nil && !timedOut {
		errb = appendSpawnErr(errb, err)
	}
	rc, kind := classifySpawn(err, timedOut)
	return execResult{RC: rc, Stdout: out, Stderr: errb, TimedOut: timedOut, ExecKind: kind}
}

func appendSpawnErr(stderr string, err error) string {
	msg := err.Error()
	if stderr == "" {
		return msg
	}
	return stderr + "\n" + msg
}

func classifySpawn(err error, timedOut bool) (rc int, kind string) {
	if timedOut {
		return 124, "timeout"
	}
	if err == nil {
		return 0, "ran"
	}
	if isNotFound(err) {
		return 127, "enoent"
	}
	if isPermission(err) {
		return 126, "eacces"
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), "ran"
	}
	return 1, "spawn-error"
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, exec.ErrNotFound) {
		return true
	}
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		return errors.Is(pe.Err, os.ErrNotExist) || errors.Is(pe.Err, syscall.ENOENT)
	}
	var ee *exec.Error
	if errors.As(err, &ee) {
		return errors.Is(ee.Err, exec.ErrNotFound) || errors.Is(ee.Err, os.ErrNotExist)
	}
	return false
}

func isPermission(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrPermission) {
		return true
	}
	if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
		return true
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		return errors.Is(pe.Err, os.ErrPermission) ||
			errors.Is(pe.Err, syscall.EACCES) ||
			errors.Is(pe.Err, syscall.EPERM)
	}
	return false
}

func runGit(cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), GitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = cwd
	cmd.SysProcAttr = sysProcAttr()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.String(), err
	}
	return stdout.String(), nil
}
