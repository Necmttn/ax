# axctl CLI reference

The full command surface. `ax` and `axctl` are the same binary. This page
can drift - `axctl <command> --help` is authoritative.

## CLI shape

```text
axctl ingest [--since=N] [--reset] [--stages=<list>]   # backfill the graph
axctl ingest here [--since=Nd] [--stages=<list>]       # scope ingest to the git repo at $PWD
axctl derive <signals|intents>              # re-run a derive pass standalone
axctl serve                                 # live web dashboard
axctl mcp                                   # MCP server (stdio) - read-only graph queries for agents
axctl report                                # one-shot static HTML
axctl tui                                   # interactive terminal dashboard

axctl recall <query> [--sources=turn,commit,skill] [--scope=here|all]
                                            # cross-session BM25 full-text search
axctl context [file] [<query>]              # file/agent-context grounding
axctl skills <search|taste|unused|pairs|recovery|stats|recent|classify|tag|lint|weighted|by-role|roles|config|reconcile|scope|park|unpark|rm>
axctl agents <config|reconcile|scope|park|unpark|rm>   # agent-file registry + overrides
axctl insights <view>                       # 31 read-only graph views
axctl classifiers <list|eval|explain|...>   # classifier coverage, graph, lifecycle, label-mining
axctl sessions <here|around <date>|near <sha>|show <id>|compare|metrics|churn>
                                            # windowed session queries + graph-derived metrics
axctl sessions churn [--here|--project=P] [--source=S] [--since=N] [--json]
                                            # verification churn: landed vs edit vs repair LOC, failed checks, episodes
axctl signals <list|show <id>>              # relation-signal catalog (fragility cascade, ...)
axctl costs summary [--since=N]             # estimated token cost by provider/model
axctl costs for --session <id>              # cost for one session
axctl costs for --query <text> [--limit=N]  # cost for sessions matching turn text
axctl costs for --terms <a,b,c> [--since=N] # cost for sessions matching any term
axctl costs for --commit <sha>              # cost for sessions that produced a commit
axctl costs for --branch <name>             # cost for sessions linked to a branch
axctl cost <models|sessions|split>          # model/cost analytics incl. main-vs-subagent split
axctl quota [--statusline|--swiftbar]       # Claude plan usage (5h/7d windows); statusline + menubar output
axctl dojo agenda [--json|--spar|--budget=N|--until=HH:MM|--force|--days=N]  # training agenda: quota budget envelope + prioritized self-improvement items for the ax:dojo skill loop
axctl dojo report [--since=<iso>] [--notes-file=<path>] [--json]      # write the morning report for a completed dojo run
axctl dojo draft [--title=<t>] [--kind=bug|improvement] [--body-file=<path>] [--session=<id>]  # stage an upstream finding to ~/.ax/dojo/outbox/<slug>.md (never publishes)
axctl dojo outbox [--json]                                            # list staged upstream issue drafts
axctl dojo spar-plan <sha> [--json]                              # capture a landed task's baseline + emit a one-delta experiment brief
axctl dojo spar-score <id> [--variant-session=<id>] [--json]     # score the agent's variant vs the frozen baseline; stamps variant session labels=["spar"] (excluded from ax skills weighted + ax thinking, kept in cost)
axctl dispatches [--candidates] [--economy] # subagent dispatch routing analytics + est savings + effectiveness lens
axctl routing tune [--dry-run|--emit-brief] # mine YOUR dispatch history for new routing classes
axctl routing compile                       # regenerate ~/.ax/hooks/routing-table.json (user classes preserved)
axctl routing show                          # effective routing table with class origins
axctl profile show [--window=N] [--no-cost] # local profile: stats + rig + taste from the graph
axctl wrapped <generate|publish>            # agent-authored Wrapped recap cards for the dashboard landing
axctl profile publish [--if-stale=H] [--yes] [--skip-registration]
                                            # publish profile gist + one-time community registration PR
axctl profile unpublish                     # delete the published gist + local consent
axctl profile interview [--force]              # emit a brief; an agent interviews you for profile highlights
axctl profile interview submit [--file=PATH]   # validate highlights JSON (stdin/--file) -> ~/.ax/profile-highlights.json
axctl pricing [--query <model>]             # inspect imported model pricing rows
axctl share <session-id>                    # publish a sanitized session share via GitHub Gist
axctl roles                                 # list role labels with skill counts
axctl project <context|verify|harness>
axctl evidence <guidance-next|session-summary|weekly>
axctl improve <list|show|accept|reject|verdict|checkpoint|reset>
axctl retro <emit|list|pending|brief|reflect|meta|plan>   # the retro-loop CLI
axctl hook <fire>                           # hook helper invoked from settings.json
axctl hooks <summary|invocations|backtest|bench|session|config ...>   # + hook-config CRUD
axctl hooks bench <file> [--days=N] [--runs=N] [--budget-ms=N] [--json]
                                            # latency ledger: per-fire p50/p95 (spawn) + fires/day + installed-chain budget
axctl hooks latency [--days=N (default 7)] [--baseline=M (default 21)] [--json]
                                            # regression lens: compare recent vs baseline fire latency by hook event from telemetry

axctl daemon <status|start|stop|restart>
axctl doctor                                # local-install health check
axctl install                               # wire launchd + hooks + DB (then runs setup)
axctl setup [--agents=… --no-ingest --yes]  # install agent skills + first ingest + doctor
axctl uninstall                             # remove launchd + bin symlink
axctl update [--check]                      # pull latest release
axctl version [--check|--banner]
```

