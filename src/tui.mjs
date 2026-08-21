/**
 * Foreground TUI board. A view of boardState / runCheck.
 * Not a terminal emulator. Not a PTY. Not a daemon. Not flow.
 */
import { watch, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import readline from "node:readline";
import { boardState, formatCheckCell, resolveFlowBin, runCheck } from "./lib/flow.mjs";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const HALT = "\x1b[1;35m";

const ENTER_ALT = "\x1b[?1049h";
const LEAVE_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";

const POLL_MS = 2000;
const SECRET_RE = /session|tty|transcript|\/dev\/pts\//i;

const STATE_COLOR = {
  todo: "",
  building: CYAN,
  "ready-blocked": YELLOW,
  "check-fail": RED,
  "check-pass": GREEN,
  "security-halt": HALT,
  done: DIM,
};

function ellipsize(s, n) {
  const t = String(s ?? "");
  const width = Math.max(0, n | 0);
  if (t.length <= width) return t;
  if (width <= 0) return "";
  if (width === 1) return "\u2026";
  return t.slice(0, width - 1) + "\u2026";
}

function pad(s, n) {
  const t = ellipsize(String(s ?? ""), n);
  return t + " ".repeat(Math.max(0, n - t.length));
}

function clip(s, width) {
  return ellipsize(String(s ?? ""), width);
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

function isSecretish(p) {
  return SECRET_RE.test(String(p ?? ""));
}

function safePath(p) {
  if (!p || isSecretish(p)) return "";
  return p;
}

function rowState(row) {
  const s = row?.state || "todo";
  if (row?.cwdUnsafe && s === "check-pass") {
    if (row.status === "done") return "done";
    if (row.flags?.securityHalt) return "security-halt";
    if (row.flags?.readyBlocked) return "ready-blocked";
    if (row.inflight || row.worktree) return "building";
    return "todo";
  }
  return s;
}

function worktreeCell(row, root) {
  const wt = safePath(row.worktree);
  if (row.cwdUnsafe) {
    return wt ? `${shortPath(wt, root)} (unsafe)` : "cwd=root (unsafe)";
  }
  return shortPath(wt, root);
}

function checkCell(row, checkingId) {
  if (checkingId && row.id === checkingId) return "checking\u2026";
  return formatCheckCell(row.lastCheck, row.cwdUnsafe);
}

function stateText(row) {
  const state = rowState(row);
  const flags = row.flags || {};
  const extra = [];
  if (flags.hostMuxBlocked) extra.push("host");
  if (flags.subagentBlocked) extra.push("sub");
  return extra.length ? `${state} \u00b7 ${extra.join(" ")}` : state;
}

function colWidths(width) {
  const prefix = 2;
  const gaps = 8;
  let idW = 7;
  let stateW = 14;
  let checkW = 12;
  let titleW = 16;
  let wtW = 14;
  const total = () => prefix + idW + stateW + titleW + wtW + checkW + gaps;
  const shrink = (read, write, min) => {
    while (total() > width && read() > min) write(read() - 1);
  };
  shrink(
    () => wtW,
    (v) => {
      wtW = v;
    },
    4,
  );
  shrink(
    () => titleW,
    (v) => {
      titleW = v;
    },
    4,
  );
  shrink(
    () => checkW,
    (v) => {
      checkW = v;
    },
    3,
  );
  shrink(
    () => stateW,
    (v) => {
      stateW = v;
    },
    5,
  );
  shrink(
    () => idW,
    (v) => {
      idW = v;
    },
    5,
  );
  const extra = width - total();
  if (extra > 0) {
    const addTitle = Math.ceil(extra * 0.55);
    titleW += addTitle;
    wtW += extra - addTitle;
  }
  return { prefix, idW, stateW, titleW, wtW, checkW };
}

function paintBadges(text) {
  const tokens = [
    ["security-halt", HALT],
    ["ready-blocked", YELLOW],
    ["check-fail", RED],
    ["check-pass", GREEN],
    ["building", CYAN],
    ["done", DIM],
  ];
  let out = text;
  for (const [name, color] of tokens) {
    out = out.split(name).join(color + name + RESET);
  }
  return out;
}

function wrapPlain(text, width) {
  const w = Math.max(1, width | 0);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    if (!cur) {
      cur = ellipsize(word, w);
      continue;
    }
    if (cur.length + 1 + word.length <= w) {
      cur += " " + word;
    } else {
      lines.push(cur);
      cur = ellipsize(word, w);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function headerBlock(board, width) {
  const root = clip(board?.root || "(no project)", Math.max(8, width - 22));
  const lines = [];
  lines.push(clip(`flow-deck  ${root}  poll 2s`, width));
  lines.push(clip("gate-aware board · not a terminal · not flow", width));
  lines.push("");
  for (const raw of [
    "todo  building  check-pass  check-fail  done",
    "ready-blocked  security-halt",
  ]) {
    lines.push(paintBadges(clip(raw, width)));
  }
  lines.push(clip("Four blocked senses — never collapse", width));
  for (const sense of [
    "host-blocked — pane approval chrome; v1 does not probe a mux",
    "subagent-BLOCKED — worker returned BLOCKED / NEEDS_CONTEXT",
    "ready-blocked — deps unmet or evidence floor failed",
    "Tier-C security halt — security-class; operator DEBT only",
  ]) {
    for (const line of wrapPlain(sense, width)) {
      lines.push(paintBadges(clip(line, width)));
    }
  }
  for (const line of wrapPlain(
    "A live worktree is not a pass. check-pass = flow.sh check rc=0 in the card worktree.",
    width,
  )) {
    lines.push(paintBadges(clip(line, width)));
  }
  const orphans = board?.unassignedWorktrees || [];
  if (orphans.length) {
    for (const line of wrapPlain(
      `UNASSIGNED ${orphans.length} git worktree(s) — not in jsonl; not guessed as cards.`,
      width,
    )) {
      lines.push(clip(line, width));
    }
  }
  lines.push("");
  return lines;
}

function columnHeader(w, width) {
  const marker = " ";
  const body = `${marker} ${[
    pad("ID", w.idW),
    pad("STATE", w.stateW),
    pad("TITLE", w.titleW),
    pad("WORKTREE", w.wtW),
    pad("CHECK", w.checkW),
  ].join("  ")}`;
  return clip(body, width);
}

function renderRow(row, w, opts, root) {
  const width = opts.width;
  const state = rowState(row);
  const marker = opts.selectedId && opts.selectedId === row.id ? ">" : " ";
  const body = `${marker} ${[
    pad(row.id, w.idW),
    pad(stateText(row), w.stateW),
    pad(row.title, w.titleW),
    pad(worktreeCell(row, root), w.wtW),
    pad(checkCell(row, opts.checkingId), w.checkW),
  ].join("  ")}`;
  const clipped = clip(body, width);
  const color = STATE_COLOR[state] || "";
  const sel = opts.selectedId && opts.selectedId === row.id ? REVERSE : "";
  return sel + color + clipped + RESET;
}

/**
 * Pure TUI frame for a boardState() result. Never overflows `width`.
 * @param {{root?: string, rows?: Array<object>}} board
 * @param {{width?: number, selectedId?: string, checkingId?: string}} [opts]
 * @returns {string}
 */
export function renderBoard(board, opts = {}) {
  const width = Math.max(1, Number(opts.width) || 80);
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  const root = board?.root || "";
  const w = colWidths(width);
  const lines = headerBlock(board, width);
  lines.push(columnHeader(w, width));
  if (!rows.length) {
    lines.push(clip("No cards found.", width));
  } else {
    for (const row of rows) {
      lines.push(renderRow(row, w, { ...opts, width }, root));
    }
  }
  lines.push("");
  lines.push(
    clip("q quit  r refresh  \u2191\u2193/jk select  c/enter check", width),
  );
  return lines.join("\n") + "\n";
}

function watchPaths(root) {
  const paths = [];
  for (const rel of ["cards", ".flow", "DEBT.md"]) {
    const p = join(root, rel);
    if (existsSync(p)) paths.push(p);
  }
  return paths;
}

/**
 * Foreground watch loop. Restores the screen on q / SIGINT / SIGTERM.
 * @param {string} root
 * @param {{flowBin?: string, intervalMs?: number, stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream}} [opts]
 * @returns {Promise<number>}
 */
export async function runWatch(root, opts = {}) {
  const flowBin = resolveFlowBin(opts.flowBin);
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : POLL_MS;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  let selectedId = null;
  let checkingId = null;
  let closed = false;
  let raw = false;
  let timer = null;
  let debounce = null;
  const watchers = [];

  const restore = () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
    try {
      stdout.write(SHOW_CURSOR + LEAVE_ALT);
    } catch {
      /* ignore */
    }
    if (raw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      raw = false;
    }
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
  };

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const quit = () => {
    if (closed) return;
    closed = true;
    stdin.off("keypress", onKey);
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    process.off("exit", restore);
    restore();
    settle(0);
  };

  const widthOf = () => {
    const cols = Number(stdout.columns);
    return cols > 0 ? cols : 80;
  };

  const paint = () => {
    if (closed) return;
    const board = boardState(root);
    const rows = board.rows || [];
    if (selectedId && !rows.some((r) => r.id === selectedId)) {
      selectedId = rows[0]?.id ?? null;
    }
    if (!selectedId && rows[0]) selectedId = rows[0].id;
    const frame = renderBoard(board, {
      width: widthOf(),
      selectedId,
      checkingId,
    });
    stdout.write(CLEAR + frame);
  };

  const requestPaint = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      paint();
    }, 50);
  };

  const move = (delta) => {
    const rows = boardState(root).rows || [];
    if (!rows.length) return;
    const i = Math.max(
      0,
      rows.findIndex((r) => r.id === selectedId),
    );
    const next = Math.min(rows.length - 1, Math.max(0, i + delta));
    selectedId = rows[next].id;
    paint();
  };

  const runSelectedCheck = () => {
    if (closed || checkingId) return;
    const rows = boardState(root).rows || [];
    const row = rows.find((r) => r.id === selectedId) || rows[0];
    if (!row) return;
    checkingId = row.id;
    paint();
    try {
      runCheck(root, row.id, flowBin);
    } finally {
      checkingId = null;
    }
    if (!closed) paint();
  };

  function onKey(_str, key) {
    if (closed || !key) return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      quit();
      return;
    }
    if (key.name === "r") {
      paint();
      return;
    }
    if (key.name === "up" || key.name === "k") {
      move(-1);
      return;
    }
    if (key.name === "down" || key.name === "j") {
      move(1);
      return;
    }
    if (key.name === "return" || (key.name === "c" && !key.ctrl)) {
      runSelectedCheck();
    }
  }

  stdout.write(ENTER_ALT + HIDE_CURSOR);
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", restore);

  readline.emitKeypressEvents(stdin);
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      raw = true;
    }
  } catch {
    raw = false;
  }
  stdin.on("keypress", onKey);
  if (typeof stdin.resume === "function") stdin.resume();

  paint();
  timer = setInterval(() => {
    if (!closed) paint();
  }, intervalMs);

  for (const p of watchPaths(root)) {
    try {
      watchers.push(watch(p, { persistent: true }, requestPaint));
    } catch {
      /* missing path is fine; interval covers it */
    }
  }

  return done;
}
