# Fleet ledger — ax-bugs (3 user-reported ingest bugs)
- Started 2026-07-17T08:41:08+08:00 | base origin/main
- Signals: /tmp/fleet-ax-bugs.signals | Tab: w1R:t9
- BUG 1 cursor timeout/resume: bug-cursor-ingest=w1R:p18 (FABLE) — batch commits + per-session resumability; cursor.ts:1042-1055, re-extract comment :922.
- BUG 2 session-health sentinel: bug-session-health=w1R:p19 (codex) — time::min empty-set → max sentinel crashes workflow_epoch:gsd UPSERT; guard at session-health.ts:403 only catches epoch-0.
- BUG 3 schema DDL: ALREADY FIXED ON MAIN (schema.surql:301 = valid 'DEFINE FIELD OVERWRITE reverted', not 'IF NOT EXISTS OVERWRITE'; retry predicate db.ts:67 specific to conflicts). Not fleeted — user likely on older ax. Report to user.
## bug-session-health
PR https://github.com/Necmttn/ax/pull/737 · normalizeFirstSuperpowersAt sane-year-range guard; sentinel→null · typecheck 0, tests green


## 2026-07-17T09:00:02+08:00 — bug 2 merged, bug 1 in progress
- MERGED: bug-session-health #737 (bug 2). bug-cursor-ingest (bug 1, fable): working — committed oracle-equivalent one-pass partition; Task 3 batched loop in progress via sonnet subagent. fable 5h quota ~8% (watch for stall → codex fallback).
## bug-cursor-ingest (bug 1)
PR https://github.com/Necmttn/ax/pull/740 · batch commits + watermark resumability + #261 preserved + oracle-equivalent partition · typecheck 0, 22 tests · (interrupted mid-self-review by network blip; fix was committed+green, orchestrator gated)

