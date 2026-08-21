package flow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var STATES = []string{
	"todo",
	"building",
	"ready-blocked",
	"check-fail",
	"check-pass",
	"security-halt",
	"done",
}

var (
	titleRe           = regexp.MustCompile(`(?m)^#\s+(C-\d+)\s+[—–-]\s+(.+)$`)
	headingRe         = regexp.MustCompile(`(?m)^#\s+(.+)$`)
	evidenceHeadRe    = regexp.MustCompile(`^##\s+Evidence\b`)
	sectionHeadRe     = regexp.MustCompile(`^##\s+`)
	emptyEvidenceRe   = regexp.MustCompile(`(?im)^\s*\(empty.*?\)\s*$`)
	htmlCommentRe     = regexp.MustCompile(`(?m)^\s*<!--.*?-->\s*$`)
	fenceRe           = regexp.MustCompile("(?s)```.*?```")
	cardFileRe        = regexp.MustCompile(`(?i)^C-\d+\.md$`)
	cardIDFindRe      = regexp.MustCompile(`(?i)C-\d+`)
	inflightRe        = regexp.MustCompile(`(?i)^(C-\d+)\s+(\d+)`)
	securityLineRe    = regexp.MustCompile(`(?i)security-class|\btier-c\b|tier\s*c\s+halt|\btier=c\b`)
	securityKeywordRe = regexp.MustCompile(`(?i)\b(authz|authorization|tenancy|payments?|pii|rbac|credential)\b`)
	debtOpenRe        = regexp.MustCompile(`^\s*- \[ \]`)
	debtMarkerRe      = regexp.MustCompile(`(?i)DEBT:`)
	haltWordRe        = regexp.MustCompile(`(?i)\bhalt\b`)
	tierCKindRe       = regexp.MustCompile(`(?i)tier-c|\btier=c\b`)
	blockedLogRe      = regexp.MustCompile(`\bBLOCKED\b|\bNEEDS_CONTEXT\b`)
	tierCHaltLogRe    = regexp.MustCompile(`(?i)tier\s*=\s*C\s+HALT|tier-c halt`)
	frontMatterRe     = func(key string) *regexp.Regexp {
		return regexp.MustCompile(`(?im)^` + regexp.QuoteMeta(key) + `:\s*(.*)$`)
	}
)

type Card struct {
	ID            string
	Title         string
	Status        string
	Deps          []string
	EvidenceEmpty bool
	Risk          string
	File          string
}

type Workspace struct {
	Worktree   string
	Branch     string
	Vendor     string
	PortOffset int
	FromGit    bool
}

type Unassigned struct {
	Path   string
	Branch string
}

type LastCheck struct {
	RC        int
	At        time.Time
	Cwd       string
	CwdUnsafe bool
	TimedOut  bool
	ExecKind  string
}

type Flags struct {
	HostMuxBlocked  bool
	SubagentBlocked bool
	ReadyBlocked    bool
	SecurityHalt    bool
}

type Row struct {
	ID            string
	Title         string
	Status        string
	State         string
	Worktree      string
	Branch        string
	Vendor        string
	CwdUnsafe     bool
	EvidenceEmpty bool
	Deps          []string
	DepsMet       bool
	Inflight      bool
	LastCheck     *LastCheck
	Flags         Flags
}

type SecurityHalt struct {
	Kind    string
	CardIDs []string
	Line    string
}

type DebtInfo struct {
	Exists            bool
	OpenSecurityHalts []SecurityHalt
}

type Board struct {
	Root                string
	GeneratedAt         time.Time
	Debt                DebtInfo
	Rows                []Row
	UnassignedWorktrees []Unassigned
}

type jsonlRec struct {
	WorktreePath string  `json:"worktree_path"`
	Branch       string  `json:"branch"`
	Vendor       string  `json:"vendor"`
	CardID       string  `json:"card_id"`
	PortOffset   float64 `json:"port_offset"`
	Status       string  `json:"status"`
}

type gitTree struct {
	Worktree string
	Branch   string
	Bare     bool
}

type debtFile struct {
	Path          string
	Exists        bool
	OpenLines     []string
	SecurityHalts []SecurityHalt
}

type autoLog struct {
	SubagentBlocked map[string]bool
	SecurityHalt    map[string]bool
}

func frontMatterValue(text, key string) string {
	m := frontMatterRe(key).FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimSuffix(m[1], "\r"))
}

