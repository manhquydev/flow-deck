package flow

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func byID(board Board) map[string]Row {
	out := map[string]Row{}
	for _, r := range board.Rows {
		out[r.ID] = r
	}
	return out
}

func TestBoardStateSevenStatesNeverLivenessPass(t *testing.T) {
	fx := makeFixture(t)
	board := BoardState(fx.Root)
	rows := byID(board)

	if rows["C-001"].State != "building" {
		t.Fatalf("worktree present → building, not pass; got %s", rows["C-001"].State)
	}
	if rows["C-001"].State == "check-pass" {
		t.Fatal("liveness must not be check-pass")
	}
	if rows["C-001"].CwdUnsafe {
		t.Fatal("C-001 cwdUnsafe")
	}
	if rows["C-001"].Worktree != fx.Worktree {
		t.Fatalf("worktree %q != %q", rows["C-001"].Worktree, fx.Worktree)
	}
	if rows["C-001"].Vendor != "claude" {
		t.Fatalf("vendor %q", rows["C-001"].Vendor)
	}
	if rows["C-001"].LastCheck != nil {
		t.Fatal("lastCheck should be nil")
	}

	if rows["C-002"].State != "ready-blocked" {
		t.Fatalf("C-002 state %s", rows["C-002"].State)
	}
	if !rows["C-002"].Flags.ReadyBlocked {
		t.Fatal("C-002 readyBlocked")
	}
	if rows["C-002"].Flags.SecurityHalt {
		t.Fatal("C-002 securityHalt")
	}
	if !rows["C-002"].CwdUnsafe {
		t.Fatal("C-002 should be cwdUnsafe")
	}

	if rows["C-003"].State != "done" {
		t.Fatalf("C-003 state %s", rows["C-003"].State)
	}
	if rows["C-003"].EvidenceEmpty {
		t.Fatal("C-003 evidence empty")
	}

	if rows["C-004"].State != "security-halt" {
		t.Fatalf("C-004 state %s", rows["C-004"].State)
	}
	if !rows["C-004"].Flags.SecurityHalt {
		t.Fatal("C-004 securityHalt")
	}
	if rows["C-004"].Flags.ReadyBlocked {
		t.Fatal("C-004 readyBlocked")
	}

	if rows["C-005"].State != "building" {
		t.Fatalf("C-005 state %s", rows["C-005"].State)
	}
	if !rows["C-005"].Inflight {
		t.Fatal("C-005 inflight")
	}
	if !rows["C-005"].Flags.SubagentBlocked {
		t.Fatal("C-005 subagentBlocked")
	}

	if rows["C-006"].State != "todo" {
		t.Fatalf("C-006 state %s", rows["C-006"].State)
	}

	for _, row := range board.Rows {
		raw, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		s := string(raw)
		if strings.Contains(s, "agent_session_id") {
			t.Fatalf("row leaked agent_session_id: %s", s)
		}
		if strings.Contains(s, "/dev/pts/") {
			t.Fatalf("row leaked tty path: %s", s)
		}
		if strings.Contains(s, "secret-session") {
			t.Fatalf("row leaked session path: %s", s)
		}
	}
}

