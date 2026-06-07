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
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { ingestTranscripts } from "./transcripts.ts";
import { ingestCodex } from "./codex.ts";

/** How many sessions to push through the pipeline to measure throughput. */
export const DEFAULT_SAMPLE_SIZE = 30;

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

const pathExists = (p: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    });

export interface EstimateOptions {
    readonly sinceDays?: number | undefined;
    readonly sampleSize?: number | undefined;
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
        const sample = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
        const cutoff = opts.sinceDays ? now() - opts.sinceDays * 86400 * 1000 : 0;

        const claude = yield* countJsonl(cfg.paths.transcriptsDir, cutoff);
        const codex = yield* countJsonl(cfg.paths.codexDir, cutoff);
        const pi = yield* countJsonl(cfg.paths.piDir, cutoff);
        const opencodeStore = yield* pathExists(path.join(cfg.paths.opencodeDir, "opencode.db"));
        const cursorStore = yield* pathExists(cfg.paths.cursorUserDir);
        const sessionsTotal = claude + codex + pi;
        const sources: SourceCounts = { claude, codex, pi, opencodeStore, cursorStore, sessionsTotal };

        // Calibrate on whichever jsonl harness has the most pending work, so the
        // measured rate is representative.
        const useCodex = codex > claude;
        const t0 = now();
        const items = useCodex
            ? (yield* ingestCodex({ sinceDays: opts.sinceDays, limit: sample })).sessions
            : (yield* ingestTranscripts({ sinceDays: opts.sinceDays, limit: sample })).sessions;
        const seconds = (now() - t0) / 1000;

        const { ratePerSec, etaSeconds } = computeEstimate(sessionsTotal, items, seconds);
        return { sources, sampled: { items, seconds }, ratePerSec, etaSeconds };
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

    if (result.ratePerSec === null) {
        // Nothing measurable - usually the graph is already populated, so the
        // sample slice was skipped by the watermark.
        lines.push("  graph already has data - a fresh run will be quick (only new files).");
        lines.push("  run it: ax ingest");
        return lines.join("\n");
    }

    lines.push(
        `  calibrating... sampled ${result.sampled.items} in ${result.sampled.seconds.toFixed(1)}s (${result.ratePerSec.toFixed(1)}/s)`,
    );
    const eta = result.etaSeconds === null ? "unknown" : `~${formatDuration(result.etaSeconds)}`;
    lines.push(`  total: ${s.sessionsTotal.toLocaleString()} sessions   ETA ${eta} on this machine`);
    lines.push("  run it: ax ingest   (watch live in ax serve → http://127.0.0.1:8520)");
    return lines.join("\n");
}
