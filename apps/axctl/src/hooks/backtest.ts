/**
 * ax hooks backtest - replay historical tool_call rows through a hook in-process.
 *
 * Query discipline: two flat queries + JS join (no per-row record derefs).
 * q1: tool_call rows filtered by ts/tools
 * q2: session metadata for cwd/project lookup
 */
import { Effect } from "effect";
import type { HookDefinition } from "@ax/hooks-sdk/define";
import { matches } from "@ax/hooks-sdk/define";
import type { GitEnv } from "@ax/hooks-sdk/git-env";
import type { Verdict } from "@ax/hooks-sdk/verdict";
import type { Harness } from "@ax/hooks-sdk/event";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface BacktestRow {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly cwd: string;
    readonly source: Harness;
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
                harness: row.source,
                event: "PreToolUse" as const,
                sessionId: null,
                cwd: row.cwd,
                tool: { name: row.name, input: row.input },
                raw: {},
            };
            const verdict: Verdict = matches(def, event)
                ? yield* def.run(event).pipe(
                      Effect.catchDefect(() =>
                          Effect.succeed({ _tag: "Allow" } as Verdict),
                      ),
                  )
                : ({ _tag: "Allow" } as Verdict);
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
    }
    return {
        total: results.length,
        wouldBlock,
        wouldWarn,
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
    readonly id: unknown;
    readonly name: string;
    readonly input_json: string | null | undefined;
    readonly ts: Date | string | null | undefined;
    readonly session: unknown; // RecordId or string
}

/** Raw row returned by q2 (session). */
interface RawSessionRow {
    readonly id: unknown; // RecordId
    readonly source: string | null | undefined;
    readonly cwd: string | null | undefined;
    readonly project: string | null | undefined;
}

// All sessions, no time window: the session table is small (tool_call is the
// big one), and a timestamp filter would drop NULL-timestamp sessions - losing
// their cwd/source and silently misclassifying codex rows as claude.
const SESSION_Q = `
SELECT id, source, cwd, project FROM session;`;

const TOOL_CALL_Q_ALL = `
SELECT id, name, input_json, ts, session FROM tool_call
WHERE ts > $since AND input_json != NONE;`;

const TOOL_CALL_Q_FILTERED = `
SELECT id, name, input_json, ts, session FROM tool_call
WHERE ts > $since AND input_json != NONE AND name IN $tools;`;

/** Stringify a RecordId-or-string to use as a map key. */
const recordKey = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
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
): Effect.Effect<FetchedRows, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // SurrealDB datetime fields require JS Date objects via the SDK.
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // q1: tool_call rows
        const sql = tools.length > 0 ? TOOL_CALL_Q_FILTERED : TOOL_CALL_Q_ALL;
        const bindings: Record<string, unknown> =
            tools.length > 0 ? { since, tools: [...tools] } : { since };
        const [callRows] = yield* db.query<[RawToolCallRow[]]>(sql, bindings);

        // q2: ALL session metadata (small table; no time filter so
        // NULL-timestamp sessions still contribute cwd/source).
        const [sessionRows] = yield* db.query<[RawSessionRow[]]>(SESSION_Q);

        // Build a session-id -> session map for the JS join.
        const sessionMap = new Map<string, RawSessionRow>();
        for (const s of sessionRows) {
            const key = recordKey(s.id);
            if (key) sessionMap.set(key, s);
        }

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

            // Join session for cwd/project/source.
            const sessKey = recordKey(row.session);
            const sess = sessKey ? sessionMap.get(sessKey) : undefined;

            const source = toHarness(sess?.source);

            // Provider filter in JS (no per-row deref needed in SurrealQL).
            if (providerFilter && sess?.source !== providerFilter) continue;

            const cwd =
                (sess?.cwd ?? null) ??
                (sess?.project ?? null) ??
                process.cwd();

            // ts: SurrealDB returns Date objects for datetime fields.
            const rawTs = row.ts;
            const ts =
                rawTs instanceof Date
                    ? rawTs
                    : typeof rawTs === "string"
                      ? new Date(rawTs)
                      : new Date();

            out.push({
                name: row.name,
                input,
                cwd,
                source,
                project: sess?.project ?? null,
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