> `axctl --help` lists the everyday commands plus the read-only insight
> surfaces (`ingest`, `sessions`, `signals`, `improve`, `retro`, `recall`,
> `skills`, `hooks`, `roles`, `serve`, `mcp`, `tui`, `share`, `install`,
> `setup`) to keep it lean. The rest (`derive`, `agents`, `costs`,
> `report`, `context`, `hook`, `project`, `evidence`, `classifiers`,
> `insights`, `daemon`, `doctor`, `uninstall`, `update`, `version`) are hidden
> from `--help` but remain fully invokable by name.

Insight views: [`insights-cli-reference.md`](insights-cli-reference.md).

## Token cost queries

`axctl costs` reads the local `session_token_usage` graph. Provider adapters
write actual token counters when they exist; otherwise ax falls back to a rough
transcript-byte estimate. `session-health` resolves model names through
`agent_model` pricing rows and stores prompt, output, cache-read, cache-write,
and total estimated USD.

Examples:

```bash
axctl costs summary --since=2
axctl costs for --query "live-traces" --limit=20
axctl costs for --terms "live trace,livetrace,live-traces" --since=2 --limit=50
axctl costs for --terms "live trace,livetrace,live-traces" --since=2 --project /Users/me/project
axctl costs for --query "checkout bug" --since=7 --here
axctl costs for --commit 464c80b
axctl costs for --branch main --limit=20
axctl sessions show <session-id>
axctl pricing --query gpt-5.5
```

`--query` and `--terms` can be constrained with `--since=N`, `--project <path>`,
or `--here`. `--here`, `--commit`, and `--branch` use repository graph evidence
from the current git checkout. Direct `--pr <number>` is not wired yet; use the
PR branch or a commit SHA for now.

## Thinking analytics

`ax thinking [--days=N] [--json]` rolls up reasoning spend per model:

- **Claude**: per-turn `thinking_blocks` / `thinking_tokens`. Transcripts strip
  thinking text (empty `thinking` + signature) and carry no thinking-level
  field, but thinking-only assistant events have their own `usage.output_tokens`
  - that is the thinking spend. Mixed thinking+text turns can't be split and
  report 0, so the aggregate is a lower bound. Shows assistant turns, thinking
  turns, % with thinking, block count, token volume, avg tokens/turn, and
  `think_cost` (USD: thinking tokens are output tokens, priced at the model's
  `agent_model.output_per_million_usd`; a TOTAL row sums it).
- **Effort levels** (`session.reasoning_effort`): codex turn_context effort
  (minimal/low/medium/high/xhigh) and claude `settings.json` `effortLevel`
  (high/medium/low). Claude has no per-session effort field, so the global
  setting is stamped only on sessions active within 30 minutes of ingest -
  live sessions get accurate values, history is never backstamped.
- **Codex reasoning tokens**: `reasoning_output_tokens` as a share of output
  tokens (from `token_count.total_token_usage`), with its USD cost
  (`reasoning_cost_usd`) at the model's output rate.

Fields populate at ingest; sessions ingested before the fields existed read as
zero until their files are re-ingested (the command prints a hint).

## Digest (push-value)

`ax digest [--json] [--refresh]` renders your local digest board - the ranked
ax signal a SessionStart hook pushes into the agent's context so value arrives
without being asked for:

- **Sources**: open `improve` proposals, routing savings (`ax dispatches
  --candidates`), repair-loop churn (`ax sessions churn`), and quota window burn
  (only surfaced above 70%). Each maps to one line with a copy-paste action.
