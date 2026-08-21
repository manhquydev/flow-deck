---
title: "Dual-bin honesty: Node board vs Go viewer docs"
date: 2026-08-21
summary: Shipped path-qualified Node-vs-Go docs so PATH flow-deck cannot be mistaken for the v1 board.
---

# Dual-bin honesty: Node board vs Go viewer docs

**Date**: 2026-08-21 11:56
**Severity**: Medium
**Component**: README.md, skills/flow-deck/SKILL.md
**Status**: Resolved (docs shipped; merge to main still open)
**Issue**: https://github.com/manhquydev/flow-deck/issues/7
**Commit**: f885854 `docs(deck): document Node board vs Go viewer` on `docs/dual-bin-honesty`
**Diff**: README.md + skills/flow-deck/SKILL.md only (+51/−31)

## What Happened

After the Go viewer spike (PR #6), README and the companion skill still taught a single argv: `flow-deck serve|watch|status|check|wave`. That name now resolves to two programs. We shipped dual-bin honesty: Node (`node src/cli.mjs`) is the v1 board; Go (`go run ./cmd/flow-deck`) is a viewer. Same argv name is a footgun. Unknown `serve` means you invoked the Go viewer, not a broken v1 board.

## The Brutal Truth

We documented a lie and then let agents and operators follow it. Teaching `flow-deck serve` after a second binary existed on PATH is how you get a "broken board" ticket that is actually the viewer. The exhausting part is that this is not a runtime bug — it is us writing the wrong command and then being surprised when people type it. The relief is we fixed the docs without pretending this PR is a reason to grow Go into a board or publish npm.

## Technical Details

- **Node v1 board**: `serve`, `watch`, `status`, `check`, `wave` via `node src/cli.mjs …`
- **Go viewer**: `status`, `check` only via `go run ./cmd/flow-deck …`. No serve, watch, or wave.
- **CHECK is session-scoped**: last-check lives in this process only and is never written to disk. An all-done board with CHECK `—` is a successful audit, not a stuck wave.
- **Install**: not on npm. Do not `command -v flow-deck` and assume the v1 board. Do not install from a registry.
- **Tests**: Node 23/23. Go SKIP — `go` not on PATH. Review: 0 critical.

## What We Tried

Rejected unifying the argv. PATH cannot identify which binary you got; `--help` only names it. Rejected adding Go `serve` or an npm publish path to "make the docs simpler." Those would paper over the split instead of naming it.

## Root Cause Analysis

Docs lagged the dual-bin reality. We kept writing `flow-deck <cmd>` as if one installed binary were the authority. After PR #6 that sentence was false. The skill's first action was `command -v flow-deck`, which is exactly the wrong probe.

## Lessons Learned

Path-qualify invocations when two bins share a name. If `serve` is unknown, identify the viewer — do not invent Node commands on the Go binary. Empty CHECK (`—`) is an audit; do not start a wave. Do not treat a docs PR as license to add Go serve or publish npm.

## Next Steps

- Human review on #7: confirm README/SKILL cannot be followed into `flow-deck serve` as one binary, and that no npm/registry install path was reintroduced.
- Merge `docs/dual-bin-honesty` to main when that review lands.
- Owner: repo maintainers. Timeline: this PR; do not expand scope.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
