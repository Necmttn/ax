# Fleet ledger — team-dash-s1 (team-dashboard Slice 1)
- Orchestrator: fable-5 | started 2026-07-16T23:08:55+08:00 | base origin/main=ce03ef24
- Map: https://github.com/Necmttn/ax/issues/728 | Design: docs/superpowers/plans/2026-07-01-team-dashboard-git-native-goal-package.md §5 Slice 1
- Signals: /tmp/fleet-team-dash-s1.signals | Tab: w1R:t7 | Workspace: w1R
- Decisions (2026-07-16): snapshot → dedicated <org>/ax-team repo; cadence → explicit ax team push.
- KEY: ax team ALREADY EXISTS (team.ts sync/trust/experiment) — new verbs NEST as subcommands, not top-level.
- Wave 1 (building): team-profile=w1R:p0 (fable — TeamProfileV1 + repo-scoped builder + redaction), team-bindings=w1R:p11 (codex — bindings state + join/status/leave).
- Wave 2 (blocked on wave1): team-push (codex — GitHubEnv contents upsert into <org>/ax-team + ax team push).
- Later slices blocked on user infra: Slice 3 (OAuth app), Slice 5 (Stripe).
- GATE PATTERN (from ax-improve run): rebase onto origin/main before scope-check; hard scope-check vs chunk IN-list; run real tests; fable fallback→codex if spend limit.
## team-bindings (Slice 1)
PR https://github.com/Necmttn/ax/pull/729 · bindings state + join/status/leave nested in teamCommand (all 6 subcommands preserved) · typecheck 0, 16 tests, no-node-fs 0