func parseTitle(text, fallbackID string) string {
	if m := titleRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[2])
	}
	if h := headingRe.FindStringSubmatch(text); h != nil {
		s := h[1]
		s = regexp.MustCompile(`^C-\d+\s*`).ReplaceAllString(s, "")
		s = regexp.MustCompile(`^[—–-]\s*`).ReplaceAllString(s, "")
		s = strings.TrimSpace(s)
		if s == "" {
			return fallbackID
		}
		return s
	}
	return fallbackID
}

func evidenceBody(text string) string {
	lines := splitLines(text)
	start := -1
	for i, line := range lines {
		if evidenceHeadRe.MatchString(line) {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return ""
	}
	var body []string
	for i := start; i < len(lines); i++ {
		if sectionHeadRe.MatchString(lines[i]) {
			break
		}
		body = append(body, lines[i])
	}
	return strings.Join(body, "\n")
}

func evidenceIsEmpty(body string) bool {
	stripped := fenceRe.ReplaceAllString(body, "\n")
	stripped = emptyEvidenceRe.ReplaceAllString(stripped, "")
	stripped = htmlCommentRe.ReplaceAllString(stripped, "")
	return strings.TrimSpace(stripped) == ""
}

func parseDeps(raw string) []string {
	s := strings.TrimSpace(raw)
	if s == "" || strings.ToLower(s) == "none" {
		return []string{}
	}
	found := cardIDFindRe.FindAllString(s, -1)
	ids := make([]string, 0, len(found))
	for _, m := range found {
		ids = append(ids, NormalizeCardID(m))
	}
	return ids
}

func ListCards(root string) []Card {
	dir := filepath.Join(root, "cards")
	if !isDir(dir) {
		return nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range ents {
		if cardFileRe.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return cardNum(names[i]) < cardNum(names[j])
	})
	out := make([]Card, 0, len(names))
	for _, name := range names {
		file := filepath.Join(dir, name)
		text := readText(file)
		id := NormalizeCardID(strings.TrimSuffix(name, filepath.Ext(name)))
		out = append(out, Card{
			ID:            id,
			Title:         parseTitle(text, id),
			Status:        strings.ToLower(frontMatterValue(text, "status")),
			Deps:          parseDeps(frontMatterValue(text, "deps")),
			EvidenceEmpty: evidenceIsEmpty(evidenceBody(text)),
			Risk:          strings.ToLower(frontMatterValue(text, "risk")),
			File:          file,
		})
	}
	return out
}

func cardNum(name string) int {
	s := name
	if strings.HasSuffix(strings.ToLower(s), ".md") {
		s = s[:len(s)-3]
	}
	s = strings.TrimPrefix(strings.ToLower(s), "c-")
	n, _ := strconv.Atoi(s)
	return n
}

func ListInflight(root string) map[string]int64 {
	out := map[string]int64{}
	text := readText(filepath.Join(root, "cards", ".inflight"))
	for _, line := range splitLines(text) {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if m := inflightRe.FindStringSubmatch(t); m != nil {
			n, _ := strconv.ParseInt(m[2], 10, 64)
			out[NormalizeCardID(m[1])] = n
		}
	}
	return out
}

func parseGitWorktrees(root string) []gitTree {
	stdout, err := runGit(root, "worktree", "list", "--porcelain")
	if err != nil {
		return nil
	}
	var trees []gitTree
	var cur *gitTree
	flush := func() {
		if cur != nil {
			trees = append(trees, *cur)
			cur = nil
		}
	}
	for _, line := range splitLines(stdout) {
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			p := strings.TrimPrefix(line, "worktree ")
			cur = &gitTree{Worktree: Canonical(p)}
		case strings.HasPrefix(line, "branch ") && cur != nil:
			b := strings.TrimPrefix(line, "branch ")
			b = strings.TrimPrefix(b, "refs/heads/")
			cur.Branch = b
		case line == "bare" && cur != nil:
			cur.Bare = true
		case line == "":
			flush()
		}
	}
	flush()
	return trees
}

func parseJSONLLine(line string) *jsonlRec {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "#") {
		return nil
	}
	var rec jsonlRec
	if err := json.Unmarshal([]byte(t), &rec); err != nil {
		return nil
	}
	return &rec
}

