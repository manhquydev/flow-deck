# flow-deck

A **gate-aware operator dashboard** for [flow](https://github.com/) projects.

flow-deck shows, in one local board (web or TUI), which build **cards** of a parallel wave are
`todo · building · blocked · gate-FAIL · gate-PASS · security-halt · done` — by reading
flow's world-state and running `flow.sh check` in each card's worktree.

> flow-deck is **not** a terminal, **not** a multiplexer, and **not** flow. It is a *view*.
> Keep using your terminal (Herdr, tmux, Cursor, plain shell); flow-deck just gives you the
> board. See [`docs/adr/0001-dashboard-identity.md`](docs/adr/0001-dashboard-identity.md).

## What it does (v1)

```bash
flow-deck serve            # local web board at http://127.0.0.1:7420
flow-deck watch            # foreground TUI board (same core; q quits)
flow-deck status           # one-shot table of cards × worktrees × gate state
flow-deck check C-012      # run flow.sh check in that card's worktree, relay result
flow-deck wave             # print paste-ready "enter" blocks for the buildable set
```

- Reads `cards/*.md`, `.flow/workspaces.jsonl`, `git worktree list`, `DEBT.md`, `AUTO-LOG.md`.
- Runs `flow.sh check C-NNN` with **cwd = that card's git worktree**. No worktree → labeled `cwd=root (unsafe)` fallback (visible, never a pass).
- Never spawns agents. Never owns a terminal emulator. Never a resident daemon.

## Requirements

- Node.js ≥ 22.14
- A flow project (`flow/` or `cards/`) with `flow.sh` on PATH (or pass `--flow-bin`).
- Linux and macOS today. Windows (`flow.cmd` spawn + a Windows test fixture) is a tracked follow-up.

## Install

```bash
npx @manhquy/flow-deck@latest serve
```

## Boundary

flow-deck depends on flow; **flow never depends on flow-deck**. Absence of flow-deck never
changes any flow gate. Details: the identity ADR above.

## License

MIT
