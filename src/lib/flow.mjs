#!/usr/bin/env node
/**
 * flow-deck core adapter. Reads flow world-state and execs `flow.sh`.
 * No UI. No PTY. No agent spawn. No mux control.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_PORT = 7420;
export const DEFAULT_HOST = "127.0.0.1";
export const CHECK_TIMEOUT_MS = 30_000;
export const FLOW_TIMEOUT_MS = 15_000;
export const GIT_TIMEOUT_MS = 5_000;

/** @type {Map<string, { rc: number, stdout: string, stderr: string, cwd: string, cwdUnsafe: boolean, at: number, timedOut?: boolean }>} */
const lastChecks = new Map();

export const STATES = Object.freeze([
  "todo",
  "building",
  "ready-blocked",
  "check-fail",
  "check-pass",
  "security-halt",
  "done",
]);

export function checkCacheKey(root, cardId) {
  return `${resolve(root)}\0${normalizeCardId(cardId)}`;
}

export function clearCheckCache(root) {
  if (!root) {
    lastChecks.clear();
    return;
  }
  const prefix = `${resolve(root)}\0`;
  for (const key of lastChecks.keys()) {
    if (key.startsWith(prefix)) lastChecks.delete(key);
  }
}

export function rememberCheck(root, cardId, result) {
  lastChecks.set(checkCacheKey(root, cardId), {
    rc: result.rc,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    cwd: result.cwd,
    cwdUnsafe: Boolean(result.cwdUnsafe),
    timedOut: Boolean(result.timedOut),
    at: result.at ?? Date.now(),
  });
}

export function getLastCheck(root, cardId) {
  return lastChecks.get(checkCacheKey(root, cardId)) ?? null;
}

export function normalizeCardId(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^c-?(\d+)$/i) || s.match(/^(\d+)$/);
  if (!m) return s.toUpperCase();
  return `C-${String(Number(m[1])).padStart(3, "0")}`;
}

