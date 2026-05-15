# Agent Wrapped Design

## Summary

Agent Wrapped is a personality-led recap for AI agent harness use. It turns the local `ax` evidence graph into an internal, evidence-backed report and a sanitized public story deck that users can share on X.

The product angle is not generic telemetry. It answers: "What kind of agent collaborator am I?" The shareable surface is a set of archetype cards. The trusted surface is the local report that backs each card with graph evidence.

## Goals

- Generate a personality profile from existing graph data: sessions, turns, skills, tools, friction, verification behavior, repositories, commits, plans, and derived signals.
- Provide a local `/wrapped` dashboard route for the full internal report.
- Provide an exportable public story deck that is safe to share by default.
- Keep the insight model independent from rendering so future targets can reuse it, including static HTML export and Cloudflare R2 publishing.
- Make each public card traceable to internal evidence without exposing private context.

## Non-Goals

- No hosted publishing in v1.
- No automatic public upload in v1.
- No raw transcript excerpts in public exports.
- No social account integration in v1.
- No LLM-only personality labels without deterministic graph evidence.

## Product Shape

Agent Wrapped has two outputs.

### Internal Wrapped Report

The internal report is a local dashboard route at `/wrapped`. It can show sensitive local data because it runs on the user's machine.

It should include:

- A Claude-style usage snapshot with sessions, messages, token volume, active days, streaks, peak hour, model mix, and activity heatmap when the data is available.
- Primary archetype and confidence.
- Secondary archetypes.
- Evidence-backed explanations for why the archetype was assigned.
- Deep links to existing `ax` surfaces such as sessions, tools, skills, projects, skill graph, workflow, and recall.
- Interesting facts derived from the graph.
- A public-preview panel showing what will be included in the sanitized deck.
- Redaction controls for public export.

### Public Story Deck

The public deck is optimized for quick X sharing. It should be image-first and portrait-friendly, with copy that feels like an identity statement rather than a metrics dashboard.

Public cards should show:

- The main archetype.
- A short personality line.
- Aggregate supporting stats.
- One compact "usage wrapped" card inspired by Claude Code's insights overview: total sessions/messages, token scale, active days, streak, peak hour, and favorite model.
- Interesting "most you" facts with internet-native labels such as "Token Maxxing" or "Skill Stacker."
- An `ax` brand mark or footer.
- Optional public URL slot for a future static report.

Public cards must avoid sensitive details by default:

- No repository names.
- No file paths.
- No command text.
- No prompt or transcript snippets.
- No raw error text.
- No usernames, local paths, remotes, or private issue references.

Users can opt in to specific detail classes later, but the v1 default is aggregate-only.

## Archetype Model

The first version should use deterministic scoring rules over the local graph. A profile may have one primary archetype and several secondary traits.

Candidate archetypes:

- `The Verifier`: high verification command usage, strong completion checks, frequent `project verify`, test commands, and low unverified completion rate.
- `The Debugger`: high friction-to-recovery activity, repeated failed command diagnosis, meaningful recovery edges, and diagnostic loops.
- `The Orchestrator`: frequent plan updates, subagent use, multi-step workflows, tool diversity, and cross-session coordination.
- `The Skill Collector`: high skill invocation diversity, frequent skill pairing, many installed or recently used skills.
- `The Refactorer`: high file-change breadth, repeated architecture/design docs, commit patterns around refactors, and file co-change clusters.
- `The Context Curator`: frequent recall, file-context, project-context, and grounding commands before edits.
- `The Tool Tamer`: broad tool usage with declining tool failure rate or strong recovery from tool failures.

The profile should expose both scores and explanations. A card should never claim an archetype unless the backing score includes enough evidence.

## Interesting Facts

Wrapped should include a layer of small, memorable facts. These are not primary archetypes; they are shareable observations that make the deck feel personal.

Each fact needs three forms:

- Internal title and explanation with evidence links.
- Public-safe title and copy.
- Deterministic query/scoring rule.

Candidate facts:

- `Token Maxxing`: biggest token day, token-heavy sessions, token streaks, and token scale comparisons.
- `Tool Tamer`: most-used tool, tool diversity, and strongest tool-failure recovery pattern.
- `Verifycel`: unusually high test, check, or `project verify` activity before completion.
- `Context Gobbler`: high recall, context, file-read, or search volume before edits.
- `Peak Hour Agent`: strongest hour-of-day activity cluster.
- `Model Loyalist`: dominant model usage or notable model switching behavior.
- `Friction Farmer`: repeated failures that later became solved or reduced patterns.
- `Skill Stacker`: frequent skill pairings or unusually diverse skill invocation.
- `Repo Monogamist`: deep focus in one repository.
- `Repo Hopper`: broad activity across many repositories.
- `Subagent Summoner`: frequent spawned-agent or orchestration behavior.
- `Patch Sprinter`: short time from first edit to verification or completion.
- `Night Shift Builder`: sessions clustered late at night.

The public deck should prefer these labels over dry metric names. The internal report should make the evidence plain enough that the label feels earned, not random.

## WrappedProfile Data Contract

Create a query-layer contract that is independent of dashboard rendering:

