import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function sh(cwd, args) {
  const r = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

function card({ id, title, status, deps, evidence, risk }) {
  const ev = evidence ?? (status === "done" ? "$ curl https://x/healthz -> 200 PASS\npath src/cli.mjs exists\n" : "");
  return `# ${id} — ${title}

status: ${status}
deps: ${deps}
risk: ${risk ?? "standard"}
risk-reason: fixture
risk-ack: none

## Scope

${title}

## Allowed files

- src/

## Verify

- [${status === "done" ? "x" : " "}] fixture

## Done-evidence

named before building

## Evidence

${ev}
`;
}

/**
 * Tiny flow project:
 *   C-001 todo, dedicated sibling worktree (has .pass)
 *   C-002 todo, deps C-001, no worktree → ready-blocked
 *   C-003 done, evidence filled
 *   C-004 todo, open security-class DEBT → security-halt
 *   C-005 todo, inflight, no worktree → building
 *   C-006 todo, no deps, no worktree → todo
 *
 * Fake flow.sh check: PASS only if cwd contains `.pass`.
 * Root does not have `.pass`; the C-001 worktree does.
 */
export function makeFixture() {
  // realpath so paths match what `git worktree list` returns: on macOS tmpdir is
  // /var/folders -> /private/var/folders (a symlink), which would break path compares.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-deck-fx-")));
  const worktree = join(dirname(root), `${root.split("/").pop()}-C-001`);

  mkdirSync(join(root, "cards"), { recursive: true });
  mkdirSync(join(root, ".flow"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });

  writeFileSync(
    join(root, "cards", "C-001.md"),
    card({ id: "C-001", title: "Has worktree", status: "todo", deps: "none" }),
  );
  writeFileSync(
    join(root, "cards", "C-002.md"),
    card({ id: "C-002", title: "Deps unmet", status: "todo", deps: "C-001" }),
  );
  writeFileSync(
    join(root, "cards", "C-003.md"),
    card({ id: "C-003", title: "Already done", status: "done", deps: "none" }),
  );
  writeFileSync(
    join(root, "cards", "C-004.md"),
    card({
      id: "C-004",
      title: "Payments halt",
      status: "todo",
      deps: "none",
      risk: "security-class",
    }),
  );
  writeFileSync(
    join(root, "cards", "C-005.md"),
    card({ id: "C-005", title: "In flight", status: "todo", deps: "none" }),
  );
  writeFileSync(
    join(root, "cards", "C-006.md"),
    card({ id: "C-006", title: "Plain todo", status: "todo", deps: "none" }),
  );
  writeFileSync(join(root, "cards", ".inflight"), "C-005 1710000000\n");

  writeFileSync(
    join(root, "DEBT.md"),
    `# DEBT

- [ ] DEBT: security-class C-004 -- payments exposure -- close before: operator ack -- opened 2026-08-20 (cards: C-004)
- [x] DEBT: old closed security-class C-006 -- should not halt
- [ ] DEBT: macOS timeout unbounded -- not a security-class line
`,
  );

  writeFileSync(
    join(root, "AUTO-LOG.md"),
    `- C-005 | title | BLOCKED | NEEDS_CONTEXT | 2026-08-20
`,
  );

  const flowBin = join(root, "bin", "flow.sh");
  writeFileSync(
    flowBin,
    `#!/usr/bin/env bash
set -u
cmd="\${1:-}"
id="\${2:-}"
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
`,
  );
  chmodSync(flowBin, 0o755);

  writeFileSync(join(root, "README.md"), "fixture\n");
  sh(root, ["git", "init", "-q"]);
  sh(root, ["git", "config", "user.email", "fx@example.test"]);
  sh(root, ["git", "config", "user.name", "fixture"]);
  sh(root, ["git", "add", "-A"]);
  sh(root, ["git", "commit", "-qm", "fixture"]);
  sh(root, ["git", "worktree", "add", "-q", worktree, "-b", "card/C-001"]);
  writeFileSync(join(worktree, ".pass"), "ok\n");

  writeFileSync(
    join(root, ".flow", "workspaces.jsonl"),
    JSON.stringify({
      worktree_path: worktree,
      branch: "card/C-001",
      vendor: "claude",
      agent_session_id: "/dev/pts/9",
      card_id: "C-001",
      task_label: "build",
      owned_files_glob: "src/",
      port_offset: 0,
      created_at: 1,
      status: "active",
    }) +
      "\nnot-json\n" +
      JSON.stringify({
        worktree_path: worktree,
        branch: "card/C-001",
        vendor: "claude",
        agent_session_id: "/tmp/secret-session.jsonl",
        card_id: "C-001",
        task_label: "build",
        owned_files_glob: "src/",
        port_offset: 2,
        created_at: 2,
        status: "active",
      }) +
      "\n",
  );

  return { root, worktree, flowBin };
}