export function isCardId(raw) {
  return /^c-?\d+$/i.test(String(raw ?? "").trim());
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Walk up from cwd until a directory containing `cards/` or `flow/` is found.
 * @param {string} cwd
 * @returns {string | null}
 */
export function findProjectRoot(cwd = process.cwd()) {
  let dir = resolve(cwd || process.cwd());
  for (;;) {
    if (isDir(join(dir, "cards")) || isDir(join(dir, "flow"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveFlowBin(explicit, fromCwd = process.cwd()) {
  let bin;
  if (explicit && String(explicit).trim()) bin = String(explicit).trim();
  else if (process.env.FLOW_BIN && process.env.FLOW_BIN.trim()) {
    bin = process.env.FLOW_BIN.trim();
  } else if (process.platform === "win32") {
    return "flow.cmd";
  } else {
    return "flow.sh";
  }
  if (isAbsolute(bin)) return bin;
  // Bare names stay on PATH. Relative paths pin to process/project cwd so
  // spawnSync does not re-resolve them against the card worktree.
  if (!bin.includes("/") && !bin.includes("\\")) return bin;
  return resolve(fromCwd, bin);
}

function frontMatterValue(text, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "im");
  const m = text.match(re);
  return m ? m[1].replace(/\r$/, "").trim() : "";
}

function parseTitle(text, fallbackId) {
  const m = text.match(/^#\s+(C-\d+)\s+[—–-]\s+(.+)$/m);
  if (m) return m[2].trim();
  const h = text.match(/^#\s+(.+)$/m);
  if (!h) return fallbackId;
  return h[1].replace(/^C-\d+\s*/, "").replace(/^[—–-]\s*/, "").trim() || fallbackId;
}

function evidenceBody(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Evidence\b/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

function evidenceIsEmpty(body) {
  const stripped = String(body ?? "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/^\s*\(empty.*?\)\s*$/gim, "")
    .replace(/^\s*<!--.*?-->\s*$/gm, "")
    .trim();
  return stripped.length === 0;
}

function parseDeps(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /^none$/i.test(s)) return [];
  const ids = [];
  const re = /C-\d+/gi;
  let m;
  while ((m = re.exec(s))) ids.push(normalizeCardId(m[0]));
  return ids;
}

/**
 * @param {string} root
 * @returns {Array<{id: string, title: string, status: string, deps: string[], evidenceEmpty: boolean, risk: string, file: string}>}
 */
export function listCards(root) {
  const dir = join(root, "cards");
  if (!isDir(dir)) return [];
  const names = readdirSync(dir)
    .filter((n) => /^C-\d+\.md$/i.test(n))
    .sort((a, b) => {
      const na = Number(a.replace(/^c-/i, "").replace(/\.md$/i, ""));
      const nb = Number(b.replace(/^c-/i, "").replace(/\.md$/i, ""));
      return na - nb;
    });
  return names.map((name) => {
    const file = join(dir, name);
    const text = readText(file);
    const id = normalizeCardId(basename(name, ".md"));
    return {
      id,
      title: parseTitle(text, id),
      status: (frontMatterValue(text, "status") || "").toLowerCase(),
      deps: parseDeps(frontMatterValue(text, "deps")),
      evidenceEmpty: evidenceIsEmpty(evidenceBody(text)),
      risk: (frontMatterValue(text, "risk") || "").toLowerCase(),
      file,
    };
  });
}

/**
 * cards/.inflight — `<id> <epoch>` per line. Does not touch gated status:.
 * @param {string} root
 * @returns {Map<string, number>}
 */
export function listInflight(root) {
  const map = new Map();
  const text = readText(join(root, "cards", ".inflight"));
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(C-\d+)\s+(\d+)/i);
    if (m) map.set(normalizeCardId(m[1]), Number(m[2]));
  }
  return map;
}

function parseGitWorktrees(root) {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  /** @type {Array<{worktree: string, branch: string | null, bare: boolean}>} */
  const trees = [];
  if (r.error || r.status !== 0) return trees;
  let cur = null;
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) trees.push(cur);
      cur = { worktree: line.slice(9), branch: null, bare: false };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "bare" && cur) {
      cur.bare = true;
    } else if (line === "" && cur) {
      trees.push(cur);
      cur = null;
    }
  }
  if (cur) trees.push(cur);
  return trees;
}

function parseJsonlLine(line) {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Last-active JSONL record per card_id, joined with `git worktree list --porcelain`.
 * Never returns agent_session_id (secret-adjacent).
 * @param {string} root
 * @returns {Map<string, {worktree: string | null, branch: string, vendor: string, portOffset: number, fromGit: boolean}>}
 */
export function listWorkspaces(root) {
  const byCard = new Map();
  const jsonl = readText(join(root, ".flow", "workspaces.jsonl"));
  /** @type {Map<string, object>} */
  const lastByCard = new Map();
  /** @type {Map<string, object>} */
  const lastByBranch = new Map();
  for (const line of jsonl.split(/\r?\n/)) {
    const rec = parseJsonlLine(line);
    if (!rec) continue;
    const branch = typeof rec.branch === "string" ? rec.branch : "";
    if (branch) lastByBranch.set(branch, rec);
    const card = typeof rec.card_id === "string" ? rec.card_id.trim() : "";
    if (card && card !== "none" && card !== "null") {
      lastByCard.set(normalizeCardId(card), rec);
    }
  }

  const trees = parseGitWorktrees(root);
  const byGitPath = new Map();
  const byGitBranch = new Map();
  for (const t of trees) {
    if (!t.worktree) continue;
    byGitPath.set(resolve(t.worktree), t);
    if (t.branch) byGitBranch.set(t.branch, t);
  }

  const consider = new Map(lastByCard);
  for (const [branch, rec] of lastByBranch) {
    const card = typeof rec.card_id === "string" ? rec.card_id.trim() : "";
    if (!card || card === "none" || card === "null") continue;
    const id = normalizeCardId(card);
    if (!consider.has(id)) consider.set(id, rec);
    void branch;
  }

  for (const [id, rec] of consider) {
    if (String(rec.status || "") === "removed") continue;
    const branch = typeof rec.branch === "string" ? rec.branch : "";
    const jsonPath =
      typeof rec.worktree_path === "string" && rec.worktree_path
        ? rec.worktree_path
        : null;
    const gitByPath = jsonPath ? byGitPath.get(resolve(jsonPath)) : null;
    const gitByBranch = branch ? byGitBranch.get(branch) : null;
    const git = gitByPath || gitByBranch;
    let worktree = git?.worktree || jsonPath;
    if (worktree && !isDir(worktree) && !git) worktree = jsonPath;
    if (worktree && !isDir(worktree)) {
      // Keep the recorded path for display; runCheck will fall back to root.
    }
    byCard.set(id, {
      worktree: worktree || null,
      branch: git?.branch || branch || "",
      vendor: typeof rec.vendor === "string" ? rec.vendor : "",
      portOffset: Number(rec.port_offset) || 0,
      fromGit: Boolean(git),
    });
  }

  return byCard;
}

const SECURITY_LINE_RE =
  /security-class|\btier-c\b|tier\s*c\s+halt|\btier=c\b/i;
const SECURITY_KEYWORD_RE =
  /\b(authz|authorization|tenancy|payments?|pii|rbac|credential)\b/i;

/**
 * Detect open security-class / Tier-C halt lines in DEBT.md.
 * @param {string} root
 */
export function readDebt(root) {
  const path = join(root, "DEBT.md");
  const exists = isFile(path);
  const text = exists ? readText(path) : "";
  const openLines = [];
  const securityHalts = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*- \[ \]/.test(line)) continue;
    openLines.push(line);
    const isSec =
      SECURITY_LINE_RE.test(line) ||
      (/DEBT:/i.test(line) && SECURITY_KEYWORD_RE.test(line) && /\bhalt\b/i.test(line));
    if (!isSec) continue;
    const cardIds = [];
    const re = /C-\d+/gi;
    let m;
    while ((m = re.exec(line))) cardIds.push(normalizeCardId(m[0]));
    securityHalts.push({
      line: line.trim(),
      cardIds,
      kind: /tier-c|\btier=c\b/i.test(line) ? "tier-c" : "security-class",
    });
  }
  return { path, exists, openLines, securityHalts };
}

/**
 * AUTO-LOG.md hints only. Never a pass. Never mux probing.
 * @param {string} root
 */
export function readAutoLog(root) {
  const text = readText(join(root, "AUTO-LOG.md"));
  /** @type {Set<string>} */
  const subagentBlocked = new Set();
  /** @type {Set<string>} */
  const securityHalt = new Set();
  for (const line of text.split(/\r?\n/)) {
    const ids = [];
    const re = /C-\d+/gi;
    let m;
    while ((m = re.exec(line))) ids.push(normalizeCardId(m[0]));
    if (!ids.length) continue;
    if (/\bBLOCKED\b|\bNEEDS_CONTEXT\b/.test(line)) {
      for (const id of ids) subagentBlocked.add(id);
    }
    if (/tier\s*=\s*C\s+HALT/i.test(line) || /tier-c halt/i.test(line)) {
      for (const id of ids) securityHalt.add(id);
    }
  }
  return { subagentBlocked, securityHalt };
}

function samePath(a, b) {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
}

/**
 * Dedicated card worktree — git-verified sibling, not the project root.
 * jsonl-only / missing / non-dir paths are unsafe and fall back to root.
 */
export function resolveCheckCwd(root, cardId, workspaces = listWorkspaces(root)) {
  const ws = workspaces.get(normalizeCardId(cardId));
  const recorded = ws?.worktree || null;
  const gitPath = ws?.fromGit && recorded ? resolve(recorded) : null;
  if (gitPath && isDir(gitPath) && !samePath(gitPath, root)) {
    return { cwd: gitPath, cwdUnsafe: false, worktree: gitPath, ws };
  }
  return { cwd: resolve(root), cwdUnsafe: true, worktree: recorded, ws };
}

function spawnFlow(bin, args, { cwd, timeout }) {
  const isWin = process.platform === "win32";
  const useShell = isWin && /\.(cmd|bat)$/i.test(bin);
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    shell: useShell,
    env: { ...process.env },
  });
  const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT");
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "") + (r.error && !timedOut ? `\n${r.error.message}` : "");
  let rc = typeof r.status === "number" ? r.status : 1;
  if (timedOut) rc = 124;
  if (r.error && r.error.code === "ENOENT") rc = 127;
  return { rc, stdout, stderr, timedOut };
}

