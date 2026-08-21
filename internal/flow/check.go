package flow

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	cardIDRe    = regexp.MustCompile(`(?i)^c-?\d+$`)
	cardIDNumRe = regexp.MustCompile(`(?i)^c-?(\d+)$`)
	bareNumRe   = regexp.MustCompile(`^(\d+)$`)
	lastMu      sync.Mutex
	lastChecks  = map[string]CheckResult{}
)

// CheckResult is the in-process last-check record. Never written to disk.
type CheckResult struct {
	ID        string
	RC        int
	Stdout    string
	Stderr    string
	Cwd       string
	CwdUnsafe bool
	TimedOut  bool
	ExecKind  string
	FlowBin   string
	At        time.Time
}

func checkCacheKey(root, cardID string) string {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	abs = filepath.ToSlash(filepath.Clean(abs))
	if runtime.GOOS == "windows" {
		abs = strings.ToLower(abs)
	}
	return abs + "\x00" + NormalizeCardID(cardID)
}

func ClearCheckCache(root string) {
	lastMu.Lock()
	defer lastMu.Unlock()
	if root == "" {
		lastChecks = map[string]CheckResult{}
		return
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	prefix := filepath.ToSlash(filepath.Clean(abs))
	if runtime.GOOS == "windows" {
		prefix = strings.ToLower(prefix)
	}
	prefix += "\x00"
	for k := range lastChecks {
		if strings.HasPrefix(k, prefix) {
			delete(lastChecks, k)
		}
	}
}

func rememberCheck(root, cardID string, result CheckResult) {
	lastMu.Lock()
	defer lastMu.Unlock()
	if result.ExecKind == "" {
		result.ExecKind = "ran"
	}
	if result.At.IsZero() {
		result.At = time.Now()
	}
	lastChecks[checkCacheKey(root, cardID)] = result
}

func GetLastCheck(root, cardID string) *CheckResult {
	lastMu.Lock()
	defer lastMu.Unlock()
	v, ok := lastChecks[checkCacheKey(root, cardID)]
	if !ok {
		return nil
	}
	cp := v
	return &cp
}

func NormalizeCardID(raw string) string {
	s := strings.TrimSpace(raw)
	if m := cardIDNumRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		return "C-" + pad3(n)
	}
	if m := bareNumRe.FindStringSubmatch(s); m != nil {
		n, _ := strconv.Atoi(m[1])
		return "C-" + pad3(n)
	}
	return strings.ToUpper(s)
}

func pad3(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

func IsCardID(raw string) bool {
	return cardIDRe.MatchString(strings.TrimSpace(raw))
}

// FindProjectRoot walks up from cwd until a directory containing cards/ or flow/.
func FindProjectRoot(cwd string) string {
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return ""
		}
	}
	dir, err := filepath.Abs(cwd)
	if err != nil {
		return ""
	}
	for {
		if isDir(filepath.Join(dir, "cards")) || isDir(filepath.Join(dir, "flow")) {
			return Canonical(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// ResolveFlowBin pins relative paths to process cwd, not the card worktree.
func ResolveFlowBin(explicit, fromCwd string) string {
	var bin string
	if s := strings.TrimSpace(explicit); s != "" {
		bin = s
	} else if s := strings.TrimSpace(os.Getenv("FLOW_BIN")); s != "" {
		bin = s
	} else if runtime.GOOS == "windows" {
		return "flow.cmd"
	} else {
		return "flow.sh"
	}
	if filepath.IsAbs(bin) {
		return bin
	}
	if !strings.ContainsAny(bin, `/\`) {
		return bin
	}
	if fromCwd == "" {
		var err error
		fromCwd, err = os.Getwd()
		if err != nil {
			fromCwd = "."
		}
	}
	abs, err := filepath.Abs(filepath.Join(fromCwd, bin))
	if err != nil {
		return filepath.Clean(filepath.Join(fromCwd, bin))
	}
	return abs
}

type resolvedCwd struct {
	Cwd       string
	CwdUnsafe bool
	Worktree  string
	WS        *Workspace
}

func resolveCheckCwd(root, cardID string, workspaces map[string]Workspace) resolvedCwd {
	id := NormalizeCardID(cardID)
	var ws *Workspace
	if w, ok := workspaces[id]; ok {
		cp := w
		ws = &cp
	}
	recorded := ""
	if ws != nil {
		recorded = ws.Worktree
	}
	rootAbs := Canonical(root)
	if ws != nil && ws.FromGit && recorded != "" {
		gitPath := Canonical(recorded)
		if isDir(gitPath) && !SamePath(gitPath, rootAbs) {
			return resolvedCwd{Cwd: gitPath, CwdUnsafe: false, Worktree: gitPath, WS: ws}
		}
	}
	return resolvedCwd{Cwd: rootAbs, CwdUnsafe: true, Worktree: recorded, WS: ws}
}

// RunCheck execs `flow.sh check <id>` with cwd = that card's git worktree.
// Falls back to project root and sets CwdUnsafe. Never spawns agents.
func RunCheck(root, cardID, flowBin string) CheckResult {
	return RunCheckTimeout(root, cardID, flowBin, CheckTimeout)
}

func RunCheckTimeout(root, cardID, flowBin string, timeout time.Duration) CheckResult {
	id := NormalizeCardID(cardID)
	workspaces := ListWorkspaces(root)
	resolved := resolveCheckCwd(root, id, workspaces)
	bin := ResolveFlowBin(flowBin, "")
	execd := spawnFlow(bin, []string{"check", id}, resolved.Cwd, timeout)
	result := CheckResult{
		ID:        id,
		RC:        execd.RC,
		Stdout:    execd.Stdout,
		Stderr:    execd.Stderr,
		Cwd:       resolved.Cwd,
		CwdUnsafe: resolved.CwdUnsafe,
		TimedOut:  execd.TimedOut,
		ExecKind:  execd.ExecKind,
		FlowBin:   bin,
		At:        time.Now(),
	}
	if result.ExecKind == "" {
		result.ExecKind = "ran"
	}
	rememberCheck(root, id, result)
	return result
}

func NoProjectMessage(cwd string) string {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		abs = cwd
	}
	return "no flow project here (" + abs + "). Need a directory containing cards/ or flow/."
}