- **Ranking**: `salience = base[kind] × urgency × recency`; the snapshot stores
  the top 8, the hook surfaces the top 3 unshown.
- **Compute/surface split**: a `derive`-tagged ingest stage writes
  `~/.ax/digest.json` every ingest (failure-isolated - a digest error never
  aborts the surrounding ingest); the `surface-digest` hook reads it, dedups
  against `~/.ax/digest-shown.json` (6h window, count cap, resolved-drop), and
  injects. DB down ⇒ stale snapshot, session still boots.
- `--refresh` recomputes now instead of waiting for the watcher; `--json` prints
  the raw snapshot. Install the hook with `ax hooks install
  <path>/surface-digest.ts --providers=claude,codex`.

## Utilization

`ax usage [--days=N] [--json]` shows your ax utilization for the last N days
(default 30):

- **Active days**: calendar days with at least one invocation.
- **Top commands**: ranked by run count, up to 8 shown.
- **Agent vs TTY split**: how many invocations came from an agent subshell vs
  an interactive terminal.
- **Never used**: visible top-level commands with zero invocations in the
  window - the surface you haven't explored yet.

Usage records are written by the CLI itself at every invocation (including
failures) to `~/.ax/usage.jsonl`; `ax ingest` imports them into the
`ax_invocation` table.  Run `ax ingest` first to see populated results.

## Dispatch model drops

`ax dispatches` flags routed dispatches whose child ran legs on a different
model: the harness applies the Agent `model` param to the first leg only, and
SendMessage follow-ups / post-compact resumes continue on the parent session's
model. Rows are marked `!` in the child_model column; the footer sums dropped
dispatches and the cost of off-model legs. Per-model legs come from
`turn_token_usage` (`child_legs` in `--json`).

## Dispatch economy lens

`ax dispatches --economy [--days=N]` measures whether the route-dispatch advisory
is working: of the inherit dispatches that matched a route-down routing class
(mechanical work that *could* be routed to a cheaper model), how many ran cheap
(sonnet/haiku) vs expensive (fable/opus)? The expensive-tier count is the
addressable overspend. The lens also reports the count of route-dispatch Advise
hook fires in the window (unlinked from outcomes - attributing an advisory to the
resulting dispatch requires a clean PreToolUse→spawn join that isn't available;
deferred). By-class table sorted by overspend. Use `--candidates` for the
per-dispatch view of the expensive-tier rows.

## Grounded agent files (`axctl improve`)

- `axctl improve recommend [--limit=N] [--form=skill] [--apply]` - print N
  ranked proposals as paste-ready blocks (already wrapped in `<!--ax:id-->`
  provenance markers). `--apply` enters an interactive accept loop.
- `axctl improve accept <id> [--with-agent] [--auto-scaffold] [--force]` -
  Default emits `.ax/tasks/<id>.md`, a brief your agent (Claude Code,
  Codex) executes. `--auto-scaffold` writes `SKILL.md` directly.
  `--with-agent` adds a `claude -p` subagent pass that reads the stub +
  sibling skills and rewrites it with concrete triggers, steps, and
  anti-patterns. Optionally writes a sibling `PLAN.md`.
- `axctl improve lint [--root=<dir>] [--stale-days=N]` - scan grounded agent
  files, reconcile markers with the DB, remove consumed task files, warn on
  orphans or tasks older than `--stale-days` (default 7).
- `axctl improve show <id>` - full evidence trail for one proposal.
- `axctl improve list [--status=open|accepted|rejected|all]` - browse the
  proposal queue.
- `axctl improve verdict <id> [--set=...]` - inspect or lock the +30-session verdict.
- `axctl improve reject <id> [--reason=...]` - dedupes future re-proposals
  of the same trigger.

## MCP server tools