// ListWorkspaces joins last-active JSONL per card_id with git worktree porcelain.
// Never returns agent_session_id.
func ListWorkspaces(root string) map[string]Workspace {
	jsonl := readText(filepath.Join(root, ".flow", "workspaces.jsonl"))
	lastByCard := map[string]*jsonlRec{}
	lastByBranch := map[string]*jsonlRec{}
	for _, line := range splitLines(jsonl) {
		rec := parseJSONLLine(line)
		if rec == nil {
			continue
		}
		if rec.Branch != "" {
			lastByBranch[rec.Branch] = rec
		}
		card := strings.TrimSpace(rec.CardID)
		if card != "" && card != "none" && card != "null" {
			lastByCard[NormalizeCardID(card)] = rec
		}
	}

	trees := parseGitWorktrees(root)
	byGitPath := map[string]gitTree{}
	byGitBranch := map[string]gitTree{}
	for _, t := range trees {
		if t.Worktree == "" {
			continue
		}
		byGitPath[PathKey(t.Worktree)] = t
		if t.Branch != "" {
			byGitBranch[t.Branch] = t
		}
	}

	consider := map[string]*jsonlRec{}
	for id, rec := range lastByCard {
		consider[id] = rec
	}
	for _, rec := range lastByBranch {
		card := strings.TrimSpace(rec.CardID)
		if card == "" || card == "none" || card == "null" {
			continue
		}
		id := NormalizeCardID(card)
		if _, ok := consider[id]; !ok {
			consider[id] = rec
		}
	}

	byCard := map[string]Workspace{}
	for id, rec := range consider {
		if rec.Status == "removed" {
			continue
		}
		branch := rec.Branch
		var jsonPath string
		if rec.WorktreePath != "" {
			jsonPath = rec.WorktreePath
		}
		var git *gitTree
		if jsonPath != "" {
			if t, ok := byGitPath[PathKey(jsonPath)]; ok {
				cp := t
				git = &cp
			}
		}
		if git == nil && branch != "" {
			if t, ok := byGitBranch[branch]; ok {
				cp := t
				git = &cp
			}
		}
		worktree := jsonPath
		if git != nil && git.Worktree != "" {
			worktree = git.Worktree
			if jsonPath != "" && SamePath(git.Worktree, jsonPath) {
				worktree = jsonPath
			}
		}
		if worktree != "" && !isDir(worktree) && git == nil {
			worktree = jsonPath
		}
		ws := Workspace{
			Worktree:   worktree,
			Vendor:     rec.Vendor,
			PortOffset: int(rec.PortOffset),
			FromGit:    git != nil,
		}
		if git != nil && git.Branch != "" {
			ws.Branch = git.Branch
		} else {
			ws.Branch = branch
		}
		byCard[id] = ws
	}
	return byCard
}

// ListUnassignedWorktrees lists git worktrees not assigned via jsonl.
// Never invents a C-NNN from a branch name.
func ListUnassignedWorktrees(root string, workspaces map[string]Workspace) []Unassigned {
	if workspaces == nil {
		workspaces = ListWorkspaces(root)
	}
	assigned := map[string]bool{}
	for _, ws := range workspaces {
		if ws.Worktree != "" {
			assigned[PathKey(ws.Worktree)] = true
		}
	}
	var out []Unassigned
	for _, t := range parseGitWorktrees(root) {
		if t.Worktree == "" || t.Bare {
			continue
		}
		if SamePath(t.Worktree, root) {
			continue
		}
		if assigned[PathKey(t.Worktree)] {
			continue
		}
		out = append(out, Unassigned{Path: t.Worktree, Branch: t.Branch})
	}
	return out
}

func ReadDebt(root string) debtFile {
	path := filepath.Join(root, "DEBT.md")
	exists := isFile(path)
	text := ""
	if exists {
		text = readText(path)
	}
	var openLines []string
	var securityHalts []SecurityHalt
	for _, line := range splitLines(text) {
		if !debtOpenRe.MatchString(line) {
			continue
		}
		openLines = append(openLines, line)
		isSec := securityLineRe.MatchString(line) ||
			(debtMarkerRe.MatchString(line) && securityKeywordRe.MatchString(line) && haltWordRe.MatchString(line))
		if !isSec {
			continue
		}
		found := cardIDFindRe.FindAllString(line, -1)
		ids := make([]string, 0, len(found))
		for _, m := range found {
			ids = append(ids, NormalizeCardID(m))
		}
		kind := "security-class"
		if tierCKindRe.MatchString(line) {
			kind = "tier-c"
		}
		securityHalts = append(securityHalts, SecurityHalt{
			Kind:    kind,
			CardIDs: ids,
			Line:    strings.TrimSpace(line),
		})
	}
	return debtFile{Path: path, Exists: exists, OpenLines: openLines, SecurityHalts: securityHalts}
}