func TestRunCheckUsesCardWorktreeCwd(t *testing.T) {
	fx := makeFixture(t)
	pass := RunCheck(fx.Root, "C-001", fx.FlowBin)
	if pass.CwdUnsafe {
		t.Fatal("pass cwdUnsafe")
	}
	if pass.Cwd != fx.Worktree {
		t.Fatalf("cwd %q != %q", pass.Cwd, fx.Worktree)
	}
	if pass.RC != 0 {
		t.Fatalf("rc %d stderr %s", pass.RC, pass.Stderr)
	}
	if !strings.Contains(pass.Stdout, "CHECK_CWD=") {
		t.Fatalf("stdout %q", pass.Stdout)
	}
	if !strings.Contains(pass.Stdout, "PASS: C-001") {
		t.Fatalf("stdout %q", pass.Stdout)
	}
	if !strings.Contains(pass.Stdout, fx.Worktree) && pass.Cwd != fx.Worktree {
		t.Fatal("check did not run in sibling worktree")
	}
	if pass.Cwd == fx.Root {
		t.Fatal("must not check from project root")
	}

	after := byID(BoardState(fx.Root))
	if after["C-001"].State != "check-pass" {
		t.Fatalf("after state %s", after["C-001"].State)
	}
	if after["C-001"].LastCheck == nil || after["C-001"].LastCheck.RC != 0 {
		t.Fatal("lastCheck rc")
	}

	unsafe := RunCheck(fx.Root, "C-002", fx.FlowBin)
	if !unsafe.CwdUnsafe {
		t.Fatal("C-002 cwdUnsafe")
	}
	if unsafe.Cwd != fx.Root {
		t.Fatalf("unsafe cwd %q != %q", unsafe.Cwd, fx.Root)
	}
	if unsafe.RC != 1 {
		t.Fatalf("root has no .pass; rc %d", unsafe.RC)
	}
	if !strings.Contains(unsafe.Stdout, "FAIL: C-002") {
		t.Fatalf("stdout %q", unsafe.Stdout)
	}

	failRow := byID(BoardState(fx.Root))["C-002"]
	if failRow.State != "check-fail" {
		t.Fatalf("fail state %s", failRow.State)
	}
	if !failRow.Flags.ReadyBlocked {
		t.Fatal("ready-blocked flag stays even after a fail")
	}
	if failRow.State == "ready-blocked" {
		t.Fatal("last check rc is the row state")
	}
}