```ts
interface WrappedProfile {
    readonly period: {
        readonly label: string;
        readonly startedAt: string;
        readonly endedAt: string;
    };
    readonly primaryArchetype: WrappedArchetype;
    readonly secondaryArchetypes: readonly WrappedArchetype[];
    readonly facts: readonly WrappedFact[];
    readonly metrics: WrappedMetrics;
    readonly privacy: WrappedPrivacySummary;
}

interface WrappedArchetype {
    readonly id: string;
    readonly label: string;
    readonly score: number;
    readonly confidence: "low" | "medium" | "high";
    readonly publicLine: string;
    readonly internalExplanation: string;
    readonly evidence: readonly WrappedEvidence[];
}

interface WrappedFact {
    readonly id: string;
    readonly title: string;
    readonly publicText: string;
    readonly internalText: string;
    readonly sensitivity: "public" | "aggregate" | "sensitive";
    readonly evidence: readonly WrappedEvidence[];
}

interface WrappedEvidence {
    readonly kind: "session" | "tool" | "skill" | "project" | "query" | "insight";
    readonly label: string;
    readonly href?: string;
    readonly count?: number;
}
```

The exact TypeScript shape can change during implementation, but these boundaries should remain:

- Query code computes the profile.
- Dashboard code renders the profile.
- Export code sanitizes the profile before rendering public artifacts.
- Future static/R2 publishing consumes the sanitized artifact bundle, not raw graph data.

## Privacy Model

The internal report and public deck use separate representations.

Internal profile:

- May include sensitive labels and links.
- May include local-only evidence.
- Never leaves the machine unless the user manually exports or publishes it.

Public profile:

- Aggregate-only by default.
- Uses generic labels such as "your busiest repo" instead of repo names.
- Uses normalized categories such as "test runner failure" instead of raw command output.
- Includes only public-safe facts unless the user explicitly opts in.

Export should include a privacy review step:

- Show included cards.
- Show included detail classes.
- Show blocked sensitive fields.
- Let the user regenerate with stricter redaction.

## Dashboard Flow

Add a new `Wrapped` tab or route:

1. User opens `/wrapped`.
2. Dashboard fetches `/api/wrapped`.
3. Report renders primary archetype, secondary traits, top facts, and evidence.
4. User opens public preview.
5. User adjusts redaction options.
6. User exports a story deck bundle.

The v1 export bundle can be static files on disk:

- `index.html` for local preview.
- One HTML page per card or a single deck HTML page.
- Optional generated PNG images if rendering support is added in v1.
- `wrapped-public.json` containing the sanitized profile.

## API Shape

Add dashboard API endpoints:

- `GET /api/wrapped?period=year`
- `GET /api/wrapped/public-preview?period=year`
- `POST /api/wrapped/export`

The CLI can later wrap the same query and export functions:

- `axctl wrapped --period=year`
- `axctl wrapped export --period=year --out=...`

## Data Sources

Useful existing graph tables and relations:

- `session`, `turn`, `tool_call`
- `skill`, `invoked`, `skill_paired`
- `friction_event`, `diagnostic_event`, `recovered_by`
- `plan`, `plan_item`, `plan_snapshot`
- `repository`, `checkout`, `commit`, `produced`, `touched`, `edited`
- `session_health`, `command_outcome`, `workflow_epoch`, `skill_candidate`

Claude Code's built-in insights view is a useful reference and possible data source where transcript-derived values line up:

- Sessions and messages map to `session` and `turn`.
- Token totals and model usage should use `session_token_usage` when available, then fall back to estimates or omit the card.
- Active days, streaks, and peak hour can be computed from session/turn timestamps.
- The activity heatmap can be generated from per-day turn, session, or token totals.
- Memorable scale comparisons such as "tokens vs. a book" are allowed in public exports if they use aggregate counts only.

The feature should prefer existing derived signals where available, then fall back to direct query aggregation.

## V1 Scope

V1 should deliver:

- `/wrapped` route.
- Deterministic `WrappedProfile` query.
- 5-7 archetypes with documented scoring.
- Claude-style usage overview section and heatmap.
- Internal evidence-backed report.
- Sanitized public preview.
- Static export bundle to a local directory.

V1 can defer:

- PNG rendering if HTML story cards are good enough for screenshots.
- R2 publishing.
- Public permalink management.
- Share text generation.
- Time-series animation or video.

## Future R2 Publishing

The future publishing flow should upload only the sanitized static bundle:

1. Generate `wrapped-public.json`.
2. Generate static HTML/CSS assets.
3. Upload to R2 or another static host.
4. Return a public URL.

The publisher should not need database access and should not receive raw internal evidence.

## Testing

Tests should cover:

- Archetype scoring on fixed fixture profiles.
- Privacy sanitizer removes sensitive fields.
- Public profile cannot include repo names, file paths, raw command text, or transcript excerpts by default.
- Dashboard API returns stable profile shape for empty, sparse, and rich graphs.
- Export writes expected files without requiring hosted services.

## Open Decisions

- Exact visual identity for public cards.
- Whether v1 generates PNGs or relies on browser screenshots of HTML cards.
- Default period: year-to-date, last 365 days, or all-time.
- Whether archetype scoring should be persisted as an `insight`/`artifact` record or computed on demand.