/**
 * Exec `flow.sh check <id>` with cwd = that card's worktree.
 * Falls back to project root and sets cwdUnsafe. Never spawns agents.
 */
export function runCheck(root, cardId, flowBin, opts = {}) {
  const id = normalizeCardId(cardId);
  const timeout = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const workspaces = opts.workspaces ?? listWorkspaces(root);
  const resolved = resolveCheckCwd(root, id, workspaces);
  const bin = resolveFlowBin(flowBin);
  const exec = spawnFlow(bin, ["check", id], { cwd: resolved.cwd, timeout });
  const result = {
    id,
    rc: exec.rc,
    stdout: exec.stdout,
    stderr: exec.stderr,
    cwd: resolved.cwd,
    cwdUnsafe: resolved.cwdUnsafe,
    timedOut: exec.timedOut,
    flowBin: bin,
    at: Date.now(),
  };
  rememberCheck(root, id, result);
  return result;
}

function depsMet(card, byId) {
  if (!card.deps.length) return true;
  return card.deps.every((depId) => {
    const dep = byId.get(depId);
    if (!dep) return false;
    if (dep.status !== "done") return false;
    if (dep.evidenceEmpty) return false;
    return true;
  });
}

function securityHaltFor(card, debt, autoLog) {
  for (const h of debt.securityHalts) {
    if (h.cardIds.includes(card.id)) return true;
    if (h.cardIds.length === 0 && card.risk === "security-class") return true;
  }
  if (autoLog.securityHalt.has(card.id)) return true;
  return false;
}

