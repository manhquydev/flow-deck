import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import {
  boardState,
  clearCheckCache,
  findProjectRoot,
  listCards,
  listWorkspaces,
  runCheck,
  waveState,
} from "../src/lib/flow.mjs";
import { makeFixture } from "./helpers/make-fixture.mjs";

function byId(board) {
  return Object.fromEntries(board.rows.map((r) => [r.id, r]));
}

test("boardState maps the seven states and never promotes liveness to check-pass", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  clearCheckCache(fx.root);

  const board = boardState(fx.root);
  const rows = byId(board);

  assert.equal(rows["C-001"].state, "building", "worktree present → building, not pass");
  assert.notEqual(rows["C-001"].state, "check-pass");
  assert.equal(rows["C-001"].cwdUnsafe, false);
  assert.equal(rows["C-001"].worktree, fx.worktree);
  assert.equal(rows["C-001"].vendor, "claude");
  assert.equal(rows["C-001"].lastCheck, null);

  assert.equal(rows["C-002"].state, "ready-blocked");
  assert.equal(rows["C-002"].flags.readyBlocked, true);
  assert.equal(rows["C-002"].flags.securityHalt, false);
  assert.equal(rows["C-002"].cwdUnsafe, true);

  assert.equal(rows["C-003"].state, "done");
  assert.equal(rows["C-003"].evidenceEmpty, false);

  assert.equal(rows["C-004"].state, "security-halt");
  assert.equal(rows["C-004"].flags.securityHalt, true);
  assert.equal(rows["C-004"].flags.readyBlocked, false);

  assert.equal(rows["C-005"].state, "building");
  assert.equal(rows["C-005"].inflight, true);
  assert.equal(rows["C-005"].flags.subagentBlocked, true);

  assert.equal(rows["C-006"].state, "todo");

  for (const row of board.rows) {
    assert.equal("agent_session_id" in row, false);
    assert.equal(JSON.stringify(row).includes("/dev/pts/"), false);
    assert.equal(JSON.stringify(row).includes("secret-session"), false);
  }
});

test("runCheck uses the card worktree cwd; no worktree is cwdUnsafe", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  clearCheckCache(fx.root);

  const pass = runCheck(fx.root, "C-001", fx.flowBin);
  assert.equal(pass.cwdUnsafe, false);
  assert.equal(pass.cwd, fx.worktree);
  assert.equal(pass.rc, 0);
  assert.match(pass.stdout, /CHECK_CWD=/);
  assert.match(pass.stdout, /PASS: C-001/);
  assert.ok(
    pass.stdout.includes(fx.worktree) || pass.cwd === fx.worktree,
    "check ran inside the sibling worktree",
  );
  assert.notEqual(pass.cwd, fx.root, "must not check from project root");

  const after = byId(boardState(fx.root));
  assert.equal(after["C-001"].state, "check-pass");
  assert.equal(after["C-001"].lastCheck.rc, 0);

  const unsafe = runCheck(fx.root, "C-002", fx.flowBin);
  assert.equal(unsafe.cwdUnsafe, true);
  assert.equal(unsafe.cwd, fx.root);
  assert.equal(unsafe.rc, 1, "root has no .pass — wrong-cwd would fail even for a passing card");
  assert.match(unsafe.stdout, /FAIL: C-002/);

  const failRow = byId(boardState(fx.root))["C-002"];
  assert.equal(failRow.state, "check-fail");
  assert.equal(failRow.flags.readyBlocked, true, "ready-blocked flag stays even after a fail");
  assert.notEqual(failRow.state, "ready-blocked", "last check rc is the row state; flag keeps the dep sense");
});

