/**
 * `ax ingest --dry-run` - estimate how long a full backfill will take BEFORE
 * running it, so the onboarding agent (and a human) can decide and narrate.
 *
 * Two parts:
 *   1. Count pending source sessions cheaply (recursive `.jsonl` walks for the
 *      claude/codex/pi harnesses; a presence probe for the opencode/cursor
 *      sqlite stores), then subtract what's already in the graph (per-source
 *      session counts) to size the REMAINING backfill. On a fresh DB remaining
 *      equals the on-disk total, so the ETA is exact; on a watcher-seeded DB
 *      (sessions land seconds after install) nearly everything is still pending
 *      and the ETA scales to what's left instead of being skipped outright.
 *   2. Calibrate throughput on THIS machine by timing a small real slice (the
 *      sample) through the normal pipeline. Upserts are idempotent, so the
 *      sampled sessions are reused by the subsequent real run - no wasted work.
 *
 * The pure ETA math (`computeEstimate`, `formatDuration`) is separated from the
 * effectful counting/sampling so it can be unit-tested without a DB or disk.
 */
import { Effect, FileSystem, Option, Path, PlatformError } from "effect";
import { AxConfig } from "@ax/lib/config";
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { ingestTranscripts } from "./transcripts.ts";
import { ingestCodex } from "./codex.ts";

/** Wall-clock budget for the calibration sample. Keeps the dry-run snappy even
 *  when individual transcripts are large (one fat session can take seconds). */
export const DEFAULT_SAMPLE_BUDGET_MS = 8_000;
/** Hard backstop on files sampled, so a corpus of tiny files doesn't run the
 *  whole budget for no extra signal. */
export const DEFAULT_SAMPLE_CAP = 60;
/** Below this many sampled items the ETA is flagged "rough" - a small sample is
 *  noisy, especially when transcript sizes vary widely. */
export const ROUGH_SAMPLE_THRESHOLD = 10;
/** At or below this many remaining sessions the graph counts as caught up: the
 *  next run is incremental and quick, so sampling for an ETA is pointless. The
 *  slack (vs. exactly 0) absorbs file↔session count noise - a transcript that
 *  parses to no session, or a watcher mid-write - without losing the ETA for
 *  any real backfill. */
export const UP_TO_DATE_THRESHOLD = 5;
/** When the timed sample yields no usable rate (its slice was dominated by
 *  already-ingested, watermark-skipped files - the near-complete case), a
 *  remaining backlog at or below this many sessions is framed as a quick run
 *  rather than left without any estimate (issue #478). A larger backlog stays
 *  honest ("couldn't time a sample") - we never fabricate an ETA from a guessed
 *  rate, which is the dishonesty the no-estimate path exists to avoid. */
export const QUICK_BACKFILL_THRESHOLD = 50;

export interface SourceCounts {
    /** claude `.jsonl` transcript files (~one per session). */
    readonly claude: number;
    /** codex `.jsonl` session files. */
    readonly codex: number;
    /** pi `.jsonl` session files. */
    readonly pi: number;
    /** opencode sqlite store present (sessions counted at run time). */
    readonly opencodeStore: boolean;
    /** cursor user dir present (conversations counted at run time). */
    readonly cursorStore: boolean;
    /** claude + codex + pi - the jsonl harnesses that drive the ETA. */
    readonly sessionsTotal: number;
}

/** Per-source session tallies for the jsonl harnesses that drive the ETA. */
export interface SessionTally {
    readonly claude: number;
    readonly codex: number;
    readonly pi: number;
    readonly total: number;
}

export interface DryRunResult {
    readonly sources: SourceCounts;
    /** sessions already in the graph, per source (opencode/cursor excluded -
     *  their on-disk counts aren't known either, so they never drive the ETA). */
    readonly inGraph: SessionTally;
    /** pending backfill work: max(0, onDisk - inGraph) per source. The ETA is
     *  projected over `remaining.total`, not the full on-disk total, so a
     *  watcher-seeded graph (a handful of sessions ingested seconds after
     *  install) still gets a useful first-backfill estimate. */
    readonly remaining: SessionTally;
    readonly sampled: { readonly items: number; readonly seconds: number };
    /** sessions/sec measured from the sample, or null when nothing was sampled
     *  (e.g. the graph is caught up so the slice was skipped). */
    readonly ratePerSec: number | null;
    /** projected seconds for the REMAINING backfill, or null when no rate could
     *  be measured (or nothing remains). */
    readonly etaSeconds: number | null;
    /** true when the sample was small (time-boxed early), so the ETA is noisy. */
    readonly rough: boolean;
    /** true when the graph already has sessions. Kept for backward compat; no
     *  longer suppresses the ETA on its own - only `remaining ≈ 0` does. */
    readonly populated: boolean;
    /** true when remaining ≈ 0 (≤ UP_TO_DATE_THRESHOLD): the next run is
     *  incremental, so no ETA is sampled. */
    readonly upToDate: boolean;
}