function deriveState(card, ctx) {
  const {
    halt,
    last,
    unmet,
    inflight,
    hasDedicatedWorktree,
  } = ctx;
  // Four blocked senses stay distinct: security-halt never collapses into ready-blocked.
  if (halt) return "security-halt";
  if (last) {
    // Only an actual check rc==0 in a git-verified worktree is check-pass.
    // cwdUnsafe (root fallback / jsonl-only path) must never go green.
    if (last.rc === 0 && !last.cwdUnsafe) return "check-pass";
    if (last.rc !== 0) return "check-fail";
  }
  if (card.status === "done") return "done";
  if (unmet) return "ready-blocked";
  if (inflight || hasDedicatedWorktree) return "building";
  return "todo";
}

/**
 * Join cards × worktrees × debt × last check into board rows.
 * A live worktree is NOT a pass.
 */
export function boardState(root) {
  const cards = listCards(root);
  const workspaces = listWorkspaces(root);
  const inflight = listInflight(root);
  const debt = readDebt(root);
  const autoLog = readAutoLog(root);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const generatedAt = Date.now();
  const rows = cards.map((card) => {
    const ws = workspaces.get(card.id) || null;
    const resolved = resolveCheckCwd(root, card.id, workspaces);
    const last = getLastCheck(root, card.id);
    const unmet = card.status !== "done" && !depsMet(card, byId);
    const halt = securityHaltFor(card, debt, autoLog);
    const hasDedicatedWorktree = Boolean(ws?.worktree) && !resolved.cwdUnsafe;
    const state = deriveState(card, {
      halt,
      last,
      unmet,
      inflight: inflight.has(card.id),
      hasDedicatedWorktree,
    });
    return {
      id: card.id,
      title: card.title,
      status: card.status,
      state,
      worktree: ws?.worktree ?? null,
      branch: ws?.branch || "",
      vendor: ws?.vendor || "",
      cwdUnsafe: resolved.cwdUnsafe,
      evidenceEmpty: card.evidenceEmpty,
      deps: card.deps,
      depsMet: depsMet(card, byId),
      inflight: inflight.has(card.id),
      lastCheck: last
        ? {
            rc: last.rc,
            at: last.at,
            cwd: last.cwd,
            cwdUnsafe: last.cwdUnsafe,
            timedOut: last.timedOut,
          }
        : null,
      flags: {
        hostMuxBlocked: false,
        subagentBlocked: autoLog.subagentBlocked.has(card.id),
        readyBlocked: unmet,
        securityHalt: halt,
      },
    };
  });
  return {
    root: resolve(root),
    generatedAt,
    debt: {
      exists: debt.exists,
      openSecurityHalts: debt.securityHalts.map((h) => ({
        kind: h.kind,
        cardIds: h.cardIds,
        line: h.line,
      })),
    },
    rows,
  };
}

export function parseReadyOutput(text) {
  const buildable = [];
  const blocked = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let m = line.match(/\bBUILDABLE\s+(C-\d+)/i);
    if (m) {
      buildable.push(normalizeCardId(m[1]));
      continue;
    }
    m = line.match(/\bblocked\s+(C-\d+)/i);
    if (m) blocked.push(normalizeCardId(m[1]));
  }
  return { buildable, blocked };
}

function localBuildable(root) {
  const cards = listCards(root);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const buildable = [];
  const blocked = [];
  for (const c of cards) {
    if (c.status !== "todo") continue;
    if (depsMet(c, byId)) buildable.push(c.id);
    else blocked.push(c.id);
  }
  return { buildable, blocked };
}

