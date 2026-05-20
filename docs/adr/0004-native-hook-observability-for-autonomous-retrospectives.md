# Use native hook observability as the substrate for autonomous agent retrospectives

`axctl` will ingest native Harness Hook Events and Hook Command invocations as stable Local Evidence before treating hook-driven improvements as product behavior. Hook command results are raw evidence, not final judgment: a blocking hook can be successful boundary feedback when the agent shows corrective follow-through.

Feedback Cases and Evaluation Rules will evaluate short-horizon behavior after a hook signal, using deterministic backtests by default and AI primarily for case authoring, explanation, ambiguous review, and refinement. Case types remain generic because hook intent is user- and team-specific.

Agent Retrospectives may run Autonomous Intervention Runs that create, test, enable, pause, or revise hooks, skills, Evaluation Rules, and other Guidance changes. Global hook settings should point to an ax-managed intervention runner such as `axctl intervention run <id>` rather than embedding generated shell directly. The runner owns timeouts, smoke tests, fail-open defaults, explicit fail-closed guardrails, disable switches, rollback metadata, and Recovery Paths.

When Guidance Sources are Git-tracked, autonomous runs should commit ax-managed changes separately from user work and record commits, before/after hashes, evidence, scope, backtest results, and rollback commands. Historical self-improve proposal sessions become Retrospective Candidates that can be backtested and promoted later, but native hook observability lands first because it provides the measurement substrate.
