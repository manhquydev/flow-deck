---
name: flow-deck
description: "Gate-aware operator dashboard for a flow project. Use only when the user explicitly mentions flow-deck or FLOW_DECK=1 AND a flow project (cards/ or flow/) is present. Teaches status/serve/check/wave. Do not use merely because a task could use a dashboard."
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

First action:

```bash
command -v flow-deck >/dev/null 2>&1
# and a flow project:
#   a directory containing cards/ or flow/
```

If `flow-deck` is missing, say so and stop. If there is no flow project, say
`no flow project here` and stop. Do not install anything. Do not start Herdr or tmux
if they are missing.

The installed binary is the authority for syntax:

```bash
flow-deck --help
```

## Closed command list (v1)

```bash
flow-deck status                 # one-shot board (cards × worktrees × gate state)
flow-deck serve [--port 7420]    # local web board at http://127.0.0.1:7420 ; foreground; ^C quits
flow-deck check C-NNN            # exec flow.sh check in THAT card's worktree; relay rc
flow-deck wave                   # print paste-ready enter blocks for the buildable set
```

Optional: `--flow-bin PATH` (or `FLOW_BIN`) to point at `flow.sh` / `flow.cmd`.

Card IDs come from `cards/C-NNN.md` or `flow-deck status` / `flow.sh ready`. Worktree paths
come from `.flow/workspaces.jsonl` joined with `git worktree list`. Never invent IDs or paths.

## Primitives

| Noun | Meaning |
|---|---|
| Board | the dashboard (CLI table or local web UI) |
| Card | `cards/C-NNN.md` — gated unit with `status:` and `## Evidence` |
| Check | `flow.sh check C-NNN` run with **cwd = that card's worktree** |
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

- Treating liveness, host-idle, a live worktree, or `flow-deck serve` as a **pass**.
- Waiting on agents (`agent wait`, `orch-wait`, unbounded `--wait` on another model).
- Pasting deck/host status into card `## Evidence`.
- Installing hooks into `~/.claude` / `~/.omp`.
- Owning a PTY, VT, tmux session, Herdr server, or socket subscribe.
- Driving a multiplexer from **outside** it (`herdr` / `tmux send-keys` without `HERDR_ENV=1` / `TMUX`).
- Starting Herdr or tmux if missing.
- Running `flow.sh auto` as a supervisor from this skill.
- Spawning coding agents. Wave is print-enter only.

`flow-deck serve` is a foreground process the operator (or you) invoked; it exits on SIGINT.
Do not hold it across another model's turn as evidence. Do not background it as a daemon.

## Check cwd rule

`flow.sh check C-NNN` **must** run in that card's worktree (a sibling checkout). Checking
from the project root reads the wrong tree. If the card has no worktree, the row is labeled
`cwd=root (unsafe)` — visible, not silent. Relay that label; do not hide it.

## Version skew

Unknown `flow.sh` output: show raw text. Never treat unparsed output as a gate fail inside flow.
Absence of flow-deck never fails a flow gate.