function printEnterBlock(row, ws) {
  const wt = ws?.worktree;
  const vendor = ws?.vendor || "";
  const branch = ws?.branch || "";
  const port = Number(ws?.portOffset) || 0;
  const base = Number(process.env.FLOW_WORKSPACE_BASEPORT) || 3000;
  const lines = [];
  lines.push(`# ${row.id} — ${row.title}`);
  lines.push(`# vendor=${vendor || "-"}  branch=${branch || "-"}`);
  if (!wt) {
    lines.push(`# no worktree — run: flow.sh workspace add <branch> --card ${row.id}`);
    return lines.join("\n");
  }
  lines.push(`  cd "${wt}"`);
  if (vendor === "codex") {
    lines.push(`  export CODEX_HOME="${wt}/.codex"   # isolate Codex history/config per worktree`);
  }
  lines.push(`  export PORT=$(( ${base} + ${port} ))   # = ${base + port} (per-worktree; avoids dev-server clash)`);
  if (vendor === "claude") {
    lines.push(`  # launch in this dir: claude    (or from the main repo: claude --worktree ${branch})`);
  } else if (vendor === "codex") {
    lines.push(`  # launch in this dir: codex "<task>"`);
  } else if (vendor === "antigravity") {
    lines.push(`  # open this dir as an Antigravity workspace/Project, assign one agent`);
  } else {
    lines.push(`  # launch your agent with this dir as its working directory`);
  }
  return lines.join("\n");
}

/**
 * Print-enter blocks for the buildable set. Compose ready + workspace list.
 * Foreground only. Never exec agents.
 */
export function waveState(root, flowBin) {
  const bin = resolveFlowBin(flowBin);
  const exec = spawnFlow(bin, ["ready"], {
    cwd: root,
    timeout: FLOW_TIMEOUT_MS,
  });
  let parsed = parseReadyOutput(exec.stdout);
  let source = "flow.sh ready";
  if (parsed.buildable.length === 0 && parsed.blocked.length === 0) {
    parsed = localBuildable(root);
    source = exec.rc === 127 ? "local-deps (flow.bin missing)" : "local-deps (ready unparsed)";
  }
  const cards = listCards(root);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const workspaces = listWorkspaces(root);
  const blocks = parsed.buildable.map((id) => {
    const card = byId.get(id) || { id, title: id };
    const ws = workspaces.get(id) || null;
    return {
      id,
      title: card.title || id,
      worktree: ws?.worktree ?? null,
      vendor: ws?.vendor || "",
      branch: ws?.branch || "",
      text: printEnterBlock({ id, title: card.title || id }, ws),
    };
  });
  return {
    source,
    rc: exec.rc,
    readyRaw: exec.stdout,
    readyErr: exec.stderr,
    buildable: parsed.buildable,
    blocked: parsed.blocked,
    blocks,
  };
}

export function formatWaveText(wave) {
  if (!wave.blocks.length) {
    const extra = wave.blocked.length
      ? `\nready-blocked: ${wave.blocked.join(", ")}`
      : "";
    return `No buildable cards.${extra}\n`;
  }
  return wave.blocks.map((b) => b.text).join("\n\n") + "\n";
}

function pad(s, n) {
  const t = String(s ?? "");
  if (t.length > n) return t.slice(0, n - 1) + "\u2026";
  return t + " ".repeat(n - t.length);
}

function shortPath(p, root) {
  if (!p) return "—";
  const absRoot = resolve(root);
  const abs = resolve(p);
  if (abs === absRoot) return ".";
  const prefix = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (abs.startsWith(prefix)) return abs.slice(prefix.length);
  return p;
}

export function formatStatusTable(board) {
  const rows = board.rows;
  if (!rows.length) return "No cards found.\n";
  const lines = [];
  lines.push(
    [pad("ID", 7), pad("STATE", 14), pad("TITLE", 34), pad("WORKTREE", 30), pad("VENDOR", 10), "CHECK"].join("  "),
  );
  lines.push("-".repeat(110));
  for (const r of rows) {
    const wt = r.cwdUnsafe
      ? r.worktree
        ? `${shortPath(r.worktree, board.root)} (unsafe)`
        : "cwd=root (unsafe)"
      : shortPath(r.worktree, board.root);
    const check = r.lastCheck
      ? r.lastCheck.rc === 0
        ? "pass"
        : `fail rc=${r.lastCheck.rc}`
      : "—";
    lines.push(
      [pad(r.id, 7), pad(r.state, 14), pad(r.title, 34), pad(wt, 30), pad(r.vendor || "—", 10), check].join("  "),
    );
  }
  return lines.join("\n") + "\n";
}

export function noProjectMessage(cwd = process.cwd()) {
  return `no flow project here (${resolve(cwd)}). Need a directory containing cards/ or flow/.`;
}
