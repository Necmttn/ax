/**
 * SessionTimelineService - feed a session id, get the highlight/event timeline.
 * Thin Effect wrapper: runs the session-scoped queries in parallel, maps rows
 * to clean shapes, and hands them to the pure `buildTimeline` derivation. All
 * the logic lives in `derive.ts` (testable without a DB); this layer is just
 * I/O + composition.
 *
 * `./queries.ts` (the SQL-builder + mapper module) belongs to a sibling
 * ownership boundary, so this file does NOT call into it for SQL or execution
 * - only its exported ROW TYPES are imported (type-only, erased at compile
 * time, zero runtime coupling) so `derive.ts`'s pure inputs stay unchanged. The
 * queries themselves are re-derived here directly against the DuckDB cache
 * through {@link CacheRead}.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TextColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { buildTimeline } from "./derive.ts";
import type { SessionTimeline } from "./types.ts";
import type {
    AskRow,
    CommitRow,
    CompactionRow,
    CorrectionRow,
    CostRow,
    EditRow,
    EditStatRow,
    HealthRow,
    LastTurnRow,
    OverviewRow,
    PlanRow,
    SkillRow,
    ToolCallRow,
} from "./queries.ts";

const present = <T>(x: T | null): x is T => x !== null;
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export interface SessionTimelineShape {
    readonly extract: (sessionId: string) => Effect.Effect<SessionTimeline>;
}

export class SessionTimelineService extends Context.Service<
    SessionTimelineService,
    SessionTimelineShape
>()("ax/SessionTimelineService") {}

// ---------------------------------------------------------------------------
// Row schemas + DuckDB SQL, one per input `buildTimeline` needs. Re-derived
// from the ROW SHAPES `./queries.ts` documents (its SQL is not reused - see
// the module doc).
// ---------------------------------------------------------------------------

const HealthDbRow = Schema.Struct({
    turns: NumberFromBigIntColumn,
    user_turns: NumberFromBigIntColumn,
    assistant_turns: NumberFromBigIntColumn,
    tool_calls: NumberFromBigIntColumn,
    tool_errors: NumberFromBigIntColumn,
    user_corrections: NumberFromBigIntColumn,
    interruptions: NumberFromBigIntColumn,
    estimated_tokens: NumberFromBigIntColumn,
});
const HEALTH_SQL = `
SELECT turns, user_turns, assistant_turns, tool_calls, tool_errors, user_corrections, interruptions, estimated_tokens
FROM session_health WHERE session = ? LIMIT 1`;

const OverviewDbRow = Schema.Struct({
    source: Schema.NullOr(TextColumn),
    model: Schema.NullOr(TextColumn),
    project: Schema.NullOr(TextColumn),
    cwd: Schema.NullOr(TextColumn),
    started_at: Schema.NullOr(TimestampColumn),
    ended_at: Schema.NullOr(TimestampColumn),
});
const OVERVIEW_SQL = `SELECT source, model, project, cwd, started_at, ended_at FROM session WHERE id = ? LIMIT 1`;

const CostDbRow = Schema.Struct({
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    estimated_tokens: NumberFromBigIntColumn,
});
const COST_SQL = `SELECT estimated_cost_usd, estimated_tokens FROM session_token_usage WHERE session = ? LIMIT 1`;

const ToolCallDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    name: TextColumn,
    command_norm: Schema.NullOr(TextColumn),
    command_text: Schema.NullOr(TextColumn),
    output_excerpt: Schema.NullOr(TextColumn),
    error_text: Schema.NullOr(TextColumn),
    has_error: Schema.Boolean,
    call_id: Schema.NullOr(TextColumn),
});
const TOOL_CALLS_SQL = `
SELECT seq, ts, name, command_norm, SUBSTRING(COALESCE(input_json, ''), 1, 1600) AS command_text,
    output_excerpt, error_text, has_error, call_id
FROM tool_call WHERE session = ? ORDER BY seq ASC LIMIT 6000`;

const EditDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    path: Schema.NullOr(TextColumn),
    edit_kind: Schema.NullOr(TextColumn),
    tool: TextColumn,
});
const EDITS_SQL = `
SELECT t.seq AS seq, e.ts AS ts, e.path_seen AS path, e.edit_kind AS edit_kind, e.tool AS tool
FROM edited e JOIN turn t ON t.id = e.in_id
WHERE t.session = ? ORDER BY seq ASC LIMIT 2000`;

const EditStatDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    name: TextColumn,
    input_json: Schema.NullOr(TextColumn),
});
const EDIT_STATS_SQL = `
SELECT seq, name, SUBSTRING(COALESCE(input_json, ''), 1, 32000) AS input_json
FROM tool_call WHERE session = ? AND name IN ('Edit', 'Write', 'NotebookEdit') ORDER BY seq ASC LIMIT 2000`;

const SkillDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    name: TextColumn,
});
const SKILLS_SQL = `
SELECT t.seq AS seq, i.ts AS ts, s.name AS name
FROM invoked i JOIN turn t ON t.id = i.in_id JOIN skill s ON s.id = i.out_id
WHERE i.session = ? ORDER BY seq ASC LIMIT 2000`;

const CorrectionDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    target: Schema.NullOr(TextColumn),
    user_text: Schema.NullOr(TextColumn),
});
const CORRECTIONS_SQL = `
SELECT t.seq AS seq, re.ts AS ts, re.target AS target, re.user_text AS user_text
FROM reaction_event re JOIN turn t ON t.id = re.user_turn
WHERE re.session = ? AND (re.polarity = 'revise' OR re.reaction_type = 'correction')
ORDER BY seq ASC LIMIT 500`;

const IntentCorrectionDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    user_text: Schema.NullOr(TextColumn),
});
const INTENT_CORRECTIONS_SQL = `
SELECT seq, ts, text_excerpt AS user_text
FROM turn WHERE session = ? AND intent_kind = 'correction' ORDER BY seq ASC LIMIT 500`;

const PlanDbRow = Schema.Struct({
    ts: Schema.NullOr(TimestampColumn),
    summary: Schema.NullOr(TextColumn),
    items: Schema.NullOr(TextColumn),
});
const PLANS_SQL = `SELECT ts, summary, items FROM plan_snapshot WHERE session = ? ORDER BY ts ASC LIMIT 500`;

const CommitDbRow = Schema.Struct({
    ts: Schema.NullOr(TimestampColumn),
    sha: Schema.NullOr(TextColumn),
    message: Schema.NullOr(TextColumn),
});
const COMMITS_SQL = `
SELECT c.ts AS ts, c.sha AS sha, c.message AS message
FROM produced p JOIN "commit" c ON c.id = p.out_id
WHERE p.in_id = ? AND p.kind = 'commit' ORDER BY ts ASC LIMIT 200`;

const AskDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    text: Schema.NullOr(TextColumn),
});
const ASKS_SQL = `
SELECT seq, ts, text_excerpt AS text
FROM turn WHERE session = ? AND role = 'user' AND message_kind = 'task' ORDER BY seq ASC LIMIT 1000`;

const CompactionDbRow = Schema.Struct({
    ts: TimestampColumn,
});
const COMPACTIONS_SQL = `SELECT ts FROM compaction WHERE session = ? ORDER BY ts ASC LIMIT 200`;

const LastTurnDbRow = Schema.Struct({
    seq: Schema.NullOr(NumberFromBigIntColumn),
    ts: Schema.NullOr(TimestampColumn),
    text_excerpt: Schema.NullOr(TextColumn),
});
const LAST_ASSISTANT_SQL = `
SELECT seq, ts, text_excerpt FROM turn WHERE session = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1`;

export const SessionTimelineServiceLayer = Layer.effect(SessionTimelineService)(
    Effect.gen(function* () {
        const read = yield* CacheRead;

        const extract = Effect.fn("SessionTimelineService.extract")(function* (sessionId: string) {
            const sid = toBareSessionId(sessionId);
            const [
                healthRaw, overviewRaw, costRaw, toolRaw, editRaw, editStatRaw,
                skillRaw, correctionRaw, intentCorrectionRaw, planRaw, commitRaw, askRaw, compactionRaw, lastRaw,
            ] = yield* Effect.all(
                [
                    read.first(HealthDbRow, HEALTH_SQL, [sid]),
                    read.first(OverviewDbRow, OVERVIEW_SQL, [sid]),
                    read.first(CostDbRow, COST_SQL, [sid]),
                    read.rows(ToolCallDbRow, TOOL_CALLS_SQL, [sid]),
                    read.rows(EditDbRow, EDITS_SQL, [sid]),
                    read.rows(EditStatDbRow, EDIT_STATS_SQL, [sid]),
                    read.rows(SkillDbRow, SKILLS_SQL, [sid]),
                    read.rows(CorrectionDbRow, CORRECTIONS_SQL, [sid]),
                    read.rows(IntentCorrectionDbRow, INTENT_CORRECTIONS_SQL, [sid]),
                    read.rows(PlanDbRow, PLANS_SQL, [sid]),
                    read.rows(CommitDbRow, COMMITS_SQL, [sid]),
                    read.rows(AskDbRow, ASKS_SQL, [sid]),
                    read.rows(CompactionDbRow, COMPACTIONS_SQL, [sid]),
                    read.first(LastTurnDbRow, LAST_ASSISTANT_SQL, [sid]),
                ],
                { concurrency: "unbounded" },
                // A read-only timeline query failing is a defect, not a domain
                // error - mirrors the pre-port `Effect.orDie` on every `rows`/`oneRow`.
            ).pipe(Effect.orDie);

            const health: HealthRow | null = healthRaw._tag === "None" ? null : { ...healthRaw.value };
            const overview: OverviewRow | null =
                overviewRaw._tag === "None"
                    ? null
                    : {
                          source: overviewRaw.value.source,
                          model: overviewRaw.value.model,
                          project: overviewRaw.value.project,
                          cwd: overviewRaw.value.cwd,
                          started_at: isoOrNull(overviewRaw.value.started_at),
                          ended_at: isoOrNull(overviewRaw.value.ended_at),
                      };
            const cost: CostRow | null =
                costRaw._tag === "None"
                    ? null
                    : { cost_usd: costRaw.value.estimated_cost_usd, estimated_tokens: costRaw.value.estimated_tokens };
            const toolCalls: ToolCallRow[] = toolRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const edits: EditRow[] = editRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const editStats: EditStatRow[] = editStatRaw.map((r) => ({ ...r }));
            const skills: SkillRow[] = skillRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const plans: PlanRow[] = planRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const commits: CommitRow[] = commitRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const asks: AskRow[] = askRaw.map((r) => ({ ...r, ts: isoOrNull(r.ts) }));
            const compactions: CompactionRow[] = compactionRaw.map((r) => ({ ts: r.ts.toISOString() }));
            const lastAssistant: LastTurnRow | null =
                lastRaw._tag === "None" ? null : { ...lastRaw.value, ts: isoOrNull(lastRaw.value.ts) };

            // Merge both correction sources, dedupe by seq (reaction_event wins - it has a target).
            const correctionBySeq = new Map<number, CorrectionRow>();
            for (const r of intentCorrectionRaw) {
                if (r.seq != null) correctionBySeq.set(r.seq, { seq: r.seq, ts: isoOrNull(r.ts), target: null, user_text: r.user_text });
            }
            for (const r of correctionRaw) {
                if (r.seq != null) correctionBySeq.set(r.seq, { ...r, ts: isoOrNull(r.ts) });
            }
            const corrections = [...correctionBySeq.values()].filter(present).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

            return buildTimeline({
                sessionId,
                source: overview?.source ?? "claude",
                health,
                overview,
                cost,
                toolCalls: toolCalls.filter(present),
                edits: edits.filter(present),
                editStats: editStats.filter(present),
                skills: skills.filter(present),
                corrections,
                plans: plans.filter(present),
                commits: commits.filter(present),
                asks: asks.filter(present),
                compactions: compactions.filter(present),
                lastAssistant,
            });
        });

        return { extract } satisfies SessionTimelineShape;
    }),
);

/** Convenience: extract a timeline using the ambient SessionTimelineService. */
export const extractSessionTimeline = (
    sessionId: string,
): Effect.Effect<SessionTimeline, never, SessionTimelineService> =>
    Effect.flatMap(SessionTimelineService, (svc) => svc.extract(sessionId));

export type { CacheReadService };