func TestFindProjectRootAndJSONLTolerant(t *testing.T) {
	fx := makeFixture(t)
	if got := FindProjectRoot(fx.Root); got != fx.Root {
		t.Fatalf("root %q != %q", got, fx.Root)
	}
	if got := FindProjectRoot(filepath.Join(fx.Root, "cards")); got != fx.Root {
		t.Fatalf("from cards %q", got)
	}
	nowhere, err := os.MkdirTemp(os.TempDir(), "flow-deck-none-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(nowhere) })
	if FindProjectRoot(nowhere) != "" {
		t.Fatal("nowhere should be empty")
	}

	cards := ListCards(fx.Root)
	if len(cards) != 6 {
		t.Fatalf("cards %d", len(cards))
	}
	if cards[0].ID != "C-001" {
		t.Fatalf("first %s", cards[0].ID)
	}

	ws := ListWorkspaces(fx.Root)
	c1, ok := ws["C-001"]
	if !ok {
		t.Fatal("missing C-001 workspace")
	}
	if c1.Worktree != fx.Worktree {
		t.Fatalf("ws worktree %q != %q", c1.Worktree, fx.Worktree)
	}
	if c1.Vendor != "claude" {
		t.Fatalf("vendor %q", c1.Vendor)
	}
	if c1.Branch != "card/C-001" {
		t.Fatalf("branch %q", c1.Branch)
	}
	raw, _ := json.Marshal(c1)
	if strings.Contains(string(raw), "agent_session_id") {
		t.Fatalf("workspace leaked session: %s", raw)
	}
}

func TestRootPassNoWorktreeNeverCheckPass(t *testing.T) {
	fx := makeFixture(t)
	if err := os.WriteFile(filepath.Join(fx.Root, ".pass"), []byte("ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := RunCheck(fx.Root, "C-006", fx.FlowBin)
	if !result.CwdUnsafe {
		t.Fatal("cwdUnsafe")
	}
	if result.Cwd != fx.Root {
		t.Fatalf("cwd %q", result.Cwd)
	}
	if result.RC != 0 {
		t.Fatalf("root .pass should make flow.sh exit 0; rc %d %s", result.RC, result.Stderr)
	}
	row := byID(BoardState(fx.Root))["C-006"]
	if !row.CwdUnsafe {
		t.Fatal("row cwdUnsafe")
	}
	if row.State == "check-pass" {
		t.Fatal("cwdUnsafe never check-pass")
	}
	if row.LastCheck == nil || row.LastCheck.RC != 0 || !row.LastCheck.CwdUnsafe {
		t.Fatalf("lastCheck %+v", row.LastCheck)
	}
}

func TestJSONLOnlyWorktreeCwdUnsafeNotCheckPass(t *testing.T) {
	fx := makeFixture(t)
	evil, err := os.MkdirTemp(os.TempDir(), "flow-deck-evil-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(evil) })
	if err := os.WriteFile(filepath.Join(evil, ".pass"), []byte("ok\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(fx.Root, ".flow", "workspaces.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	rec := `{"worktree_path":` + jsonString(evil) + `,"branch":"card/C-006","vendor":"claude","card_id":"C-006","status":"active","created_at":3}` + "\n"
	if _, err := f.WriteString(rec); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	got, ok := ListWorkspaces(fx.Root)["C-006"]
	if !ok {
		t.Fatal("missing C-006 rec")
	}
	if got.FromGit {
		t.Fatal("jsonl-only must not be fromGit")
	}

	result := RunCheck(fx.Root, "C-006", fx.FlowBin)
	if !result.CwdUnsafe {
		t.Fatal("cwdUnsafe")
	}
	if result.Cwd != fx.Root {
		t.Fatalf("cwd %q", result.Cwd)
	}
	if result.Cwd == Canonical(evil) {
		t.Fatal("must not exec in a jsonl-only path")
	}
	if result.RC == 0 {
		t.Fatal("root has no .pass; evil dir must not be used")
	}
	row := byID(BoardState(fx.Root))["C-006"]
	if !row.CwdUnsafe {
		t.Fatal("row cwdUnsafe")
	}
	if row.State == "check-pass" {
		t.Fatal("jsonl-only never check-pass")
	}
}

func TestRelativeFlowBinResolvesAgainstProcessCwd(t *testing.T) {
	fx := makeFixture(t)
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(wd, fx.FlowBin)
	if err != nil {
		t.Skip("relative FLOW_BIN has no spelling when the bin is on another drive")
	}
	if filepath.IsAbs(rel) {
		t.Skip("relative FLOW_BIN has no spelling when the bin is on another drive")
	}
	pass := RunCheck(fx.Root, "C-001", rel)
	if pass.CwdUnsafe {
		t.Fatal("cwdUnsafe")
	}
	if pass.Cwd != fx.Worktree {
		t.Fatalf("cwd %q", pass.Cwd)
	}
	if pass.RC != 0 {
		t.Fatalf("rc %d %s", pass.RC, pass.Stderr)
	}
	if !filepath.IsAbs(pass.FlowBin) {
		t.Fatalf("relative bin not pinned: %s", pass.FlowBin)
	}
}

func TestEACCESIsExecKindNotCheckFail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("EACCES on a chmod 644 script is a POSIX spawn story")
	}
	fx := makeFixture(t)
	if err := os.Chmod(fx.FlowBin, 0o644); err != nil {
		t.Fatal(err)
	}
	result := RunCheck(fx.Root, "C-001", fx.FlowBin)
	if result.ExecKind != "eacces" {
		t.Fatalf("execKind %s rc %d stderr %s", result.ExecKind, result.RC, result.Stderr)
	}
	if result.RC != 126 {
		t.Fatalf("rc %d", result.RC)
	}
	row := byID(BoardState(fx.Root))["C-001"]
	if row.State == "check-fail" {
		t.Fatal("EACCES must not be check-fail")
	}
	if row.LastCheck == nil || row.LastCheck.ExecKind != "eacces" {
		t.Fatalf("lastCheck %+v", row.LastCheck)
	}
	table := FormatStatusTable(BoardState(fx.Root))
	if !strings.Contains(table, "exec EACCES") {
		t.Fatalf("table %s", table)
	}
	if strings.Contains(table, "fail rc=1") {
		t.Fatalf("table showed fail rc=1: %s", table)
	}
}

func TestMissingBinIsExecKindNotCheckFail(t *testing.T) {
	fx := makeFixture(t)
	missing := filepath.Join(fx.Root, "bin", "missing-flow.sh")
	result := RunCheck(fx.Root, "C-001", missing)
	if result.ExecKind != "enoent" {
		t.Fatalf("execKind %s rc %d stderr %s", result.ExecKind, result.RC, result.Stderr)
	}
	if result.RC != 127 {
		t.Fatalf("rc %d", result.RC)
	}
	row := byID(BoardState(fx.Root))["C-001"]
	if row.State == "check-fail" {
		t.Fatal("ENOENT must not be check-fail")
	}
	if row.LastCheck == nil || row.LastCheck.ExecKind != "enoent" {
		t.Fatalf("lastCheck %+v", row.LastCheck)
	}
}

func TestFormatStatusTableCheckUnsafeNotPass(t *testing.T) {
	table := FormatStatusTable(Board{
		Root: "/tmp/proj",
		Rows: []Row{{
			ID:        "C-001",
			Title:     "Shipped",
			Status:    "done",
			State:     "done",
			CwdUnsafe: true,
			Worktree:  "",
			Vendor:    "",
			LastCheck: &LastCheck{RC: 0, CwdUnsafe: true, ExecKind: "ran"},
		}},
	})
	if !strings.Contains(table, "unsafe") {
		t.Fatalf("table %s", table)
	}
	if strings.Contains(table, "pass") {
		t.Fatalf("CHECK must not print pass: %s", table)
	}
}

func TestOrphanGitWorktreeUnassignedNeverGuessedCard(t *testing.T) {
	fx := makeFixture(t)
	orphan := filepath.Join(filepath.Dir(fx.Root), filepath.Base(fx.Root)+"-orphan")
	t.Cleanup(func() {
		cmd := exec.Command("git", "worktree", "remove", "-f", orphan)
		cmd.Dir = fx.Root
		cmd.SysProcAttr = sysProcAttr()
		_ = cmd.Run()
		_ = os.RemoveAll(orphan)
	})
	git(t, fx.Root, "worktree", "add", "-q", orphan, "-b", "feat/C-099-orphan")
	board := BoardState(fx.Root)
	found := false
	for _, u := range board.UnassignedWorktrees {
		if u.Branch == "feat/C-099-orphan" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("unassigned %#v", board.UnassignedWorktrees)
	}
	for _, r := range board.Rows {
		if r.ID == "C-099" {
			t.Fatal("guessed C-099 from branch")
		}
	}
	table := FormatStatusTable(board)
	if !strings.Contains(table, "UNASSIGNED") {
		t.Fatalf("table %s", table)
	}
	if !strings.Contains(table, "feat/C-099-orphan") {
		t.Fatalf("table %s", table)
	}
	for _, line := range strings.Split(table, "\n") {
		if strings.HasPrefix(line, "C-099") {
			t.Fatalf("guessed card row: %s", line)
		}
	}
}

func TestAllDoneEmptyCheckIsAuditCopy(t *testing.T) {
	table := FormatStatusTable(Board{
		Root: "/tmp/proj",
		Rows: []Row{{
			ID:        "C-001",
			Title:     "Shipped",
			Status:    "done",
			State:     "done",
			CwdUnsafe: true,
			LastCheck: nil,
		}},
	})
	if !strings.Contains(table, "audit:") {
		t.Fatalf("table %s", table)
	}
	if !strings.Contains(table, "—") {
		t.Fatalf("empty CHECK glyph missing: %s", table)
	}
}