func ReadAutoLog(root string) autoLog {
	text := readText(filepath.Join(root, "AUTO-LOG.md"))
	sub := map[string]bool{}
	halt := map[string]bool{}
	for _, line := range splitLines(text) {
		found := cardIDFindRe.FindAllString(line, -1)
		if len(found) == 0 {
			continue
		}
		ids := make([]string, 0, len(found))
		for _, m := range found {
			ids = append(ids, NormalizeCardID(m))
		}
		if blockedLogRe.MatchString(line) {
			for _, id := range ids {
				sub[id] = true
			}
		}
		if tierCHaltLogRe.MatchString(line) {
			for _, id := range ids {
				halt[id] = true
			}
		}
	}
	return autoLog{SubagentBlocked: sub, SecurityHalt: halt}
}

func depsMet(card Card, byID map[string]Card) bool {
	if len(card.Deps) == 0 {
		return true
	}
	for _, depID := range card.Deps {
		dep, ok := byID[depID]
		if !ok || dep.Status != "done" || dep.EvidenceEmpty {
			return false
		}
	}
	return true
}

func securityHaltFor(card Card, debt debtFile, log autoLog) bool {
	for _, h := range debt.SecurityHalts {
		for _, id := range h.CardIDs {
			if id == card.ID {
				return true
			}
		}
		if len(h.CardIDs) == 0 && card.Risk == "security-class" {
			return true
		}
	}
	return log.SecurityHalt[card.ID]
}

func deriveState(card Card, halt bool, last *CheckResult, unmet, inflight, hasDedicatedWorktree bool) string {
	if halt {
		return "security-halt"
	}
	if last != nil {
		kind := last.ExecKind
		if kind == "" {
			kind = "ran"
		}
		if kind == "ran" {
			if last.RC == 0 && !last.CwdUnsafe {
				return "check-pass"
			}
			if last.RC != 0 {
				return "check-fail"
			}
		}
	}
	if card.Status == "done" {
		return "done"
	}
	if unmet {
		return "ready-blocked"
	}
	if inflight || hasDedicatedWorktree {
		return "building"
	}
	return "todo"
}

// BoardState joins cards × worktrees × debt × last check.
// A live worktree is NOT a pass.
func BoardState(root string) Board {
	cards := ListCards(root)
	workspaces := ListWorkspaces(root)
	inflight := ListInflight(root)
	debt := ReadDebt(root)
	log := ReadAutoLog(root)
	byID := map[string]Card{}
	for _, c := range cards {
		byID[c.ID] = c
	}
	rows := make([]Row, 0, len(cards))
	for _, card := range cards {
		var ws *Workspace
		if w, ok := workspaces[card.ID]; ok {
			cp := w
			ws = &cp
		}
		resolved := resolveCheckCwd(root, card.ID, workspaces)
		last := GetLastCheck(root, card.ID)
		unmet := card.Status != "done" && !depsMet(card, byID)
		halt := securityHaltFor(card, debt, log)
		hasDedicated := ws != nil && ws.Worktree != "" && !resolved.CwdUnsafe
		inFl := inflightHas(inflight, card.ID)
		state := deriveState(card, halt, last, unmet, inFl, hasDedicated)
		row := Row{
			ID:            card.ID,
			Title:         card.Title,
			Status:        card.Status,
			State:         state,
			Branch:        "",
			Vendor:        "",
			CwdUnsafe:     resolved.CwdUnsafe,
			EvidenceEmpty: card.EvidenceEmpty,
			Deps:          card.Deps,
			DepsMet:       depsMet(card, byID),
			Inflight:      inFl,
			Flags: Flags{
				HostMuxBlocked:  false,
				SubagentBlocked: log.SubagentBlocked[card.ID],
				ReadyBlocked:    unmet,
				SecurityHalt:    halt,
			},
		}
		if ws != nil {
			row.Worktree = ws.Worktree
			row.Branch = ws.Branch
			row.Vendor = ws.Vendor
		}
		if last != nil {
			kind := last.ExecKind
			if kind == "" {
				kind = "ran"
			}
			row.LastCheck = &LastCheck{
				RC:        last.RC,
				At:        last.At,
				Cwd:       last.Cwd,
				CwdUnsafe: last.CwdUnsafe,
				TimedOut:  last.TimedOut,
				ExecKind:  kind,
			}
		}
		rows = append(rows, row)
	}
	halts := make([]SecurityHalt, 0, len(debt.SecurityHalts))
	halts = append(halts, debt.SecurityHalts...)
	return Board{
		Root:        Canonical(root),
		GeneratedAt: time.Now(),
		Debt: DebtInfo{
			Exists:            debt.Exists,
			OpenSecurityHalts: halts,
		},
		Rows:                rows,
		UnassignedWorktrees: ListUnassignedWorktrees(root, workspaces),
	}
}

