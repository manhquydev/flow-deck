import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDeckServer } from "../src/server.mjs";
import { clearCheckCache } from "../src/lib/flow.mjs";
import { makeFixture } from "./helpers/make-fixture.mjs";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("cli status: no flow project here in empty cwd", () => {
  const empty = mkdtempSync(join(tmpdir(), "flow-deck-empty-"));
  try {
    const r = cli(["status"], empty);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no flow project here/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
test("cli status/check/wave against fixture", (t) => {
  const fx = makeFixture();
  t.after(() => {
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });

  const st = cli(["status", "--flow-bin", fx.flowBin], fx.root);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /C-001/);
  assert.match(st.stdout, /building/);
  assert.match(st.stdout, /ready-blocked/);
  assert.match(st.stdout, /security-halt/);
  assert.doesNotMatch(st.stdout, /check-pass/);
  assert.doesNotMatch(st.stdout, /\/dev\/pts\//);

  const chk = cli(["check", "C-001", "--flow-bin", fx.flowBin], fx.root);
  assert.equal(chk.status, 0, chk.stderr + chk.stdout);
  assert.match(chk.stdout, /PASS: C-001/);
  assert.match(chk.stderr, new RegExp(fx.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const wave = cli(["wave", "--flow-bin", fx.flowBin], fx.root);
  assert.equal(wave.status, 0, wave.stderr);
  assert.match(wave.stdout, /C-001/);
  assert.match(wave.stdout, /cd "/);
});

test("HTTP /api/board and POST /api/check use worktree cwd", async (t) => {
  const fx = makeFixture();
  const deck = createDeckServer({
    root: fx.root,
    flowBin: fx.flowBin,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await deck.close();
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  await deck.listen();
  const { port } = deck.server.address();
  const base = `http://127.0.0.1:${port}`;

  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /flow-deck/);
  assert.match(html, /Four blocked senses/);

  const boardRes = await fetch(base + "/api/board");
  const board = await boardRes.json();
  const c1 = board.rows.find((r) => r.id === "C-001");
  assert.equal(c1.state, "building");
  assert.notEqual(c1.state, "check-pass");

  const checkRes = await fetch(base + "/api/check/C-001", { method: "POST" });
  const check = await checkRes.json();
  assert.equal(check.rc, 0);
  assert.equal(check.cwd, fx.worktree);
  assert.equal(check.cwdUnsafe, false);

  const board2 = await (await fetch(base + "/api/board")).json();
  assert.equal(board2.rows.find((r) => r.id === "C-001").state, "check-pass");

  const wave = await (await fetch(base + "/api/wave")).json();
  assert.ok(wave.buildable.includes("C-001"));
});

function getRaw(port, path) {
  return new Promise((resolveRaw, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolveRaw({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /% is 400/404 not 500", async (t) => {
  const fx = makeFixture();
  const deck = createDeckServer({
    root: fx.root,
    flowBin: fx.flowBin,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await deck.close();
    clearCheckCache(fx.root);
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(fx.worktree, { recursive: true, force: true });
  });
  await deck.listen();
  const { port } = deck.server.address();
  const res = await getRaw(port, "/%");
  assert.notEqual(res.status, 500);
  assert.ok(res.status === 400 || res.status === 404, `got ${res.status}`);
  assert.doesNotMatch(res.body, /URI malformed/);
});

test("createDeckServer.listen refuses non-localhost hosts", async () => {
  const deck = createDeckServer({ host: "0.0.0.0", port: 0 });
  await assert.rejects(() => deck.listen(), /127\.0\.0\.1/);
});
