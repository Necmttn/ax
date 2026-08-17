/**
 * ax hooks backtest - replay historical tool_call rows through a hook in-process.
 *
 * Query discipline: two flat queries + JS join (no per-row record derefs).
 * q1: tool_call rows filtered by ts/tools
 * q2: session metadata for cwd/project lookup
 */
import { Effect, Schema } from "effect";
import type { HookDefinition } from "@ax/hooks-sdk/define";
import { matches } from "@ax/hooks-sdk/define";
import type { GitEnv } from "@ax/hooks-sdk/git-env";
import { Verdict } from "@ax/hooks-sdk/verdict";
import type { Harness } from "@ax/hooks-sdk/event";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface BacktestRow {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly cwd: string;
    /**
     * Raw session.source string as stored in the DB (e.g. "claude", "codex",
     * "pi", "opencode", "cursor"). Used verbatim in BacktestSummary.providers
     * so callers see honest per-source counts. Mapped to Harness only when
     * building the synthetic HookEvent for replay (see replayRows).
     */
    readonly source: string;
    readonly project: string | null;
    readonly ts: Date;
}

export interface ReplayResult {
    readonly row: BacktestRow;
    readonly verdict: Verdict;
}

export interface BacktestSummary {
    readonly total: number;
    readonly wouldBlock: number;
    readonly wouldWarn: number;
    /** Dispatches that received a quota-aware advisory (Verdict.advise). */
    readonly wouldAdvise: number;
    /** rows dropped before replay (missing/malformed input_json). */
    readonly skippedRows: number;
    /** distinct harness sources actually seen in the replayed rows. */
    readonly providers: ReadonlyArray<string>;
    readonly byProject: Record<string, { total: number; blocked: number }>;
    readonly samples: ReadonlyArray<{ command: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Pure core: replayRows + summarize
// ---------------------------------------------------------------------------

/**
 * Replay a slice of historical tool_call rows through a hook definition.
 * Each row is turned into a synthetic PreToolUse HookEvent; `matches` gates
 * whether the hook applies; defects fail open (Allow) per the hook contract.
 */
export const replayRows = (
    def: HookDefinition,
    rows: ReadonlyArray<BacktestRow>,
): Effect.Effect<ReplayResult[], never, GitEnv> =>
    Effect.gen(function* () {
        const out: ReplayResult[] = [];
        for (const row of rows) {
            const event = {
                // Map raw source to Harness for the synthetic event; pi/opencode/
                // cursor are not harnesses that fire hooks, so they encode as "claude".
                harness: toHarness(row.source),
                event: "PreToolUse" as const,
                sessionId: null,
                cwd: row.cwd,
                tool: { name: row.name, input: row.input },
                raw: {},
            };
            const verdict: Verdict = matches(def, event)
                ? yield* def.run(event).pipe(
                      Effect.catchDefect(() =>
                          Effect.succeed(Verdict.allow),
                      ),
                  )
                : Verdict.allow;
            out.push({ row, verdict });
        }
        return out;
    });

/**
 * Aggregate replay results into a summary suitable for the CLI report or
 * --json output. First 10 Block verdicts are captured as samples.
 * `skippedRows` is the count of DB rows dropped before replay (missing or
 * malformed input_json) - surfaced so caps are never silent.
 */
export const summarize = (
    results: ReadonlyArray<ReplayResult>,
    skippedRows = 0,
): BacktestSummary => {
    const byProject: Record<string, { total: number; blocked: number }> = {};
    const samples: Array<{ command: string; reason: string }> = [];
    const sources = new Set<string>();
    let wouldBlock = 0;
    let wouldWarn = 0;
    let wouldAdvise = 0;
    for (const { row, verdict } of results) {
        sources.add(row.source);
        const key = row.project ?? "(unknown)";
        byProject[key] ??= { total: 0, blocked: 0 };
        byProject[key].total += 1;
        if (verdict._tag === "Block") {
            wouldBlock += 1;
            byProject[key].blocked += 1;
            if (samples.length < 10) {
                samples.push({
                    command: String(
                        row.input.command ?? row.input.file_path ?? "",
                    ),
                    reason: verdict.reason.split("\n")[0] ?? "",
                });
            }
        }
        if (verdict._tag === "Warn") wouldWarn += 1;
        if (verdict._tag === "Advise") wouldAdvise += 1;
    }
    return {
        total: results.length,
        wouldBlock,
        wouldWarn,
        wouldAdvise,
        skippedRows,
        providers: [...sources].sort(),
        byProject,
        samples,
    };
};

// ---------------------------------------------------------------------------
// DB fetch: two flat queries + JS join
// ---------------------------------------------------------------------------

/** Raw row returned by q1 (tool_call). The session field is a RecordId. */
interface RawToolCallRow {
    readonly name: string;
    readonly input_json: string | null | undefined;
    readonly ts: Date | null;
    readonly source: string | null;
    readonly cwd: string | null;
    readonly project: string | null;
}

const RawToolCallRowSchema = Schema.Struct({
    name: Schema.String,
    input_json: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(TimestampColumn),
    source: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    project: Schema.NullOr(Schema.String),
});

export const buildBacktestRowsQuery = (
    tools: ReadonlyArray<string>,
    providerFilter?: string | null,
): { readonly sql: string; readonly paramsAfterSince: ReadonlyArray<string> } => {
    const clauses = ["tc.ts > ?", "tc.input_json IS NOT NULL"];
    const params: string[] = [];
    if (tools.length > 0) {
        clauses.push(`tc.name IN (${tools.map(() => "?").join(", ")})`);
        params.push(...tools);
    }
    if (providerFilter) {
        clauses.push("s.source = ?");
        params.push(providerFilter);
    }
    return {
        sql: `SELECT tc.name, tc.input_json, tc.ts, s.source, s.cwd, s.project
              FROM tool_call tc
              LEFT JOIN session s ON s.id = tc.session
              WHERE ${clauses.join(" AND ")}
              ORDER BY tc.ts ASC`,
        paramsAfterSince: params,
    };
};

/** Map session.source to the Harness union. */
const toHarness = (source: string | null | undefined): Harness =>
    source === "codex" ? "codex" : "claude";

export interface FetchedRows {
    readonly rows: BacktestRow[];
    /** count of rows dropped for missing/malformed input_json. */
    readonly skipped: number;
}

/**
 * Fetch and join tool_call + session rows from the local DB.
 * Uses two flat SELECT queries; the join is done in JS.
 *
 * @param days - look-back window in days
 * @param tools - tool names to filter on (empty = all tools)
 * @param providerFilter - optional session.source filter applied in JS
 */
export const fetchRows = (
    days: number,
    tools: ReadonlyArray<string>,
    providerFilter?: string | null,
): Effect.Effect<FetchedRows, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const query = buildBacktestRowsQuery(tools, providerFilter);
        const callRows: ReadonlyArray<RawToolCallRow> = yield* cache.rows(
            RawToolCallRowSchema,
            query.sql,
            [since, ...query.paramsAfterSince],
        );

        const out: BacktestRow[] = [];
        let skipped = 0;
        for (const row of callRows) {
            // Parse input_json; count + skip rows that fail to parse.
            let input: Record<string, unknown> | null = null;
            if (typeof row.input_json === "string") {
                try {
                    const parsed = JSON.parse(row.input_json);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        input = parsed as Record<string, unknown>;
                    }
                } catch {
                    // counted below
                }
            }
            if (!input) {
                skipped += 1;
                continue;
            }

            // Store the raw session.source string so BacktestSummary.providers
            // reports honest per-source values ("pi", "opencode", etc).
            // toHarness() is called in replayRows when building the synthetic event.
            const source = row.source ?? "claude";

            const cwd =
                row.cwd ??
                row.project ??
                process.cwd();

            // ts: DuckDB decodes TIMESTAMP columns as Date objects.
            const rawTs = row.ts;
            const ts =
                rawTs instanceof Date ? rawTs : new Date();

            out.push({
                name: row.name,
                input,
                cwd,
                source,
                project: row.project,
                ts,
            });
        }
        return { rows: out, skipped };
    });

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

