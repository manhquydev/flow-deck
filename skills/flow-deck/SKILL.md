---
name: flow-deck
description: "Gate-aware operator dashboard for a flow project. Use only when the user explicitly mentions flow-deck or FLOW_DECK=1 AND a flow project (cards/ or flow/) is present. Teaches Node v1 board (serve/watch/status/check/wave) vs Go viewer (status/check). Same argv name is a footgun. Do not use merely because a task could use a dashboard."
---

# flow-deck

flow-deck is a **gate-aware operator dashboard** for a flow project. It reads flow world-state
(cards, worktrees, DEBT, check results) and execs `flow.sh` invoked-and-exit. It is **not**
flow, **not** a terminal, and **not** a multiplexer.

## Hard gate (stop unless both are true)

Activate only when:

1. The user mentioned `flow-deck` **or** `FLOW_DECK=1` is set.
2. A flow project is present (`cards/` or `flow/` walking up from cwd).

Do **not** activate because a task "could use a dashboard."

First action: do not trust `command -v flow-deck`. Same argv name, two binaries.

```bash
node src/cli.mjs --help           # v1 board: serve, watch, status, check, wave
go run ./cmd/flow-deck --help     # viewer: status, check only
# and a flow project:
#   a directory containing cards/ or flow/
```

If neither invocation works, say so and stop. If there is no flow project, say
`no flow project here` and stop. Do not install anything. Do not start Herdr or tmux
if they are missing.

The invocation you used is the authority for syntax. A PATH entry named `flow-deck` is not the v1 board; `--help` only identifies it. `serve` / `watch` / `wave` unknown → Go viewer; do not invent those commands, do not treat it as missing Node. Invoke Node as `node src/cli.mjs` and Go as `go run ./cmd/flow-deck`.

## Closed command list (v1)

Node v1 board (`node src/cli.mjs`):

```bash
node src/cli.mjs status                 # one-shot board (cards × worktrees × STATES)
node src/cli.mjs serve [--port 7420]    # local web board at http://127.0.0.1:7420 ; foreground; ^C quits
node src/cli.mjs watch                  # foreground TUI board; same core; q / ^C quits. Not a pass.
node src/cli.mjs check C-NNN            # exec flow.sh check in THAT card's worktree; relay rc
node src/cli.mjs wave                   # print paste-ready enter blocks for the buildable set
```

Go viewer (`go run ./cmd/flow-deck`) — status and check only. No serve, watch, or wave:

```bash
go run ./cmd/flow-deck status
go run ./cmd/flow-deck check C-NNN
```

Optional: `--flow-bin PATH` (or `FLOW_BIN`) to point at `flow.sh` / `flow.cmd`.

Card IDs come from `cards/C-NNN.md` or `node src/cli.mjs status` / `go run ./cmd/flow-deck status` / `flow.sh ready`. Worktree paths
come from `.flow/workspaces.jsonl` joined with `git worktree list`. Never invent IDs or paths.

CHECK is session-scoped (in-process; not persisted). All-done + empty CHECK (`—`) is an audit, not a stuck wave. Relay that line; do not start a wave.

## Primitives

| Noun | Meaning |
|---|---|
| Board | the dashboard (CLI table, local web UI, or TUI watch view) |
| Card | `cards/C-NNN.md` — gated unit with `status:` and `## Evidence` |
| Check | `flow.sh check C-NNN` run with **cwd = that card's worktree**. |
| Wave | print-enter blocks for currently BUILDABLE cards. Paste. Do not spawn. |

Done = `flow.sh check` exit 0 **in the card worktree** plus the evidence floor that `flow.sh`
already enforces. Deck does not second-guess the gate.

## Four blocked senses (keep distinct)

1. **host/mux-blocked** — pane approval chrome. v1 does not probe a mux.
2. **subagent-BLOCKED** — a worker returned BLOCKED / NEEDS_CONTEXT.
3. **ready-blocked** — deps unmet or evidence floor failed.
4. **security-halt** — Tier-C security-class; only the operator releases it in `DEBT.md`.

Never collapse these. A payments card that looks "alive" is not fine.

## Forbidden (by name)

- Treating liveness, host-idle, a live worktree, `node src/cli.mjs serve`, or `node src/cli.mjs watch` as a **pass**.
- Waiting on agents (`agent wait`, `orch-wait`, unbounded `--wait` on another model).
- Pasting deck/host status into card `## Evidence`.
- Installing hooks into `~/.claude` / `~/.omp`.
- Owning a PTY, VT, tmux session, Herdr server, or socket subscribe.
- Driving a multiplexer from **outside** it (`herdr` / `tmux send-keys` without `HERDR_ENV=1` / `TMUX`).
- Starting Herdr or tmux if missing.
- Running `flow.sh auto` as a supervisor from this skill.
- Spawning coding agents. Wave is print-enter only.

`node src/cli.mjs serve` and `node src/cli.mjs watch` are foreground processes the operator (or you) invoked;
they exit on SIGINT (`watch` also on `q`). Do not hold them across another model's turn as
evidence. Do not background them as a daemon. `watch` is a view, never a pass/evidence source.

## Check cwd rule

`flow.sh check C-NNN` **must** run in that card's worktree (a sibling checkout). Checking
from the project root reads the wrong tree. If the card has no worktree, the row is labeled
`cwd=root (unsafe)` — visible, not silent. Relay that label; do not hide it.

CHECK is session-scoped: last-check is in-process only, never written to disk. An all-done
board with empty CHECK (`—`) is a successful audit, not a stuck wave. Do not start a wave.

## Version skew

Unknown `flow.sh` output: show raw text. Never treat unparsed output as a gate fail inside flow.
Absence of flow-deck never fails a flow gate.
