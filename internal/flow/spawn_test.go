package flow

import (
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestCmdSafeArg(t *testing.T) {
	ok := []string{"check", "ready", "C-001", "C-12", "flow.sh", "a_b", "x+y", "n-1"}
	for _, s := range ok {
		if !cmdSafeArg.MatchString(s) {
			t.Fatalf("expected safe %q", s)
		}
	}
	bad := []string{"C-001 & calc", "foo|bar", "a>b", "a<b", "a^b", "a(b)", "hello world", ""}
	for _, s := range bad {
		if cmdSafeArg.MatchString(s) {
			t.Fatalf("expected unsafe %q", s)
		}
	}
}

func TestWindowsNeedsArgAllowlist(t *testing.T) {
	if runtime.GOOS != "windows" {
		if needsArgAllowlist("flow.cmd") {
			t.Fatal("unix must not allowlist by extension")
		}
		return
	}
	if !needsArgAllowlist(`C:\bin\flow.cmd`) {
		t.Fatal(".cmd must allowlist")
	}
	if !needsArgAllowlist(`C:\bin\flow.bat`) {
		t.Fatal(".bat must allowlist")
	}
	if needsArgAllowlist(`C:\bin\flow.exe`) {
		t.Fatal(".exe is not cmd")
	}
}

func TestSpawnRefusesUnsafeCmdArgs(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("arg allowlist is Windows .cmd/.bat only")
	}
	got := spawnFlow(`C:\missing\flow.cmd`, []string{"check", "C-001 & calc"}, ".", time.Second)
	if got.ExecKind != "refused" {
		t.Fatalf("kind %s", got.ExecKind)
	}
	if got.RC != 1 {
		t.Fatalf("rc %d", got.RC)
	}
}

func TestSpawnMissingBinEnoent(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-flow.sh")
	got := spawnFlow(missing, []string{"check", "C-001"}, t.TempDir(), time.Second)
	if got.ExecKind != "enoent" {
		t.Fatalf("kind %s stderr %s", got.ExecKind, got.Stderr)
	}
	if got.RC != 127 {
		t.Fatalf("rc %d", got.RC)
	}
}