test("findProjectRoot walks up to cards/; listWorkspaces is jsonl-tolerant", (t) => {
  const fx = makeFixture();
  t.after(() => {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });

  assert.equal(findProjectRoot(fx.root), fx.root);
  assert.equal(findProjectRoot(join(fx.root, "cards")), fx.root);
  const nowhere = mkdtempSync(join(tmpdir(), "flow-deck-none-"));
  t.after(() => rmSync(nowhere, { recursive: true, force: true }));
  assert.equal(findProjectRoot(nowhere), null);

  const cards = listCards(fx.root);
  assert.equal(cards.length, 6);
  assert.equal(cards[0].id, "C-001");

  const ws = listWorkspaces(fx.root);
  const c1 = ws.get("C-001");
  assert.ok(c1);
  assert.equal(c1.worktree, fx.worktree);
  assert.equal(c1.vendor, "claude");
  assert.equal(c1.branch, "card/C-001");
  assert.equal("agent_session_id" in c1, false);
});

test("waveState composes BUILDABLE enter blocks from ready + workspace list", (t) => {
  const fx = makeFixture();
  t.after(() => {
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });

  const wave = waveState(fx.root, fx.flowBin);
  assert.deepEqual(wave.buildable, ["C-001", "C-006"]);
  assert.deepEqual(wave.blocked, ["C-002"]);
  const c1 = wave.blocks.find((b) => b.id === "C-001");
  assert.ok(c1.text.includes(`cd "${fx.worktree}"`));
  assert.equal(c1.text.includes("/dev/pts/"), false);
  const c6 = wave.blocks.find((b) => b.id === "C-006");
  assert.match(c6.text, /no worktree/);
});

test("root .pass with no worktree is cwdUnsafe and never check-pass", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  writeFileSync(join(fx.root, ".pass"), "ok\n");

  const result = runCheck(fx.root, "C-006", fx.flowBin);
  assert.equal(result.cwdUnsafe, true);
  assert.equal(result.cwd, fx.root);
  assert.equal(result.rc, 0, "root .pass makes flow.sh exit 0 — still not a pass");

  const row = byId(boardState(fx.root))["C-006"];
  assert.equal(row.cwdUnsafe, true);
  assert.notEqual(row.state, "check-pass");
  assert.equal(row.lastCheck.rc, 0);
  assert.equal(row.lastCheck.cwdUnsafe, true);
});

test("jsonl-only worktree_path that is not a git worktree is cwdUnsafe, not check-pass", (t) => {
  const fx = makeFixture();
  const evil = mkdtempSync(join(tmpdir(), "flow-deck-evil-"));
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
    rmSync(evil, { recursive: true, force: true });
  });
  writeFileSync(join(evil, ".pass"), "ok\n");
  appendFileSync(
    join(fx.root, ".flow", "workspaces.jsonl"),
    JSON.stringify({
      worktree_path: evil,
      branch: "card/C-006",
      vendor: "claude",
      card_id: "C-006",
      status: "active",
      created_at: 3,
    }) + "\n",
  );

  const rec = listWorkspaces(fx.root).get("C-006");
  assert.ok(rec);
  assert.equal(rec.fromGit, false);

  const result = runCheck(fx.root, "C-006", fx.flowBin);
  assert.equal(result.cwdUnsafe, true);
  assert.equal(result.cwd, fx.root);
  assert.notEqual(result.cwd, evil, "must not exec in a jsonl-only path");
  assert.notEqual(result.rc, 0, "root has no .pass; evil dir must not be used");

  const row = byId(boardState(fx.root))["C-006"];
  assert.equal(row.cwdUnsafe, true);
  assert.notEqual(row.state, "check-pass");
});

test("relative FLOW_BIN resolves against process cwd, not the card worktree", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  const relBin = relative(process.cwd(), fx.flowBin);
  if (isAbsolute(relBin)) {
    t.skip("relative FLOW_BIN has no spelling when the bin is on another drive");
    return;
  }
  assert.ok(!isAbsolute(relBin), "fixture bin is not already relative-to-cwd");

  const pass = runCheck(fx.root, "C-001", relBin);
  assert.equal(pass.cwdUnsafe, false);
  assert.equal(pass.cwd, fx.worktree);
  assert.equal(pass.rc, 0, pass.stderr);
  assert.ok(isAbsolute(pass.flowBin), "relative bin pinned to an absolute path before spawn");
});
