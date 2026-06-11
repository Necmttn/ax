/**
 * `ax ingest --dry-run` - estimate how long a full backfill will take BEFORE
 * running it, so the onboarding agent (and a human) can decide and narrate.
 *
 * Two parts:
 *   1. Count pending source sessions cheaply (recursive `.jsonl` walks for the
 *      claude/codex/pi harnesses; a presence probe for the opencode/cursor
 *      sqlite stores). On a fresh DB - the case that matters most, the first
 *      run - every file is pending, so the raw count is exact. On a populated
 *      DB it is an upper bound (the watermark skips unchanged files at run time).
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

export interface DryRunResult {
    readonly sources: SourceCounts;
    readonly sampled: { readonly items: number; readonly seconds: number };
    /** sessions/sec measured from the sample, or null when nothing was sampled
     *  (e.g. the graph is already populated so the slice was skipped). */
    readonly ratePerSec: number | null;
    /** projected full-backfill seconds, or null when no rate could be measured. */
    readonly etaSeconds: number | null;
    /** true when the sample was small (time-boxed early), so the ETA is noisy. */
    readonly rough: boolean;
    /** true when the graph already has sessions. A full-total ETA would be
     *  misleading (the watermark skips already-ingested files), so we report the
     *  run as incremental instead. */
    readonly populated: boolean;
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

/** Cheap "is the graph already populated?" probe. One existence check, not a
 *  full count. Drives the ETA branch: an empty graph means every on-disk file is
 *  pending (so total == pending and the ETA is exact); a populated graph means
 *  the watermark will skip most files, so extrapolating over the full total would
 *  wildly over-estimate - we report incremental instead. */
const dbHasSessions = (): Effect.Effect<boolean, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = (yield* db.query<[Array<{ id: unknown }>]>("SELECT id FROM session LIMIT 1;"))?.[0] ?? [];
        return rows.length > 0;
    }).pipe(
        // A missing `session` table (schema not applied yet) or any query failure
        // means we can't confirm population - treat as empty (first run) rather
        // than crashing the dry-run.
        Effect.orElseSucceed(() => false),
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

        // On a populated graph the watermark skips already-ingested files, so a
        // full-total ETA is meaningless (and sampling would only re-touch a
        // handful of new files). Report incremental and skip calibration.
        const populated = yield* dbHasSessions();
        if (populated) {
            return { sources, sampled: { items: 0, seconds: 0 }, ratePerSec: null, etaSeconds: null, rough: false, populated };
        }

        // First run: every on-disk file is pending, so total == pending and the
        // ETA is exact. Calibrate on whichever jsonl harness has the most work.
        // Time-boxed: process real files until the budget elapses (or the cap is
        // hit), then extrapolate.
        const useCodex = codex > claude;
        const t0 = now();
        const deadlineMs = t0 + budgetMs;
        const items = useCodex
            ? (yield* ingestCodex({ sinceDays: opts.sinceDays, limit: cap, deadlineMs })).sessions
            : (yield* ingestTranscripts({ sinceDays: opts.sinceDays, limit: cap, deadlineMs })).sessions;
        const seconds = (now() - t0) / 1000;

        const { ratePerSec, etaSeconds } = computeEstimate(sessionsTotal, items, seconds);
        const rough = ratePerSec !== null && items < ROUGH_SAMPLE_THRESHOLD;
        return { sources, sampled: { items, seconds }, ratePerSec, etaSeconds, rough, populated };
    });

/** Render the dry-run result for humans (Paxel-style) or as JSON for the agent. */
export function formatDryRun(result: DryRunResult, json: boolean): string {
    if (json) {
        return JSON.stringify(
            {
                sources: result.sources,
                sampled: result.sampled,
                ratePerSec: result.ratePerSec,
                etaSeconds: result.etaSeconds,
                rough: result.rough,
                populated: result.populated,
            },
            null,
            2,
        );
    }
    const { sources: s } = result;
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

    if (result.populated) {
        // Graph already has sessions: runs are incremental (the watermark skips
        // already-ingested files), so a full-total ETA would be meaningless.
        lines.push("  graph already populated - the next run is incremental (only new/changed files), so it'll be quick.");
        lines.push("  run it: ax ingest");
        return lines.join("\n");
    }

    if (result.ratePerSec === null) {
        // Empty graph but the sample measured nothing usable (e.g. all candidate
        // files were too short to produce a session). Can't project a rate.
        lines.push("  couldn't measure a rate from the sample; just run it:");
        lines.push("  run it: ax ingest");
        return lines.join("\n");
    }

    lines.push(
        `  calibrating... sampled ${result.sampled.items} in ${result.sampled.seconds.toFixed(1)}s (${result.ratePerSec.toFixed(1)}/s)`,
    );
    const eta = result.etaSeconds === null ? "unknown" : `~${formatDuration(result.etaSeconds)}`;
    const roughTag = result.rough ? " (rough)" : "";
    lines.push(`  total: ${s.sessionsTotal.toLocaleString()} sessions   ETA ${eta}${roughTag} on this machine`);
    lines.push(`  run it: ax ingest   (watch live in ax serve → http://127.0.0.1:${DEFAULT_DASHBOARD_PORT})`);
    return lines.join("\n");
}
