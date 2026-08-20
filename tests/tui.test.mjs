import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardState, clearCheckCache, rememberCheck } from "../src/lib/flow.mjs";
import { renderBoard } from "../src/tui.mjs";
import { makeFixture } from "./helpers/make-fixture.mjs";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function vis(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function lineOf(frame, id) {
  const raw = String(frame)
    .split("\n")
    .find((l) => l.includes(id));
  assert.ok(raw, `expected a row for ${id}`);
  return raw;
}

function row(partial) {
  return {
    id: "C-000",
    title: "card",
    status: "todo",
    state: "todo",
    worktree: null,
    branch: "",
    vendor: "",
    cwdUnsafe: false,
    evidenceEmpty: true,
    deps: [],
    depsMet: true,
    inflight: false,
    lastCheck: null,
    flags: {
      hostMuxBlocked: false,
      subagentBlocked: false,
      readyBlocked: false,
      securityHalt: false,
    },
    ...partial,
  };
}

function fixtureBoard() {
  return {
    root: "/tmp/flow-proj",
    generatedAt: 1,
    debt: { exists: true, openSecurityHalts: [] },
    rows: [
      row({ id: "C-010", title: "Todo card", state: "todo" }),
      row({
        id: "C-011",
        title: "Building card",
        state: "building",
        worktree: "/tmp/flow-proj/.worktrees/c-011",
      }),
      row({
        id: "C-012",
        title: "Ready blocked card",
        state: "ready-blocked",
        cwdUnsafe: true,
        flags: { readyBlocked: true, hostMuxBlocked: false, subagentBlocked: false, securityHalt: false },
      }),
      row({
        id: "C-013",
        title: "Check fail card",
        state: "check-fail",
        lastCheck: { rc: 2, at: 1, cwd: "/tmp/flow-proj/.worktrees/c-013", cwdUnsafe: false },
      }),
      row({
        id: "C-014",
        title: "Check pass card",
        state: "check-pass",
        worktree: "/tmp/flow-proj/.worktrees/c-014",
        lastCheck: { rc: 0, at: 1, cwd: "/tmp/flow-proj/.worktrees/c-014", cwdUnsafe: false },
      }),
      row({
        id: "C-015",
        title: "Security halt card",
        state: "security-halt",
        flags: { securityHalt: true, hostMuxBlocked: false, subagentBlocked: false, readyBlocked: false },
      }),
      row({ id: "C-016", title: "Done card", state: "done", status: "done" }),
      row({
        id: "C-099",
        title: "Looks passed but cwd is root",
        state: "check-pass",
        cwdUnsafe: true,
        lastCheck: {
          rc: 0,
          at: 1,
          cwd: "/tmp/session/agent-transcript",
          cwdUnsafe: true,
        },
        worktree: "/dev/pts/9",
      }),
      row({
        id: "C-080",
        title: "X".repeat(160),
        state: "todo",
      }),
      row({
        id: "C-005",
        title: "Subagent blocked building",
        state: "building",
        inflight: true,
        flags: { subagentBlocked: true, hostMuxBlocked: false, readyBlocked: false, securityHalt: false },
      }),
    ],
  };
}

const COLORS = {
  building: "\x1b[36m",
  "ready-blocked": "\x1b[33m",
  "check-fail": "\x1b[31m",
  "check-pass": "\x1b[32m",
  "security-halt": "\x1b[1;35m",
  done: "\x1b[2m",
};

test("renderBoard maps every state to its color/badge", () => {
  const board = fixtureBoard();
  const frame = renderBoard(board, { width: 100 });
  const plain = vis(frame);

  assert.match(plain, /todo/);
  assert.match(plain, /building/);
  assert.match(plain, /ready-blocked/);
  assert.match(plain, /check-fail/);
  assert.match(plain, /check-pass/);
  assert.match(plain, /security-halt/);
  assert.match(plain, /done/);

  assert.match(plain, /host-blocked/);
  assert.match(plain, /subagent-BLOCKED/);
  assert.match(plain, /Tier-C security halt/);

  const samples = [
    ["C-011", "building"],
    ["C-012", "ready-blocked"],
    ["C-013", "check-fail"],
    ["C-014", "check-pass"],
    ["C-015", "security-halt"],
    ["C-016", "done"],
  ];
  for (const [id, state] of samples) {
    const raw = lineOf(frame, id);
    assert.equal(raw.includes(COLORS[state]), true, `${id} ${state} color`);
    assert.match(vis(raw), new RegExp(state.replace("-", "\\-")));
  }

  const todoLine = vis(lineOf(frame, "C-010"));
  assert.match(todoLine, /todo/);
  assert.equal(lineOf(frame, "C-010").includes(COLORS["check-pass"]), false);
});

test("cwdUnsafe row is never rendered as check-pass", () => {
  const frame = renderBoard(fixtureBoard(), { width: 100 });
  const raw = lineOf(frame, "C-099");
  const plain = vis(raw);
  assert.doesNotMatch(plain, /check-pass/);
  assert.doesNotMatch(plain, /\bpass\b/);
  assert.match(plain, /unsafe/);
  assert.equal(raw.includes(COLORS["check-pass"]), false);
  assert.doesNotMatch(plain, /\/dev\/pts/);
  assert.doesNotMatch(plain, /session/);
  assert.doesNotMatch(plain, /transcript/);
});

test("long titles are ellipsized and every line is width-bounded", () => {
  const board = fixtureBoard();
  for (const width of [40, 80, 100, 120]) {
    const frame = renderBoard(board, { width });
    const long = "X".repeat(160);
    const rowLine = vis(lineOf(frame, "C-080"));
    assert.equal(rowLine.includes(long), false, "full title must not leak");
    assert.match(rowLine, /\u2026/);
    for (const [i, line] of frame.split("\n").entries()) {
      const n = vis(line).length;
      assert.ok(n <= width, `line ${i} width ${n} > ${width}: ${JSON.stringify(vis(line))}`);
    }
  }
});

test("renderBoard never leaks session/tty paths from a live board", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  clearCheckCache(fx.root);
  rememberCheck(fx.root, "C-002", {
    rc: 0,
    stdout: "",
    stderr: "",
    cwd: "/tmp/session/tty-transcript",
    cwdUnsafe: true,
    at: Date.now(),
  });
  const board = boardState(fx.root);
  const c2 = board.rows.find((r) => r.id === "C-002");
  assert.equal(c2.cwdUnsafe, true);
  assert.notEqual(c2.state, "check-pass");

  const frame = renderBoard(board, { width: 90 });
  const plain = vis(frame);
  assert.doesNotMatch(plain, /\/dev\/pts/);
  assert.doesNotMatch(plain, /session/);
  assert.doesNotMatch(plain, /transcript/);
  assert.doesNotMatch(plain, /\btty\b/i);
  const raw = lineOf(frame, "C-002");
  assert.equal(raw.includes(COLORS["check-pass"]), false);
  assert.doesNotMatch(vis(raw), /check-pass/);
  assert.match(vis(raw), /unsafe|cwd=root/);
});

test("checkingId paints a transient checking marker", () => {
  const frame = renderBoard(fixtureBoard(), { width: 100, checkingId: "C-011" });
  assert.match(vis(lineOf(frame, "C-011")), /checking/);
});

test("cli --help lists watch", () => {
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /watch/);
  assert.match(r.stdout, /--flow-bin/);
});