const pct = (n: number, total: number): string =>
    total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;

const pad = (s: string, n: number): string =>
    s.length >= n ? s : `${s}${" ".repeat(n - s.length)}`;

const clip = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}...`;

/**
 * Format a BacktestSummary into the human-readable CLI report.
 * Always includes the caveat line about state-dependent checks.
 */
export const formatReport = (
    hookName: string,
    days: number,
    summary: BacktestSummary,
): string => {
    const lines: string[] = [];
    const providerCount = summary.providers.length;
    const providerLabel = `${providerCount} provider${providerCount === 1 ? "" : "s"}`;
    lines.push(
        `backtest: ${hookName} (last ${days}d, ${providerLabel})`,
    );
    lines.push(
        `  replayed   ${summary.total.toLocaleString()} tool calls`,
    );
    lines.push(
        `  would-block   ${summary.wouldBlock.toLocaleString()} (${pct(summary.wouldBlock, summary.total)})`,
    );
    lines.push(
        `  would-warn    ${summary.wouldWarn.toLocaleString()}`,
    );
    lines.push(
        `  would-advise  ${summary.wouldAdvise.toLocaleString()}`,
    );
    if (summary.skippedRows > 0) {
        lines.push(
            `  skipped ${summary.skippedRows.toLocaleString()} rows (unparseable input)`,
        );
    }

    // Top projects sorted by total desc.
    const projects = Object.entries(summary.byProject).sort(
        (a, b) => b[1].total - a[1].total,
    );
    if (projects.length > 0) {
        lines.push("  top projects:");
        for (const [proj, stats] of projects.slice(0, 5)) {
            const label = clip(proj, 55);
            const blockStr =
                stats.blocked > 0 ? `  ${stats.blocked} blocked` : "";
            lines.push(
                `    ${pad(label, 55)} ${pad(stats.total.toLocaleString(), 8)} calls${blockStr}`,
            );
        }
    }

    if (summary.samples.length > 0) {
        lines.push("  samples:");
        for (const { command, reason } of summary.samples) {
            lines.push(`    ${pad(clip(command, 40), 42)} ${clip(reason, 60)}`);
        }
    }

    lines.push(
        "  caveat: state-dependent checks (branch, dirty) used CURRENT repo state.",
    );
    return lines.join("\n");
};