/** Pure remaining-work math: pending = max(0, onDisk - inGraph) per source.
 *  On-disk counts are file counts (~one session per jsonl), so per-source
 *  clamping keeps one over-counted source from masking another's backlog. */
export function computeRemaining(sources: SourceCounts, inGraph: SessionTally): SessionTally {
    const claude = Math.max(0, sources.claude - inGraph.claude);
    const codex = Math.max(0, sources.codex - inGraph.codex);
    const pi = Math.max(0, sources.pi - inGraph.pi);
    return { claude, codex, pi, total: claude + codex + pi };
}

/** Pure ETA math. Returns null rate/eta when the sample measured nothing
 *  usable (too few items, or a sub-millisecond elapsed that would yield an
 *  absurd rate). */
export function computeEstimate(
    sessionsTotal: number,
    sampledItems: number,
    sampledSeconds: number,
): { ratePerSec: number | null; etaSeconds: number | null } {
    if (sampledItems < 1 || sampledSeconds <= 0.01) {
        return { ratePerSec: null, etaSeconds: null };
    }
    const ratePerSec = sampledItems / sampledSeconds;
    const etaSeconds = sessionsTotal / ratePerSec;
    return { ratePerSec, etaSeconds: Math.round(etaSeconds) };
}

/** Human-friendly duration: "3m30s", "45s", "1h02m". */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return `${m}m${rem.toString().padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

/** Recursively count `.jsonl` files under `dir` whose mtime passes the cutoff.
 *  Stat-only - never opens a file. Missing/unreadable dirs count as 0. */
const countJsonl = (
    dir: string,
    cutoffMs: number,
): Effect.Effect<number, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return 0;
        const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
        let count = 0;
        for (const name of entries) {
            const full = path.join(dir, name);
            const info = yield* fs.stat(full).pipe(Effect.option);
            if (Option.isNone(info)) continue;
            const st = info.value;
            if (st.type === "Directory") {
                count += yield* countJsonl(full, cutoffMs);
            } else if (name.endsWith(".jsonl")) {
                const mtime = Option.getOrElse(st.mtime, () => new Date(0)).getTime();
                if (cutoffMs <= 0 || mtime >= cutoffMs) count += 1;
            }
        }
        return count;
    });

const EMPTY_TALLY: SessionTally = { claude: 0, codex: 0, pi: 0, total: 0 };

/** Per-source session counts already in the graph. One cheap aggregate (no
 *  derefs), so it stays fast even on a large graph. Compared against the
 *  on-disk counts to size the REMAINING backfill - a binary "has any session?"
 *  probe is useless in practice because the watcher LaunchAgent seeds sessions
 *  within seconds of install. */
const dbSessionCounts = (): Effect.Effect<SessionTally, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = (yield* db.query<[Array<{ source?: string; n?: number }>]>(
            "SELECT source, count() AS n FROM session GROUP BY source;",
        ))?.[0] ?? [];
        let claude = 0;
        let codex = 0;
        let pi = 0;
        for (const row of rows) {
            const n = typeof row.n === "number" ? row.n : 0;
            // `claude-subagent` sessions are derived from separate
            // `<sessionId>/subagents/agent-*.jsonl` files that the recursive
            // on-disk walk also counts, so they fold into the claude tally to
            // keep the comparison apples-to-apples.
            if (row.source === "claude" || row.source === "claude-subagent") claude += n;
            else if (row.source === "codex") codex += n;
            else if (row.source === "pi") pi += n;
            // opencode/cursor (and unknown sources) are ignored: their on-disk
            // session counts aren't known either, so they never drive the ETA.
        }
        return { claude, codex, pi, total: claude + codex + pi };
    }).pipe(
        // A missing `session` table (schema not applied yet) or any query failure
        // means we can't size the graph - treat as empty (first run) rather
        // than crashing the dry-run.
        Effect.orElseSucceed(() => EMPTY_TALLY),
    );

const pathExists = (p: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    });

export interface EstimateOptions {
    readonly sinceDays?: number | undefined;
    /** Wall-clock budget for the calibration sample (ms). */
    readonly sampleBudgetMs?: number | undefined;
    /** Hard file-count backstop for the sample. */
    readonly sampleCap?: number | undefined;
    /** Injectable clock (ms) for deterministic tests. */
    readonly now?: (() => number) | undefined;
}

/** Count sources, then time a small real slice to project the full ETA. */
export const estimateIngest = (
    opts: EstimateOptions = {},
): Effect.Effect<
    DryRunResult,
    DbError | PlatformError.PlatformError,
    AxConfig | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const path = yield* Path.Path;
        const now = opts.now ?? (() => Date.now());
        const cap = opts.sampleCap ?? DEFAULT_SAMPLE_CAP;
        const budgetMs = opts.sampleBudgetMs ?? DEFAULT_SAMPLE_BUDGET_MS;
        const cutoff = opts.sinceDays ? now() - opts.sinceDays * 86400 * 1000 : 0;

        const claude = yield* countJsonl(cfg.paths.transcriptsDir, cutoff);
        const codex = yield* countJsonl(cfg.paths.codexDir, cutoff);
        const pi = yield* countJsonl(cfg.paths.piDir, cutoff);
        const opencodeStore = yield* pathExists(path.join(cfg.paths.opencodeDir, "opencode.db"));
        const cursorStore = yield* pathExists(cfg.paths.cursorUserDir);
        const sessionsTotal = claude + codex + pi;
        const sources: SourceCounts = { claude, codex, pi, opencodeStore, cursorStore, sessionsTotal };

        // Size the remaining backfill: on-disk minus already-in-graph, per
        // source. An empty graph means remaining == total (first run, exact
        // ETA); a watcher-seeded graph still has nearly everything pending, so
        // it gets a remaining-scaled ETA instead of a blanket "populated" skip.
        const inGraph = yield* dbSessionCounts();
        const populated = inGraph.total > 0;
        const remaining = computeRemaining(sources, inGraph);

        // Caught up (remaining ≈ 0): the watermark skips already-ingested
        // files, so the next run is incremental and quick. Sampling would only
        // re-touch unchanged files - skip calibration and say so.
        if (populated && remaining.total <= UP_TO_DATE_THRESHOLD) {
            return {
                sources,
                inGraph,
                remaining,
                sampled: { items: 0, seconds: 0 },
                ratePerSec: null,
                etaSeconds: null,
                rough: false,
                populated,
                upToDate: true,
            };
        }

        // Real work remains. Calibrate on whichever jsonl harness has the most
        // pending sessions (the watermark skips already-ingested files inside
        // the sample, so only genuinely-pending sessions count toward the rate).
        // Time-boxed: process real files until the budget elapses (or the cap
        // is hit), then extrapolate over the REMAINING total.
        const useCodex = remaining.codex > remaining.claude;
        const t0 = now();
        const deadlineMs = t0 + budgetMs;
        const items = useCodex
            ? (yield* ingestCodex({ sinceDays: opts.sinceDays, limit: cap, deadlineMs })).sessions
            : (yield* ingestTranscripts({ sinceDays: opts.sinceDays, limit: cap, deadlineMs })).sessions;
        const seconds = (now() - t0) / 1000;

        const { ratePerSec, etaSeconds } = computeEstimate(remaining.total, items, seconds);
        const rough = ratePerSec !== null && items < ROUGH_SAMPLE_THRESHOLD;
        return { sources, inGraph, remaining, sampled: { items, seconds }, ratePerSec, etaSeconds, rough, populated, upToDate: false };
    });

/** Render the dry-run result for humans (Paxel-style) or as JSON for the agent. */
export function formatDryRun(result: DryRunResult, json: boolean): string {
    if (json) {
        return JSON.stringify(
            {
                sources: result.sources,
                inGraph: result.inGraph,
                remaining: result.remaining,
                sampled: result.sampled,
                ratePerSec: result.ratePerSec,
                etaSeconds: result.etaSeconds,
                rough: result.rough,
                populated: result.populated,
                upToDate: result.upToDate,
            },
            null,
            2,
        );
    }
    const { sources: s, remaining } = result;
    const lines: string[] = ["ax ingest --dry-run", "  counting sources..."];
    if (s.claude > 0) lines.push(`    claude   ${s.claude.toLocaleString()} sessions`);
    if (s.codex > 0) lines.push(`    codex    ${s.codex.toLocaleString()} sessions`);
    if (s.pi > 0) lines.push(`    pi       ${s.pi.toLocaleString()} sessions`);
    if (s.opencodeStore) lines.push("    opencode store present (counted at run time)");
    if (s.cursorStore) lines.push("    cursor store present (counted at run time)");

    if (s.sessionsTotal === 0 && !s.opencodeStore && !s.cursorStore) {
        lines.push("  nothing to ingest yet.");
        return lines.join("\n");
    }

    if (result.upToDate) {
        // remaining ≈ 0: runs are incremental (the watermark skips
        // already-ingested files), so there is no backfill to estimate.
        lines.push(
            `  graph is up to date (${result.inGraph.total.toLocaleString()} sessions) - the next run is incremental (only new/changed files), so it'll be quick.`,
        );
        lines.push("  run it: ax ingest");
        return lines.join("\n");
    }

    if (result.populated) {
        // Partially-populated graph (e.g. watcher-seeded right after install):
        // show how much of the backfill is actually left.
        lines.push(`  in graph: ${result.inGraph.total.toLocaleString()} sessions - ~${remaining.total.toLocaleString()} remaining (${formatRemainingParts(remaining)})`);
    }

    if (result.ratePerSec === null) {
        // Work remains but the timed sample measured nothing usable - typically
        // because the slice was dominated by already-ingested (watermark-skipped)
        // files, i.e. the graph is nearly caught up. Rather than dead-end with
        // "couldn't measure a rate" (issue #478, reported when 10 sessions
        // remained), say something useful from the known remaining count.
        const rem = remaining.total;
        // On a populated graph the "in graph: N - ~M remaining" line above already
        // states the count, so don't repeat it here.
        const prefix = result.populated ? "  " : `  ~${rem.toLocaleString()} sessions remaining - `;
        if (rem <= QUICK_BACKFILL_THRESHOLD) {
            lines.push(`${prefix}a quick run (typically well under a minute on this machine).`);
        } else {
            // Larger backlog the sample couldn't time: stay honest - no fabricated
            // ETA. Point at the live view instead of guessing a duration.
            lines.push(`${prefix}couldn't time a sample on this machine; run it and watch live in ax serve → http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`);
        }
        lines.push("  run it: ax ingest");
        return lines.join("\n");
    }

    lines.push(
        `  calibrating... sampled ${result.sampled.items} in ${result.sampled.seconds.toFixed(1)}s (${result.ratePerSec.toFixed(1)}/s)`,
    );
    const eta = result.etaSeconds === null ? "unknown" : `~${formatDuration(result.etaSeconds)}`;
    const roughTag = result.rough ? " (rough)" : "";
    // ETA is projected over the remaining backfill. On a fresh graph that IS
    // the full total; on a partially-populated one it's labelled accordingly.
    const label = result.populated ? "remaining" : "total";
    lines.push(`  ${label}: ${remaining.total.toLocaleString()} sessions   ETA ${eta}${roughTag} on this machine`);
    lines.push(`  run it: ax ingest   (watch live in ax serve → http://127.0.0.1:${DEFAULT_DASHBOARD_PORT})`);
    return lines.join("\n");
}

/** "3,800 claude, 14 codex" - zero-count sources omitted. */
function formatRemainingParts(remaining: SessionTally): string {
    const parts: string[] = [];
    if (remaining.claude > 0) parts.push(`${remaining.claude.toLocaleString()} claude`);
    if (remaining.codex > 0) parts.push(`${remaining.codex.toLocaleString()} codex`);
    if (remaining.pi > 0) parts.push(`${remaining.pi.toLocaleString()} pi`);
    return parts.length > 0 ? parts.join(", ") : "none pending";
}
