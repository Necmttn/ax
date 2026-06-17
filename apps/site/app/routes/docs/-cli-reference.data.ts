/**
 * Typed CLI reference data for /docs/cli-reference.
 *
 * Authoritative, hand-curated mirror of the real `ax` CLI surface
 * (apps/axctl/src/cli/commands/*). One entry per current top-level
 * subcommand, grouped by job. A freshness lint
 * (scripts/check-site-cli-reference.ts + the bun:test beside this file)
 * diffs `COMMAND_NAMES` below against the actual command modules so a new
 * subcommand can't ship undocumented.
 *
 * Always "ax" in visitor-facing copy, never "axctl".
 */

/** A single flag worth calling out on the command card. */
export interface CliFlag {
  readonly flag: string;
  readonly desc: string;
}

/** One documented top-level command (may have sub-verbs folded into `sub`). */
export interface CliCommand {
  /** Top-level command name as the user types it after `ax`. */
  readonly name: string;
  /** Sub-verbs, e.g. ["here", "around", "near"], for the index + detail. */
  readonly sub?: readonly string[];
  /** One-line job statement. */
  readonly job: string;
  /** Canonical signature, e.g. "ax sessions here [--days=N] [--limit=N]". */
  readonly signature: string;
  /** 2-3 key flags surfaced on the card. */
  readonly flags: readonly CliFlag[];
  /** ONE realistic output receipt (plain text, no personal paths). */
  readonly receipt: string;
  /** Deeper flag / sub-verb notes, shown behind a disclosure. */
  readonly detail?: readonly string[];
}

/** A job-grouped section with a mono $-eyebrow. */
export interface CliGroup {
  /** Mono $-eyebrow, e.g. "$ see where the money goes". */
  readonly eyebrow: string;
  /** Short human heading. */
  readonly title: string;
  /** One-line framing for the group. */
  readonly blurb: string;
  readonly commands: readonly CliCommand[];
}