`ax mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio. Register it with **Claude Code**:

```bash
claude mcp add ax -- ax mcp        # add --scope user to make it global
```

Register it with **Codex** by adding to `~/.codex/config.toml`:

```toml
[mcp_servers.ax]
command = "ax"
args = ["mcp"]
```

The 17 tools, each mirroring the matching CLI command:

- **recall** - full-text recall across turns / commits / skills (`ax recall`).
- **sessions_around** - sessions in a date window (`ax sessions around`).
- **session_show** - one session's detail, with optional subagent expansion
  and skill-by-role grouping (`ax sessions show`).
- **skills_weighted** - usage x role-weight skill ranking (`ax skills weighted`).
- **skills_by_role** - skills tagged with a given role (`ax skills by-role`).
- **skills_roles** - roles for a given skill (`ax skills roles`).
- **roles** - the full role vocabulary (`ax roles`).
- **improve_recommend** - top improvement proposals, ranked (`ax improve recommend`).
- **improve_show** - one proposal's evidence trail (`ax improve show`).
- **improve_list** - proposals filtered by status / form (`ax improve list`).
- **session_metrics** - graph-derived per-session metrics: commits, churn, cost, corrections (`ax sessions metrics`).
- **signal_show** - signal catalog list or run a named relation signal (`ax signals`).
- **cost_models** - per-model token and cost rollup (`ax cost models`).
- **cost_split** - cost matrix split by origin x model (`ax cost split`).
- **cost_routability** - main-thread routable-spend lens with est savings (`ax cost routability`).
- **dispatches** - subagent dispatch analytics and routing candidates (`ax dispatches`).
- **dojo_agenda** - dojo training agenda: budget envelope + prioritized work items (`ax dojo agenda`).

> **Read-only.** Mutating ops (`improve accept/reject/verdict`, `skills
> tag/lint`, `ingest`) stay on the CLI - they write task files / edges a human
> reviews - so v0 exposes no mutating tools.
>
> **Run it from source** (the `bin/axctl` shim does this). Unlike live ingest,
> the MCP server pulls in no native deps (just the JS MCP SDK + the SurrealDB
> client), so the compiled standalone binary should serve it too - that path is
> just untested in v0.
>
> `sessions_here` / `sessions_near` are intentionally deferred - they need a
> git/cwd-resolved repository key, a documented follow-up.

## Team

`ax team sync [--dry-run] [--yes]`

Activate the team's committed `.ax/` rig (skills + agents) into your runtime, trust-gated. Non-executable only - hooks in `.ax/hooks/` are reported as gated but never activated. `--dry-run` shows what would change. `--yes` approves activation (required when activating new or changed artifacts).

`ax team trust [--yes] [--allow-branch]`

Review + install the team's executable `.ax/hooks/*` into your runtime. Uses sha256 trust-on-change: a hook is only installed when its content hash is new or changed, and only when running on the repo's default branch. `--yes` approves installation without interactive prompting. `--allow-branch` bypasses the default-branch guard (advanced use). Fail-safe: non-TTY without `--yes` installs nothing. Team hooks must be self-contained or import from `@ax/hooks-sdk` (v1 limitation: no arbitrary package resolution at hook fire time).

`ax team experiment <start|list|promote|drop> <kind> <name>`

Iterate on a team artifact (`kind` = `skill` | `agent` | `hook`) in an isolated, gitignored `.ax.local/` overlay, then promote it into the committed `.ax/` rig.

- `start <kind> <name>` - copies the committed artifact (or scaffolds a new one) into `.ax.local/<kind>s/<name>` for isolated editing. Adds `.ax.local/` to `.gitignore` automatically.
- `list` - shows all active experiments in `.ax.local/`, noting which ones override a committed version.
- `promote <kind> <name>` - moves the overlay artifact to `.ax/<kind>s/<name>`, stages it with `git add`, and clears the overlay copy. Open a PR after this step. Promoted hooks must be re-trusted by teammates via `ax team trust` after the PR merges.
- `drop <kind> <name>` - discards the overlay copy, reverting to the committed version.

During iteration, use `ax team sync --yes` (or `ax team trust --yes` for a hook) to activate the overlay version in your own runtime; `sync` annotates overlay-sourced artifacts as `(experiment)` in its output. `experiment score` (telemetry-gated ranking of experiment vs baseline) is deferred to the hosted phase.

## Live ingest in the dashboard

`axctl serve` exposes `POST /api/ingest` (also wired to the dashboard's **Live**
tab): it triggers an in-process ingest run and streams progress to a per-run
[Durable Stream](superpowers/research/durable-streams-api.md) named
`ingest:<runId>`. The live view replays history from the start and then
continues live, so a mid-run refresh or reconnect rehydrates finished stages
and resumes the tail (offset-resume, not raw SSE). An `IngestStreamBus` seam
keeps the local Durable-Streams-in-Bun backing swappable for a hosted backend
without touching producers or UI; the CLI `axctl ingest` and its terminal
animation are unchanged.

> Live ingest requires running ax **from source** (the `bin/axctl` shim already
> does). The compiled standalone binary serves the dashboard but disables live
> ingest, since native lmdb can't be bundled into the `--compile` binary.
