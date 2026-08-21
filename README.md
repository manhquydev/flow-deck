# flow-deck

A **gate-aware operator dashboard** for [flow](https://github.com/) projects.

flow-deck shows, in one local board (web or TUI), which build **cards** of a parallel wave are
`todo · building · ready-blocked · check-fail · check-pass · security-halt · done` — by reading
flow's world-state and running `flow.sh check` in each card's worktree.

> flow-deck is **not** a terminal, **not** a multiplexer, and **not** flow. It is a *view*.
> Keep using your terminal (Herdr, tmux, Cursor, plain shell); flow-deck just gives you the
> board. See [`docs/adr/0001-dashboard-identity.md`](docs/adr/0001-dashboard-identity.md).

## What it does (v1)

Two programs share the argv name `flow-deck`. That is a footgun: PATH does not tell you which one you got.

**Node is the v1 board** (`serve`, `watch`, `status`, `check`, `wave`):

```bash
node src/cli.mjs serve            # local web board at http://127.0.0.1:7420
node src/cli.mjs watch            # foreground TUI board (same core; q quits)
node src/cli.mjs status           # one-shot table of cards × worktrees × gate state
node src/cli.mjs check C-012      # run flow.sh check in that card's worktree, relay result
node src/cli.mjs wave             # print paste-ready "enter" blocks for the buildable set
```

**Go is a viewer** (`status`, `check` only — no serve, watch, or wave):

```bash
go run ./cmd/flow-deck status
go run ./cmd/flow-deck check C-012
```

If `serve` is unknown, you invoked the Go viewer, not a broken v1 board.

- Reads `cards/*.md`, `.flow/workspaces.jsonl`, `git worktree list`, `DEBT.md`, `AUTO-LOG.md`.
- Runs `flow.sh check C-NNN` with **cwd = that card's git worktree**. No worktree → labeled `cwd=root (unsafe)` fallback (visible, never a pass).
- Never spawns agents. Never owns a terminal emulator. Never a resident daemon.

CHECK is **session-scoped**: last-check lives in this process only and is never written to disk. An all-done board with an empty CHECK column (`—`) is a **successful audit**, not a stuck wave. CHECK stays `—` until *this* process runs `check`.

## Requirements

- Node.js ≥ 22.14 for the v1 board (`node src/cli.mjs …`)
- Go only if you run the viewer (`go run ./cmd/flow-deck …`)
- A flow project (`flow/` or `cards/`) with `flow.sh` on PATH (or pass `--flow-bin`).
- Linux, macOS, and Windows (`flow.cmd`).

## Install

Not on npm yet. From a clone, invoke by path as above. Do not install from a registry. Do not `command -v flow-deck` and assume the v1 board.

## Boundary

flow-deck depends on flow; **flow never depends on flow-deck**. Absence of flow-deck never
changes any flow gate. Details: the identity ADR above.

## License

MIT
