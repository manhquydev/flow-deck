package flow

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

type fixture struct {
	Root     string
	Worktree string
	FlowBin  string
}

func cardMD(id, title, status, deps, risk, evidence string) string {
	if evidence == "" && status == "done" {
		evidence = "$ curl https://x/healthz -> 200 PASS\npath src/cli.mjs exists\n"
	}
	check := " "
	if status == "done" {
		check = "x"
	}
	if risk == "" {
		risk = "standard"
	}
	return "# " + id + " — " + title + "\n\n" +
		"status: " + status + "\n" +
		"deps: " + deps + "\n" +
		"risk: " + risk + "\n" +
		"risk-reason: fixture\n" +
		"risk-ack: none\n\n" +
		"## Scope\n\n" + title + "\n\n" +
		"## Allowed files\n\n- src/\n\n" +
		"## Verify\n\n- [" + check + "] fixture\n\n" +
		"## Done-evidence\n\nnamed before building\n\n" +
		"## Evidence\n\n" + evidence
}

func git(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.SysProcAttr = sysProcAttr()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func makeFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.MkdirTemp(os.TempDir(), "flow-deck-fx-")
	if err != nil {
		t.Fatal(err)
	}
	root := Canonical(raw)
	worktree := filepath.Join(filepath.Dir(root), filepath.Base(root)+"-C-001")

	t.Cleanup(func() {
		ClearCheckCache(root)
		_ = os.RemoveAll(root)
		_ = os.RemoveAll(worktree)
	})

	mustMkdir := func(p string) {
		t.Helper()
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite := func(p, s string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	mustMkdir(filepath.Join(root, "cards"))
	mustMkdir(filepath.Join(root, ".flow"))
	mustMkdir(filepath.Join(root, "bin"))

	mustWrite(filepath.Join(root, "cards", "C-001.md"), cardMD("C-001", "Has worktree", "todo", "none", "", ""))
	mustWrite(filepath.Join(root, "cards", "C-002.md"), cardMD("C-002", "Deps unmet", "todo", "C-001", "", ""))
	mustWrite(filepath.Join(root, "cards", "C-003.md"), cardMD("C-003", "Already done", "done", "none", "", ""))
	mustWrite(filepath.Join(root, "cards", "C-004.md"), cardMD("C-004", "Payments halt", "todo", "none", "security-class", ""))
	mustWrite(filepath.Join(root, "cards", "C-005.md"), cardMD("C-005", "In flight", "todo", "none", "", ""))
	mustWrite(filepath.Join(root, "cards", "C-006.md"), cardMD("C-006", "Plain todo", "todo", "none", "", ""))
	mustWrite(filepath.Join(root, "cards", ".inflight"), "C-005 1710000000\n")

	mustWrite(filepath.Join(root, "DEBT.md"), `# DEBT

- [ ] DEBT: security-class C-004 -- payments exposure -- close before: operator ack -- opened 2026-08-20 (cards: C-004)
- [x] DEBT: old closed security-class C-006 -- should not halt
- [ ] DEBT: macOS timeout unbounded -- not a security-class line
`)
	mustWrite(filepath.Join(root, "AUTO-LOG.md"), `- C-005 | title | BLOCKED | NEEDS_CONTEXT | 2026-08-20
`)

	flowSh := filepath.Join(root, "bin", "flow.sh")
	mustWrite(flowSh, `#!/usr/bin/env bash
set -u
cmd="${1:-}"
id="${2:-}"
case "$cmd" in
  check)
    echo "CHECK_CWD=$PWD"
    echo "CARD=$id"
    if [[ -f .pass ]]; then
      echo "PASS: $id"
      exit 0
    fi
    echo "FAIL: $id (no .pass in $PWD)"
    exit 1
    ;;
  ready)
    echo "flow ready - buildable todo cards (deps met). Operator dispatches; runner advises."
    echo "  BUILDABLE C-001  (deps: none)"
    echo "  BUILDABLE C-006  (deps: none)"
    echo "  blocked   C-002  (deps unmet or evidence floor failed: C-001)"
    exit 0
    ;;
  *)
    echo "fake-flow: unknown $cmd" >&2
    exit 2
    ;;
esac
`)
	if err := os.Chmod(flowSh, 0o755); err != nil {
		t.Fatal(err)
	}

	flowCmd := filepath.Join(root, "bin", "flow.cmd")
	mustWrite(flowCmd, `@echo off
setlocal EnableExtensions
set "cmd=%~1"
set "id=%~2"

if /I "%cmd%"=="check" goto :check
if /I "%cmd%"=="ready" goto :ready
echo fake-flow: unknown %cmd% 1>&2
exit /b 2

:check
echo CHECK_CWD=%CD%
echo CARD=%id%
if exist ".pass" (
  echo PASS: %id%
  exit /b 0
)
echo FAIL: %id% (no .pass in %CD%)
exit /b 1

:ready
echo flow ready - buildable todo cards (deps met). Operator dispatches; runner advises.
echo   BUILDABLE C-001  (deps: none)
echo   BUILDABLE C-006  (deps: none)
echo   blocked   C-002  (deps unmet or evidence floor failed: C-001)
exit /b 0
`)

	flowBin := flowSh
	if runtime.GOOS == "windows" {
		flowBin = flowCmd
	}

	mustWrite(filepath.Join(root, "README.md"), "fixture\n")
	git(t, root, "init", "-q")
	git(t, root, "config", "user.email", "fx@example.test")
	git(t, root, "config", "user.name", "fixture")
	git(t, root, "add", "-A")
	git(t, root, "commit", "-qm", "fixture")
	git(t, root, "worktree", "add", "-q", worktree, "-b", "card/C-001")
	worktree = Canonical(worktree)
	mustWrite(filepath.Join(worktree, ".pass"), "ok\n")

	rec1 := `{"worktree_path":` + jsonString(worktree) + `,"branch":"card/C-001","vendor":"claude","agent_session_id":"/dev/pts/9","card_id":"C-001","task_label":"build","owned_files_glob":"src/","port_offset":0,"created_at":1,"status":"active"}`
	rec2 := `{"worktree_path":` + jsonString(worktree) + `,"branch":"card/C-001","vendor":"claude","agent_session_id":"/tmp/secret-session.jsonl","card_id":"C-001","task_label":"build","owned_files_glob":"src/","port_offset":2,"created_at":2,"status":"active"}`
	mustWrite(filepath.Join(root, ".flow", "workspaces.jsonl"), rec1+"\nnot-json\n"+rec2+"\n")

	ClearCheckCache(root)
	return fixture{Root: root, Worktree: worktree, FlowBin: flowBin}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