func inflightHas(m map[string]int64, id string) bool {
	_, ok := m[id]
	return ok
}

// FormatCheckCell: spawn misses are not gate-fail. cwdUnsafe never prints pass.
func FormatCheckCell(last *LastCheck, cwdUnsafe bool) string {
	if last == nil {
		return "—"
	}
	kind := last.ExecKind
	if kind == "" {
		kind = "ran"
	}
	if kind != "ran" {
		switch kind {
		case "eacces":
			return "exec EACCES"
		case "enoent":
			return "exec ENOENT"
		case "timeout":
			return "exec timeout"
		case "refused":
			return "exec refused"
		default:
			return "exec error"
		}
	}
	if cwdUnsafe || last.CwdUnsafe {
		if last.RC == 0 {
			return "unsafe"
		}
		return "fail rc=" + strconv.Itoa(last.RC)
	}
	if last.RC == 0 {
		return "pass"
	}
	return "fail rc=" + strconv.Itoa(last.RC)
}

func pad(s string, n int) string {
	if n <= 0 {
		return ""
	}
	w := utf8.RuneCountInString(s)
	if w > n {
		if n == 1 {
			return "…"
		}
		r := []rune(s)
		return string(r[:n-1]) + "…"
	}
	return s + strings.Repeat(" ", n-w)
}

func shortPath(p, root string) string {
	if p == "" {
		return "—"
	}
	cRoot := Canonical(root)
	cPath := Canonical(p)
	if SamePath(cPath, cRoot) {
		return "."
	}
	prefix := cRoot
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	pathCmp, prefixCmp := cPath, prefix
	if runtime.GOOS == "windows" {
		pathCmp = strings.ToLower(cPath)
		prefixCmp = strings.ToLower(prefix)
	}
	if strings.HasPrefix(pathCmp, prefixCmp) {
		return cPath[len(prefix):]
	}
	return p
}

func FormatStatusTable(board Board) string {
	rows := board.Rows
	unassigned := board.UnassignedWorktrees
	if len(rows) == 0 && len(unassigned) == 0 {
		return "No cards found.\n"
	}
	var lines []string
	if len(rows) > 0 {
		lines = append(lines, strings.Join([]string{
			pad("ID", 7), pad("STATE", 14), pad("TITLE", 34), pad("WORKTREE", 30), pad("VENDOR", 10), "CHECK",
		}, "  "))
		lines = append(lines, strings.Repeat("-", 110))
		for _, r := range rows {
			var wt string
			if r.CwdUnsafe {
				if r.Worktree != "" {
					wt = shortPath(r.Worktree, board.Root) + " (unsafe)"
				} else {
					wt = "cwd=root (unsafe)"
				}
			} else {
				wt = shortPath(r.Worktree, board.Root)
			}
			vendor := r.Vendor
			if vendor == "" {
				vendor = "—"
			}
			check := FormatCheckCell(r.LastCheck, r.CwdUnsafe)
			lines = append(lines, strings.Join([]string{
				pad(r.ID, 7), pad(r.State, 14), pad(r.Title, 34), pad(wt, 30), pad(vendor, 10), check,
			}, "  "))
		}
		allDone := true
		noChecks := true
		for _, r := range rows {
			if r.Status != "done" {
				allDone = false
			}
			if r.LastCheck != nil {
				noChecks = false
			}
		}
		if allDone && noChecks {
			lines = append(lines, "")
			lines = append(lines, "audit: all cards done; CHECK is empty until this process runs check. Not a stuck wave.")
		}
	} else {
		lines = append(lines, "No cards found.")
	}
	if len(unassigned) > 0 {
		lines = append(lines, "")
		lines = append(lines, "UNASSIGNED WORKTREES (not in workspaces.jsonl; not guessed as cards)")
		for _, u := range unassigned {
			branch := u.Branch
			if branch == "" {
				branch = "—"
			}
			lines = append(lines, "  "+shortPath(u.Path, board.Root)+"  "+branch)
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func splitLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return strings.Split(text, "\n")
}
