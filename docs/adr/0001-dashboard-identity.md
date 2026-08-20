# ADR 0001 — flow-deck identity

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** operator; advisory wave absorbed (`--advise` recommendation)

Read this cold before touching code. flow-deck is a **sibling product** to
`@manhquy/flow-skill`. flow-skill is a host-agnostic *discipline layer* whose constitution
(`docs/adr/0001-discipline-layer-identity.md` in that repo) forbids it from owning a
runtime. flow-deck is where the operator-facing dashboard lives — but it is **not** a
terminal, **not** a multiplexer, and **not** flow.

## Identity statement

flow-deck is a **gate-aware operator dashboard** for a flow project. It reads flow's
world-state (cards, worktrees, gate results, debt) and **execs `flow.sh` invoked-and-exit**
to show, in one surface, which cards of a parallel wave are
`todo / building / ready-blocked / gate-FAIL / gate-PASS / Tier-C security halt / done`.

The first surface is a **local web UI** (`flow-deck serve`, dsh-style). A terminal/TUI
surface comes later on the same core. Both are just *views* of one core that reads flow
artifacts and runs `flow.sh check`.

## Dependency arrow (non-negotiable)

```
   @manhquy/flow-skill  (flow.sh invoked-and-exit; cards/, .flow/, gates)
             ▲
             │  flow-deck exec's flow.sh + reads artifacts — NEVER the reverse
             │
   flow-deck  (core + web + (later) TUI + companion skill)
```

- flow-skill MUST NOT require, detect, or vendor flow-deck.
- flow-deck MAY require a compatible `flow.sh` on PATH or accept `--flow-bin`.
- Absence of flow-deck NEVER fails a flow gate. flow-deck is never a required install.
- Version skew: treat unknown `flow.sh` output as *degrade to raw*, never a gate fail.

## Human locks (from the advisory wave)

- **H1 — want:** a gate-aware dashboard (the board), NOT "many agents from one keystroke"
  (a supervisor) and NOT a Herdr replacement.
- **H2 — v1 spawn:** **No spawn.** The board reads world-state; launching agents is
  print-enter (paste), or — later — asking a multiplexer the process is *already inside of*.
  flow-deck does not spawn/own coding-agent PTYs in v1.
- **H3 — name:** `flow-deck`. (Not `flow-term` / `flow-orch` — those nouns invite a mux.)
- **H4 — Herdr plugin:** not the primary product; optional contrib later.
- **H5 — capacity:** a bounded spike (one primary). flow-skill's gates/receipts/eval remain
  the load-bearing product. If the spike slips, cut flow-deck, not flow.
- **H6 — flow-skill pointer:** none in v1. Absence cannot become a `flow doctor` fail if the
  name never enters the skill tree.

## Scope freeze (v1)

**In:** `serve` (local web board), `status` (one-shot), `check C-NNN` (exec `flow.sh check`
with cwd = that card's worktree), `wave` (print paste-ready enter blocks).

**Out, by name:** owning a PTY, a VT emulator, ConPTY, screen-scraping agent state, hook
installs into `~/.claude` / `~/.omp`, a resident daemon that outlives the operator's
session, `orch-wait` / spawn-and-wait on N agents, `tmux new-session`, `herdr server`,
socket subscribe, driving a mux the process is not inside of.

## Correctness rules

1. **Done = `flow.sh check` exit 0 in the card's WORKTREE** + evidence floor. A row being
   "alive" / a host being "idle" is NOT a pass. Never paste liveness into card Evidence.
2. **Check in the right cwd.** `_ws_path` puts a card's checkout in a *sibling* dir; running
   `flow.sh check` from the project root reads the wrong file. If a card has no worktree,
   label the row `cwd=root (unsafe)` — visible, not silent.
3. **Four "blocked" senses stay distinct:** host/mux-blocked, subagent-BLOCKED,
   ready-blocked (deps unmet), Tier-C security halt. Never collapse them (or the board will
   imply a payments card is fine).
4. **No secret-adjacent data in the UI:** no agent session-transcript paths, no tty paths.
5. **Never exec a multiplexer control CLI from outside that mux** (same-uid sockets are not a
   security boundary). Inside-mux actions only when the injected env says so (`HERDR_ENV=1`,
   `TMUX`).

## Kill-criteria (stop; do not add a PTY)

- The board is not useful on a real project without spawning agents.
- Anyone opens a `pty` / `node-pty` / `tmux new-session` / VT PR in v1.
- flow-skill gains a `deck` dispatcher verb or a doctor fail on missing deck.
- Maintainer time on flow-deck exceeds time on flow-skill's gates/receipts for the month.

If flow-deck cannot prove gate-awareness within a bounded spike **without** a terminal
engine, the thesis was wrong and this repo should be retired — keep Herdr/tmux as the mux
and flow as the judge.