export const CLI_GROUPS: readonly CliGroup[] = [
  {
    eyebrow: "$ mine your history",
    title: "Query the graph",
    blurb:
      "ax watches every coding-agent session across five harnesses and turns it into a local graph. These commands read it back.",
    commands: [
      {
        name: "ingest",
        sub: ["here"],
        job: "Pull skills, transcripts, git history, and insight artifacts into the local graph.",
        signature: "ax ingest [--stages=a,b,c] [--since=N] [--dry-run] [--reset]",
        flags: [
          { flag: "--since=N", desc: "only the last N days of transcripts/commits" },
          { flag: "--dry-run", desc: "estimate the full backfill and exit (add --json)" },
          { flag: "--stages=a,b,c", desc: "run a custom subset; --derive-only runs the derive stages" },
        ],
        receipt: `$ ax ingest --since=1
claude    parsed 12 sessions, 318 turns
git       6 repos, 41 new commits
signals   derive complete  (friction 4, recovery 9)
ingest: ok`,
        detail: [
          "ax ingest here scopes the run to the git repo at $PWD: the Claude stage is restricted to the matching ~/.claude/projects/<slug>/ transcript dir and git history to this repo path.",
          "Codex, Pi, OpenCode, and Cursor are skipped by ingest here by default (no cwd filter yet); pass --stages to override.",
          "--reset wipes the skill graph before a full re-ingest so it rebuilds clean.",
          "--progress=plain|pipeline|json|off controls the live progress renderer; a non-TTY is silent unless forced.",
        ],
      },
      {
        name: "sessions",
        sub: ["here", "around", "near", "show", "compare", "metrics", "churn"],
        job: "Windowed session queries: by repo, by date, by commit, plus side-by-side and churn views.",
        signature: "ax sessions here|around <date>|near <sha>|show <id>|compare <a> <b>|metrics|churn",
        flags: [
          { flag: "--days=N", desc: "window size (here defaults 14, around defaults ±3)" },
          { flag: "--here", desc: "scope metrics/churn to the current git repo" },
          { flag: "--json", desc: "machine output with a copy-paste `next:` follow-up envelope" },
        ],
        receipt: `$ ax sessions here --days=7
started_at                source            repo            turns  summary
------------------------------------------------------------------------------
2026-06-12T09:14:02.118Z  claude-code       acme-api          38   add retry/backoff to the uploader
2026-06-11T16:02:51.004Z  codex             acme-api          12   fix flaky integration test
(1 subagent session hidden - pass --include-subagents to show)`,
        detail: [
          "ax sessions here lists pwd-repo sessions (default 14d). Subagent sessions are hidden unless --include-subagents.",
          "ax sessions around <date> takes a YYYY-MM-DD or ISO8601 date and a ±N-day window (--days, default 3); --project filters by slug or absolute path.",
          "ax sessions near <sha> lists sessions overlapping a commit window (predecessor commit ts → this commit ts); falls back to ±3d for orphan commits.",
          "ax sessions show <id> renders one session's tool-call + subagent timeline plus a durability Metrics block; --expand=<uuid> (repeatable) or --all drills into subagents, --by-role groups top skills.",
          "ax sessions compare <a> <b> [...] lines up 2+ runs on duration/tokens/cost/turns/errors and stars the winner per axis; --turns adds a per-turn appendix.",
          "ax sessions metrics lists graph-derived per-session metrics; --group-by=model|repo|source|week folds into rollups, --skill=<name> compares with/without the skill.",
          "ax sessions churn summarizes verification churn (edit/landed/repair LOC, failed checks, episodes); --since defaults 30d.",
        ],
      },
      {
        name: "recall",
        job: "Full-text search across turns, commits, and skills, auto-scoped to the current repo.",
        signature: "ax recall <query> [--sources=turn,commit,skill] [--scope=here|all]",
        flags: [
          { flag: "--sources=...", desc: "record types to search (default turn)" },
          { flag: "--scope=here|all", desc: "current repo (auto-detected) vs everything" },
          { flag: "--project=? / --skill=?", desc: "open an interactive picker" },
        ],
        receipt: `$ ax recall "retry backoff" --sources=turn,commit
turns
2 matches
2026-06-12  claude-code  assistant  acme-api  9b2c1f
  wrapped the upload in an exponential backoff retry loop

commits
1 match
2026-06-12  acme-api  4f1a8d20
  feat(upload): retry with backoff on 5xx`,
      },
    ],
  },
  {
    eyebrow: "$ see where the money goes",
    title: "Cost & routing",
    blurb:
      "Receipts on token spend, then a closed loop that routes mechanical subagent work to cheaper models and measures whether it worked.",
    commands: [
      {
        name: "cost",
        sub: ["models", "sessions", "split"],
        job: "Model and cost analytics: per-model rollups, top sessions, main-vs-subagent split.",
        signature: "ax cost models|sessions|split [--days=N] [--json]",
        flags: [
          { flag: "--days=N", desc: "window (default 14)" },
          { flag: "--model=<name>", desc: "filter cost sessions to one model" },
          { flag: "--limit=N", desc: "cap rows for cost sessions (default 20)" },
        ],
        receipt: `$ ax cost models --days=14
model                  sessions     prompt  completion   cost
claude-opus-4               18    412,330      88,120  $42.17
claude-sonnet-4             54    980,114     201,447  $19.05

total: $61.22  (14 days)`,
        detail: [
          "ax cost models: per-model rollup of sessions, prompt/completion/cache tokens, and estimated cost USD.",
          "ax cost sessions: the most expensive sessions with id, project, model, started_at; --model and --limit narrow it.",
          "ax cost split: origin (main vs subagent) × model matrix with cost and share-of-total, plus a totals row.",
        ],
      },
      {
        name: "dispatches",
        sub: ["compile-routing"],
        job: "Subagent dispatch table sorted by child cost, with a candidates view for cheap-model routing.",
        signature: "ax dispatches [--days=N] [--limit=N] [--candidates]",
        flags: [
          { flag: "--candidates", desc: "inherit + expensive + routing-class match, with est. savings" },
          { flag: "--days=N", desc: "window (default 14)" },
          { flag: "--limit=N", desc: "rows in the table (default 30)" },
        ],
        receipt: `$ ax dispatches --candidates --days=14
ts                   agent_type    description           suggest   child_cost  est_savings
2026-06-11T14:22:08  general       run the test suite    sonnet         $1.84       $1.55
2026-06-10T09:51:30  general       lint and format       sonnet         $0.92       $0.78

total est savings: $2.33
top classes: run-tests ($1.55), lint-format ($0.78)`,
        detail: [
          "ax dispatches: the default table shows ts, agent_type, description, dispatch_model (\"inherit\" when unset), child_model, child_cost_usd, plus a summary (count, % inherit, total subagent cost).",
          "ax dispatches --candidates filters to inherit + expensive (fable/opus) dispatches that match a routing class, suggesting a cheaper model and estimated savings per dispatch.",
          "ax dispatches compile-routing is an alias of `ax routing compile` (writes ~/.ax/hooks/routing-table.json from the built-in defaults, preserving origin:user classes).",
        ],
      },
      {
        name: "routing",
        sub: ["tune", "compile", "show"],
        job: "Routing-table operations: mine your dispatch history for new classes, regenerate, inspect.",
        signature: "ax routing tune|compile|show [--days=N] [--out=PATH]",
        flags: [
          { flag: "--dry-run", desc: "(tune) print proposals only" },
          { flag: "--emit-brief", desc: "(tune) write an agent-backtest brief for judgment cases" },
          { flag: "--apply=id,id", desc: "(tune) apply specific proposal ids post-brief" },
        ],
        receipt: `$ ax routing tune --dry-run --days=30
id                  pattern              suggest  count  addressable  judgment
run-tests           run * tests          sonnet      11       $14.20  no
lint-format         lint and *           sonnet       6        $5.40  no

2 proposals  addressable spend: $19.60  (30 days)`,
        detail: [
          "ax routing tune mines unmatched expensive inherit dispatches (two-token prefix clustering, ≥3 members) and auto-applies non-judgment proposals to the routing table as origin:user.",
          "Judgment-flagged classes (review/design/plan/audit/...) are never auto-applied; ship them via --emit-brief → agent backtest → --apply=ids.",
          "ax routing compile is a merge-preserving regenerate (defaults refresh, origin:user classes survive; refuses to overwrite a corrupt file).",
          "ax routing show prints the effective table with class origins.",
        ],
      },
      {
        name: "quota",
        job: "Live Claude plan usage (5h / 7d windows) from the Anthropic usage endpoint.",
        signature: "ax quota [--json|--statusline|--swiftbar] [--max-age=N] [--fresh]",
        flags: [
          { flag: "--statusline", desc: "one plain line for the Claude Code statusLine command" },
          { flag: "--swiftbar", desc: "SwiftBar/xbar menubar plugin body" },
          { flag: "--max-age=N", desc: "cache TTL seconds (default 60); --fresh forces a refetch" },
        ],
        receipt: `$ ax quota
window   used   resets in   source
5h        41%   2h 18m      live
7d        63%   3d 04h      live`,
        detail: [
          "Reads the Claude Code OAuth token (macOS Keychain \"Claude Code-credentials\", fallback ~/.claude/.credentials.json); never refreshes it.",
          "Responses are cached at ~/.ax/quota-cache.json so statusline/menubar callers can poll freely; fetch failures degrade to the stale cache.",
          "--json, --statusline, and --swiftbar are mutually exclusive. Render-only modes never fail loud - they print a quiet \"quota n/a\" and exit 0.",
        ],
      },
      {
        name: "thinking",
        job: "Extended-thinking and reasoning-effort analytics, per model and source.",
        signature: "ax thinking [--days=N] [--json]",
        flags: [
          { flag: "--days=N", desc: "window (default 14)" },
          { flag: "--json", desc: "machine output" },
        ],
        receipt: `$ ax thinking --days=14
model                 sessions  think_turns  think%   think_tokens
claude-opus-4               18           94   41.2%        612,400
claude-sonnet-4             54          120   18.7%        201,330`,
        detail: [
          "Thinking volume (blocks/tokens) is counted from thinking content blocks at ingest; rows ingested before the fields existed read zero until a re-ingest backfills them.",
          "Reasoning-effort distribution spans sources: Codex turn_context effort and Claude settings.json effortLevel stamped on sessions active at ingest time.",
        ],
      },
      {
        name: "digest",
        job: "Your ranked digest board - the ax signal a session-start hook pushes into the agent's context so value arrives without being asked for.",
        signature: "ax digest [--json] [--refresh]",
        flags: [
          { flag: "--refresh", desc: "recompute the snapshot now instead of waiting for the watcher" },
          { flag: "--json", desc: "print the raw snapshot JSON" },
        ],
        receipt: `$ ax digest
[ax] your board (14d window):
  - repair-loop (927 LOC churned, 1 failed check: test)
      -> ax sessions churn --here
  - routing could save ~$292/wk (61% inherit)
      -> ax dispatches --candidates
  - 6 improve proposals pending
      -> ax improve recommend`,
        detail: [
          "A derive-tagged ingest stage writes ~/.ax/digest.json every ingest; the surface-digest hook reads it, dedups against ~/.ax/digest-shown.json (6h window, count cap, resolved-drop), and injects the top 3 at session start.",
          "Sources: open improve proposals, routing savings, repair-loop churn, and quota burn (surfaced only above 70%). Compute and surface are split by the snapshot file, so a DB hiccup never blocks session boot.",
        ],
      },
      {
        name: "usage",
        job: "Your ax utilization: total runs, active days, top commands, agent-vs-tty split, and the surface you have never touched.",
        signature: "ax usage [--json] [--days=N]",
        flags: [
          { flag: "--days=N", desc: "window in days (default 30)" },
          { flag: "--json", desc: "machine output: full UsageRollup JSON" },
        ],
        receipt: `$ ax usage
[ax] usage (30d): 147 runs across 18 active days  (agent 89 / tty 58)
top commands:
  ingest                   42
  sessions                 31
  improve                  19
  cost                     14
  quota                     9
  dispatches                8
  thinking                  7
  recall                    5
3 never used: tui, share, dojo`,
        detail: [
          "Usage records are written at every invocation (including failures) to ~/.ax/usage.jsonl and imported into ax_invocation at ingest time. Run ax ingest first to see populated results.",
          "The never-used list shows visible top-level commands with zero invocations in the window - a quick way to spot surface you have not explored.",
        ],
      },
    ],
  },
  {
    eyebrow: "$ review proposals",
    title: "The experiment loop",
    blurb:
      "ax mines repeated mistakes and proposes small, repo-specific fixes - reviewed one at a time, then measured at +3 / +10 / +30 sessions.",
    commands: [
      {
        name: "improve",
        sub: [
          "recommend",
          "accept",
          "reject",
          "list",
          "show",
          "lint",
          "checkpoint",
          "verdict",
          "propose",
          "analyze",
          "housekeep",
          "reset",
        ],
        job: "Rank proposals, accept them as task briefs or scaffolds, and track verdicts over time.",
        signature: "ax improve recommend|accept <id>|lint|show <id>|verdict [<id>]",
        flags: [
          { flag: "--apply", desc: "(recommend) interactive accept loop" },
          { flag: "--with-agent", desc: "(accept) dispatch a subagent to enrich a scaffolded skill" },
          { flag: "--set <verdict>", desc: "(verdict) lock adopted|ignored|regressed|partial|no_longer_needed" },
        ],
        receipt: `$ ax improve recommend --limit=3
  freq  conf    title
     7  high    Add a retry skill for flaky uploads
     4  med     Route test-suite dispatches to sonnet
     3  med     Guard against editing on main

[copied to clipboard]`,
        detail: [
          "ax improve recommend ranks open proposals by confidence × recency × frequency and prints paste-ready blocks with <!--ax:id--> provenance markers.",
          "ax improve accept <id> emits a .ax/tasks/<id>.md brief by default; --auto-scaffold writes the artifact directly, --with-agent enriches it with a subagent.",
          "ax improve lint reconciles grounded agent files (AGENTS.md / CLAUDE.md / skills) against the DB and removes consumed task briefs.",
          "ax improve checkpoint computes snapshots at +3/+10/+30 sessions; ax improve verdict locks the final outcome.",
          "ax improve propose is the agent write-path (read one proposal as JSON); analyze and housekeep emit briefs and sweep stale loop state.",
        ],
      },
      {
        name: "retro",
        sub: ["emit", "list", "pending", "brief", "reflect", "meta", "plan"],
        job: "Session retros - structured reflections (tried · worked · failed · next) that feed the loop.",
        signature: "ax retro pending|brief --session=<id>|emit|list|reflect",
        flags: [
          { flag: "--since=N", desc: "(pending) backlog window in days (default 7)" },
          { flag: "--from-file=<json>", desc: "(emit) ingest an agent's {tried,worked,failed,next} payload" },
          { flag: "--session=<id>", desc: "(brief) write a reviewer brief for one session" },
        ],
        receipt: `$ ax retro pending --since=7
2 session(s) pending retro, since=7d limit=20:
  session:9b2c1f4a  [claude-code]  acme-api  idle=2026-06-12T11:02:14Z
  session:71d0e8aa  [codex]        acme-api  ended_at=2026-06-11T16:40:08Z`,
        detail: [
          "The retro loop is pull-based: a watcher surfaces the backlog and the /retro skill drains it. ax does not use a Stop hook.",
          "ax retro pending lists sessions with no `reviewed` edge yet (idle or ended); claude-subagent rows are hidden by default.",
          "ax retro brief --session=<id> writes .ax/tasks/retro/<key>.md for the retro-reviewer subagent.",
          "ax retro reflect walks clustered retro-derived proposals interactively; meta emits a JSON snapshot for a deep retro; plan registers an agent-drafted plan as a proposal.",
        ],
      },
      {
        name: "dojo",
        job: "Training agenda: spends surplus plan quota on a prioritized self-improvement work list.",
        signature: "ax dojo [--budget=N] [--until=HH:MM] [--spar] [--days=N] [--json]",
        flags: [
          { flag: "--budget=N", desc: "cap the spend envelope at N% of the binding quota window" },
          { flag: "--until=HH:MM", desc: "deadline for this session (default: earliest window reset)" },
          { flag: "--spar", desc: "opt into adversarial spar items (needs >=30% spendable quota)" },
        ],
        receipt: `$ ax dojo
budget    37% of 7d window spendable  ·  until 22:59 (reset)
agenda
  1  lock 2 pending verdicts            (improve)
  2  drain 1 unfilled .ax/tasks brief   (task)
  3  mint proposals - open pool < 3     (recommend)
fed to the ax:dojo skill loop`,
        detail: [
          "ax dojo composes a budget envelope from the quota module (binding window remaining minus a 15% reserve, deadline = earliest window reset) and a derived, self-clearing item list.",
          "Items: pending verdicts, unfilled .ax/tasks briefs, judgment-flagged routing backtests, proposal minting (when the open pool < 3), churn-hotspot experiments, opt-in spar, and an explore fallback.",
          "Each item vanishes once the underlying system records the work (verdict locked, brief consumed, proposal created) - the agenda is stateless between runs.",
          "Consumed by the ax:dojo skill loop; drafts land in ~/.ax/dojo/outbox/ and a per-day report in ~/.ax/dojo/reports/.",
        ],
      },
      {
        name: "wrapped",
        sub: ["generate", "publish"],
        job: "Agent-authored Wrapped recap cards for the dashboard landing.",
        signature: "ax wrapped generate [--force] | ax wrapped publish [--file=PATH]",
        flags: [
          { flag: "--force", desc: "(generate) overwrite an existing brief" },
          { flag: "--file=PATH", desc: "(publish) read { cards: [...] } JSON from a file instead of stdin" },
        ],
        receipt: `$ ax wrapped publish --file=cards.json
published 6 wrapped cards - the dashboard landing serves them now`,
        detail: [
          "ax wrapped generate emits .ax/tasks/wrapped-generate-<date>.md - a brief instructing an agent to mine the graph and write recap cards.",
          "ax wrapped publish replaces the wrapped_card set from { cards: [{question, headline, body, sensitivity?}] } JSON.",
        ],
      },
    ],
  },
  {
    eyebrow: "$ rank your skills",
    title: "Skills & roles",
    blurb:
      "What skills you actually use, what they cost in corrections, and how they map to roles in your workflow.",
    commands: [
      {
        name: "skills",
        sub: [
          "search",
          "stats",
          "recent",
          "unused",
          "taste",
          "weighted",
          "pairs",
          "recovery",
          "classify",
          "tag",
          "lint",
          "by-role",
          "roles",
        ],
        job: "Skill-graph queries: usage ranking, classification into roles, and co-occurrence.",
        signature: "ax skills weighted|by-role <role>|roles <skill>|classify|tag <skill> <role>|lint",
        flags: [
          { flag: "--window=Nd", desc: "(weighted) usage window for the ranking" },
          { flag: "--confidence=N", desc: "(tag) 0-1, default 1.0; --rationale=\"...\" annotates" },
          { flag: "--remove", desc: "(tag) delete an existing user-source role edge" },
        ],
        receipt: `$ ax skills weighted --window=30
skill                          role          runs  weight
test-driven-development        verification    61    8.4
systematic-debugging           execution       44    6.1
requesting-code-review         verification    22    3.0`,
        detail: [
          "ax skills weighted ranks skills by usage × role-weight; classified skills score higher and it enters doctor mode when many are unclassified.",
          "ax skills classify bulk-emits .ax/tasks/classify-*.md briefs for unclassified skills with ≥3 invocations.",
          "ax skills tag <skill> <role> writes a plays_role edge (source=user, idempotent); ax skills lint applies filled briefs as source=brief edges.",
          "ax skills by-role <role> and ax skills roles <skill> read the role graph back. Provider built-in tools are hidden unless --include-tools.",
        ],
      },
      {
        name: "roles",
        job: "List the known role labels with skill counts.",
        signature: "ax roles [--json]",
        flags: [{ flag: "--json", desc: "machine output" }],
        receipt: `$ ax roles
role           skills
framing             8
execution          21
verification       14
(unclassified)     37`,
        detail: [
          "Role labels are semantic categories (framing, execution, verification, ...) tagged on skills via plays_role edges; the list includes roles with 0 skills.",
        ],
      },
      {
        name: "signals",
        job: "Cross-session relation signals (e.g. fragility cascades) derived from the graph.",
        signature: "ax signals",
        flags: [],
        receipt: `$ ax signals
fragility-cascade   3 sessions  acme-api/uploader.ts
correction-loop     2 sessions  flaky integration test`,
        detail: [
          "Pairs with `ax sessions metrics` (per-session scalars) - signals surface the cross-session relations behind them.",
        ],
      },
    ],
  },
  {
    eyebrow: "$ guard the harness",
    title: "Hooks SDK",
    blurb:
      "Author agent hooks once in typed Effect TS and run them on Claude Code + Codex. Verdicts fail open.",
    commands: [
      {
        name: "hooks",
        sub: [
          "config",
          "add",
          "remove",
          "edit",
          "disable",
          "enable",
          "init",
          "install",
          "backtest",
          "summary",
          "invocations",
          "session",
          "cases",
        ],
        job: "Scaffold, install, and backtest typed hooks, plus CRUD over provider hook configs.",
        signature: "ax hooks init | install <file> | backtest <file> | cases | config",
        flags: [
          { flag: "--providers=claude,codex", desc: "(install) fan-out targets" },
          { flag: "--days=N", desc: "(backtest) replay window (default 30)" },
          { flag: "--scope=global|project|local", desc: "(install/add) where the hook lives" },
        ],
        receipt: `$ ax hooks backtest ~/.ax/hooks/enforce-worktree.ts --days=14
enforce-worktree  -  14 days
  replayed   208 tool_call rows
  would block  6   (edits on main)
  allow      202
  warn         0   defects fail OPEN`,
        detail: [
          "A hook is one file in ~/.ax/hooks/ default-exporting defineHook({ name, events, matcher, run }); the fire path is `bun <file>.ts` (~70ms, no ax CLI in the hot path).",
          "ax hooks init scaffolds the workspace (package.json + starter guard hooks); re-run after the SDK moves since the dep is an absolute path.",
          "ax hooks install fans a hook file into provider configs idempotently; Codex requires interactive trust approval before new entries fire.",
          "ax hooks backtest replays historical tool_call rows through the hook in-process (state-dependent checks use CURRENT repo state).",
          "ax hooks cases runs deterministic feedback-case backtests (enforce-worktree candidate query + pass/fail verdict).",
        ],
      },
    ],
  },
  {
    eyebrow: "$ publish your profile",
    title: "Profile & community",
    blurb:
      "Render your local profile and, with explicit consent, publish it to a public gist that joins the community boards.",
    commands: [
      {
        name: "profile",
        sub: ["show", "publish", "unpublish"],
        job: "Render, publish, or unpublish your ax profile (stats + rig + taste).",
        signature: "ax profile show [--window=N] | publish [--yes] | unpublish | interview [submit]",
        flags: [
          { flag: "--window=N", desc: "days of history to summarize (default 30)" },
          { flag: "--no-cost", desc: "omit cost figures (sticky across republishes)" },
          { flag: "--yes", desc: "(publish) skip the first-run consent prompt" },
        ],
        receipt: `$ ax profile show --window=30
ax profile - @octocat  (last 30d)

42 sessions  ·  3.1M tokens  ·  ~$61 est
18 active days  ·  6-day streak  ·  harnesses: claude-code, codex`,
        detail: [
          "ax profile publish creates a public gist once and PATCHes it in place; the first run shows the exact JSON, asks for consent, then opens a community registration PR.",
          "--if-stale=<hours> is the watcher path: a no-op until first consent, then it republishes when stale.",
          "ax profile unpublish deletes the gist and local publish state (and resets the sticky --no-cost).",
          "ax profile interview emits a brief; an agent interviews you (draft-then-confirm) and pipes the result to `ax profile interview submit`, which validates it into ~/.ax/profile-highlights.json. The next `ax profile publish` folds these user-authored highlights into your gist.",
        ],
      },
    ],
  },
  {
    eyebrow: "$ run the daemon",
    title: "Dashboard & integration",
    blurb:
      "Serve the live dashboard, expose the graph to your agent over MCP, or open the terminal UI.",
    commands: [
      {
        name: "serve",
        sub: ["status", "stop"],
        job: "Serve the live web dashboard locally; status/stop manage the running daemon.",
        signature: "ax serve [--port=N] | ax serve status | ax serve stop",
        flags: [
          { flag: "--port=N", desc: "dashboard port (default 8520)" },
        ],
        receipt: `$ ax serve status
ax daemon: running (pid 48213)
  dashboard  http://127.0.0.1:8520
  studio     http://127.0.0.1:8520/studio`,
        detail: [
          "Re-running `ax serve` against a live daemon prints the URLs and exits 0; a foreign listener gets a clean port hint.",
          "status/stop resolve the instance via pidfile → /api/version probe → lsof, so they find pre-pidfile daemons too; stop only kills the pid actually LISTENing on the port.",
        ],
      },
      {
        name: "mcp",
        job: "Run a stdio MCP server exposing ax's read-only queries as tools to an agent.",
        signature: "ax mcp",
        flags: [],
        receipt: `$ ax mcp
ax MCP server ready (stdio) - 17 read-only tools
  recall  sessions_around  session_show  skills_weighted  ...`,
        detail: [
          "Exposes 17 read-only tools (recall, sessions_around, session_show, session_metrics, skills_weighted, skills_by_role, skills_roles, roles, improve_recommend, improve_show, improve_list, signal_show, cost_models, cost_split, cost_routability, dispatches, dojo_agenda).",
          "Mutating ops and git-resolved queries (sessions here/near) are intentionally not exposed.",
        ],
      },
      {
        name: "tui",
        job: "Open the interactive terminal dashboard (skills browser).",
        signature: "ax tui",
        flags: [],
        receipt: `$ ax tui
(opens the OpenTUI skills browser)`,
      },
      {
        name: "share",
        job: "Share a session view via the studio share viewer.",
        signature: "ax share <session-id>",
        flags: [],
        receipt: `$ ax share session:9b2c1f4a
share ready - open in the studio viewer`,
        detail: [
          "Builds a shareable view of one session; see the studio share viewer for the rendered output.",
        ],
      },
      {
        name: "star",
        job: "Star the ax repo from the CLI.",
        signature: "ax star",
        flags: [],
        receipt: `$ ax star
thanks - starred Necmttn/ax`,
      },
    ],
  },
  {
    eyebrow: "$ install & maintain",
    title: "Lifecycle",
    blurb:
      "First-run setup, health checks, and keeping the CLI up to date.",
    commands: [
      {
        name: "install",
        job: "One-shot setup: daemon, watcher, symlink, then runs `ax setup`.",
        signature: "ax install",
        flags: [],
        receipt: `$ ax install
installed daemon + watcher
symlinked ax -> ~/.local/share/ax
running ax setup ...`,
      },
      {
        name: "setup",
        job: "Install the agent skills and hand first ingest to your agent via an onboarding brief.",
        signature: "ax setup [--agents=claude-code,codex] [--yes]",
        flags: [
          { flag: "--agents=...", desc: "which harnesses to wire up" },
          { flag: "--agent-prompt", desc: "print just the paste-to-agent onboarding block" },
        ],
        receipt: `$ ax setup --agents=claude-code
installed 3 skills
verified install - hand the onboarding brief to your agent`,
      },
      {
        name: "doctor",
        job: "Check local installation health (daemon, watcher, DB, skills).",
        signature: "ax doctor [--json]",
        flags: [{ flag: "--json", desc: "machine output" }],
        receipt: `$ ax doctor
daemon     ok (pid 48213)
watcher    ok
database   ok (127.0.0.1:8521)
skills     3 installed`,
      },
      {
        name: "version",
        job: "Print the installed version and optionally check GitHub releases.",
        signature: "ax version [--check] [--json]",
        flags: [{ flag: "--check", desc: "compare against the latest GitHub release" }],
        receipt: `$ ax version
ax 0.29.0`,
      },
      {
        name: "update",
        job: "Update ax from the latest GitHub release.",
        signature: "ax update [--check]",
        flags: [{ flag: "--check", desc: "report whether an update is available without installing" }],
        receipt: `$ ax update --check
update available: 0.29.0 -> 0.30.0`,
      },
      {
        name: "daemon",
        sub: ["status", "start", "stop", "restart"],
        job: "Manage the local launchd services (DB + watcher).",
        signature: "ax daemon status|start|stop|restart",
        flags: [],
        receipt: `$ ax daemon status
daemon   running (pid 48213)
watcher  running`,
      },
      {
        name: "uninstall",
        job: "Remove the launchd plists and the ax symlink.",
        signature: "ax uninstall [--purge]",
        flags: [{ flag: "--purge", desc: "also delete ~/.local/share/ax (binary + data)" }],
        receipt: `$ ax uninstall
removed launchd plists and the ax symlink`,
      },
    ],
  },
  {
    eyebrow: "$ sync the team rig",
    title: "Team",
    blurb:
      "Activate the shared .ax/ skills and agents committed to the repo into your local runtime, trust-gated per content hash. Iterate on artifacts privately in .ax.local/ before promoting. Executable hooks require a separate `ax team trust` review before installation.",
    commands: [
      {
        name: "team",
        sub: ["sync", "trust", "experiment"],
        job: "Sync the team's .ax/ rig, trust-review executable hooks, and iterate on artifacts in an isolated overlay before promoting.",
        signature: "ax team sync|trust|experiment <start|list|promote|drop> [--dry-run] [--yes] [--allow-branch]",
        flags: [
          { flag: "--dry-run", desc: "show what would change without writing anything (sync only)" },
          { flag: "--yes", desc: "approve activation / installation of new or changed artifacts" },
          { flag: "--allow-branch", desc: "bypass the default-branch guard for trust (advanced)" },
        ],
        receipt: `$ ax team sync --yes
[ax team sync]
activated 2:
  + skill:tdd
  + agent:reviewer
1 unchanged
gated (executable hooks - run \`ax team trust\` to install):
  ~ enforce-worktree

$ ax team trust --yes
[ax team trust] installed 1 executable hook(s)
  + hook:enforce-worktree`,
        detail: [
          "ax team sync: scans .ax/skills/, .ax/agents/, and .ax/hooks/ in the current git repo root. Skills and agents are non-executable and safe to copy; hooks in .ax/hooks/ are reported as gated but never activated.",
          "ax team trust: reviews + installs executable hooks from .ax/hooks/ using sha256 trust-on-change. Only installs when on the repo's default branch — refuses on feature branches.",
          "ax team experiment: isolate→iterate→promote loop. `start` copies or scaffolds an artifact into a gitignored .ax.local/ overlay; `list` shows active experiments; `promote` moves the overlay into committed .ax/ + stages with git add (open a PR after); `drop` discards the overlay. Sync annotates overlay artifacts as (experiment).",
          "Content hashes prevent re-activating unchanged artifacts (idempotent). Changed artifacts are re-activated and their trust records updated.",
          "Fail-safe: non-TTY without --yes prints a summary and exits without installing anything.",
          "v1 limitation: team hooks must be self-contained or import from @ax/hooks-sdk.",
        ],
      },
    ],
  },
];

/**
 * Every documented top-level command name, flattened. The freshness lint
 * diffs this against the real CLI command modules.
 *
 * Intentionally NOT documented here (and excluded by the lint allowlist):
 * hidden maintenance/plumbing verbs (derive, derive-signals, derive-intents,
 * insights, classifiers, report, costs, loc, pricing, context, hook, agents,
 * project, evidence, timeline) and the dev-only `dogfood` command.
 */
export const COMMAND_NAMES: readonly string[] = CLI_GROUPS.flatMap((g) =>
  g.commands.map((c) => c.name),
);
