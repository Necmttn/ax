import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { Effect, FileSystem, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { posixPath } from "@ax/lib/shared/path";
import { buildOnboardingReport, formatInstallOnboardingGuidance } from "./onboarding.ts";
import { agentEventIndexDoctorCheck, readIndexUnhealthyMarker } from "../ingest/agent-event-index-heal.ts";
import { applyClaudeOtelEnv, applyCodexOtelToml, detectClaudeOtelReplacements, type OtelEnvReplacement } from "../otel/install-config.ts";
import { resolveForwardTargets, buildForwardConfig, asForwardConfig, type OtelForwardTarget } from "../otel/forward-config.ts";
import { defaultForwardConfigPath } from "../otel/spool-server.ts";
import { DEFAULT_INGEST_TIMEOUT_SECONDS } from "@ax/lib/config";
import { provisionRetroReviewerAgent } from "./managed-agents.ts";
import {
    formatStaleIngestWarning,
    isStrandedRun,
    REAP_GRACE_SECONDS,
    type IngestRunHeartbeatRow,
} from "@ax/lib/shared/ingest-staleness";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { fetchLastSuccessfulIngestAt, staleIngestThresholdMs } from "../queries/ingest-staleness.ts";

/**
 * Tagged failure for install steps (symlinking). Extends `Error`, so existing
 * `Error`-typed failure channels and `.message` readers keep working
 * unchanged.
 */
export class InstallStepError extends Schema.TaggedErrorClass<InstallStepError>(
    "InstallStepError",
)("InstallStepError", {
    message: Schema.String,
}) {}

const HOME = homedir();
const DATA_DIR = process.env.AX_DATA_DIR ?? posixPath.join(HOME, ".local", "share", "ax");
const LOG_DIR = posixPath.join(DATA_DIR, "logs");
// Blob storage for raw transcript/codex-artifact snapshots (packages/lib/src
// blob-gc.ts). Plain directories on disk, not a database-managed bucket
// abstraction - ingest writes into them directly under the DuckDB engine.
const BUCKETS_DIR = posixPath.join(DATA_DIR, "buckets");
const LAUNCH_AGENTS_DIR = posixPath.join(HOME, "Library", "LaunchAgents");
const BIN_DIR = posixPath.join(HOME, ".local", "bin");

// otlpd is the one LaunchAgent that survives daemon subtraction (shipped in
// wave 0; `ax otlpd` -> otel/spool-server.ts). Everything else - ax-db,
// ax-watch, ax-derive-daily, ax-quota-refresh, ax-serve - is gone: embedded
// DuckDB needs no daemon to hold it open, and ephemeral `ax studio`
// (wave 3's c-daemon-studio) runs only while a client is attached.
const OTLPD_LABEL = "com.necmttn.ax-otlpd";
const OTLPD_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${OTLPD_LABEL}.plist`);

// The otlpd spool dir is decoupled from AX_DATA_DIR (see spool-server.ts
// defaultOtlpSpoolDir) - forward AX_OTLP_SPOOL_DIR into the LaunchAgent's env
// when the installer's own env carries an override, not AX_DATA_DIR.
const otlpdSpoolDirEnv = (): string => process.env.AX_OTLP_SPOOL_DIR
    ? `
    <key>AX_OTLP_SPOOL_DIR</key>
    <string>${process.env.AX_OTLP_SPOOL_DIR}</string>`
    : "";

export const otlpdPlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${OTLPD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "${binPath}" otlpd</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/otlpd.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/otlpd.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>${otlpdSpoolDirEnv()}
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;

/**
 * Tri-state telemetry consent, resolved from the `--telemetry`/`--no-telemetry`
 * flags:
 *   - "grant"    - explicit `--telemetry`: install + start collecting.
 *   - "revoke"   - explicit `--no-telemetry`: unload the receiver.
 *   - "preserve" - neither flag passed (plain `ax install`): touch nothing -
 *     whatever consent state already exists on disk stays exactly as it is.
 *     A bare re-run of `ax install` must never silently revoke a prior
 *     `--telemetry` consent (issue: `resolveTelemetryConsent` used to
 *     collapse to a boolean, so no flags looked identical to `--no-telemetry`
 *     and unloaded an already-consented otlpd agent).
 */
export type TelemetryConsent = "grant" | "revoke" | "preserve";

/** Pure predicate: a conflict message when both flags are set, else null. */
export const telemetryConsentConflict = (
    telemetry: boolean,
    noTelemetry: boolean,
): string | null =>
    telemetry && noTelemetry
        ? "axctl install: --telemetry and --no-telemetry cannot be used together"
        : null;

/** Resolves the tri-state consent. Assumes `telemetryConsentConflict` has
 *  already been checked (returns null) - the caller raises the usage error. */
export const resolveTelemetryConsent = (
    telemetry: boolean,
    noTelemetry: boolean,
): TelemetryConsent => {
    if (telemetry) return "grant";
    if (noTelemetry) return "revoke";
    return "preserve";
};

export type OtlpdPlistDecision =
    | { readonly action: "write-and-load" }
    | { readonly action: "unload" }
    | { readonly action: "noop" };

/**
 * Decide what `cmdInstall` should do to the otlpd LaunchAgent plist, given
 * the resolved tri-state consent:
 *   - "preserve" ALWAYS no-ops - the plist is neither written nor unloaded,
 *     regardless of whatever is already on disk (loaded-by-prior-consent, or
 *     never-consented). That's what "preserve existing state" means.
 *   - "revoke" always unloads.
 *   - "grant" always writes the plist AND bootstraps/loads it - `ax otlpd`
 *     is the only LaunchAgent ax installs, so nothing else contends for the
 *     OTLP port.
 */
export const resolveOtlpdPlistDecision = (
    consent: TelemetryConsent,
): OtlpdPlistDecision => {
    if (consent === "revoke") return { action: "unload" };
    if (consent === "preserve") return { action: "noop" };
    return { action: "write-and-load" };
};

function which(cmd: string): string | null {
    const r = spawnSync("which", [cmd], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

function ensureDirs(): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(DATA_DIR, { recursive: true });
        yield* fs.makeDirectory(LOG_DIR, { recursive: true });
        yield* fs.makeDirectory(path.join(BUCKETS_DIR, "transcripts"), { recursive: true });
        yield* fs.makeDirectory(path.join(BUCKETS_DIR, "codex_artifacts"), { recursive: true });
        yield* fs.makeDirectory(LAUNCH_AGENTS_DIR, { recursive: true });
        yield* fs.makeDirectory(BIN_DIR, { recursive: true });
    });
}

async function loadAgent(plistPath: string) {
    try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
        // ok
    }
    execSync(`launchctl load -w "${plistPath}"`, { stdio: "inherit" });
}

async function unloadAgentKeepPlist(plistPath: string): Promise<void> {
    try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
        // ok
    }
}

/** Unload + delete a LaunchAgent plist. Returns true when the file existed and was removed. */
function unloadAgent(plistPath: string): Effect.Effect<boolean, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.promise(() => unloadAgentKeepPlist(plistPath));
        if (!(yield* fs.exists(plistPath).pipe(orAbsent(false)))) return false;
        // Original swallowed any unlink error and returned false; `remove`
        // (no force) succeeds on a present file, else recovers to false.
        return yield* fs.remove(plistPath).pipe(
            Effect.as(true),
            orAbsent(false),
        );
    });
}

/**
 * Ensure `link` is a symbolic link pointing at `target`. @effect/platform has
 * no `lstat`, so the old `lstat(link).isSymbolicLink()` partition is rebuilt on
 * the shared {@link classifyNoFollow} (readLink->Effect.as(true)->orAbsent(false),
 * so ANY readLink failure incl. EINVAL on a regular file is treated as
 * not-a-symlink, then `fs.stat` distinguishes File/Directory/Missing). This
 * matches the original lstat partition EXACTLY:
 *
 *   old: lstat ENOENT (absent)      -> symlink(target, link)   [create]
 *   old: lstat ok && isSymbolicLink -> unlink(link); symlink   [replace]
 *   old: lstat ok && NOT symlink    -> throw "exists and is not a symlink"
 *
 *   new: "Missing"                  -> symlink(target, link)   [create]
 *        "SymbolicLink"             -> repoint via readLink compare: recreate
 *                                      only when the target differs, no-op when
 *                                      it already matches (same end-state as the
 *                                      old unconditional unlink+recreate).
 *        "File"/"Directory"/"Other" -> throw the same "exists and is not a
 *                                      symlink" hard error (a regular file in
 *                                      the slot is preserved, not clobbered).
 */
export function ensureSymlink(
    target: string,
    link: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const kind = yield* classifyNoFollow(link);

        if (kind === "SymbolicLink") {
            const current = yield* fs.readLink(link);
            if (current === target) return; // already correct
            yield* fs.remove(link, { force: true });
            yield* fs.symlink(target, link);
            return;
        }

        if (kind === "Missing") {
            yield* fs.symlink(target, link);
            return;
        }

        // "File"/"Directory"/"Other": something that is NOT a symlink occupies
        // the slot. Preserve the old hard error (and leave the file intact).
        return yield* new InstallStepError({ message: `${link} exists and is not a symlink` });
    });
}

function resolveBinaryPath(): string {
    // When compiled with bun build --compile, process.execPath points at the binary.
    // When run via bun src/cli/index.ts, process.execPath is the bun binary; use argv[1] instead.
    const arg = process.argv[1] ?? "";
    if (arg.endsWith(".ts")) {
        // Dev mode: point at the bin wrapper
        return posixPath.join(import.meta.dir, "..", "..", "bin", "axctl");
    }
    return process.execPath;
}

export interface DoctorCheck {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface DoctorReport {
    readonly platform: NodeJS.Platform;
    readonly checks: readonly DoctorCheck[];
}

function isMacos(): boolean {
    return process.platform === "darwin";
}

/** launchctl status for one LaunchAgent. otlpd is the only one left. */
export interface AgentRuntimeStatus {
    readonly label: string;
    readonly plist: string;
    readonly plistExists: boolean;
    readonly loaded: boolean;
    readonly pid: number | null;
}

function launchdStatus(
    label: string,
    plist: string,
): Effect.Effect<AgentRuntimeStatus, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const plistExists = yield* fs.exists(plist).pipe(orAbsent(false));
        if (!isMacos()) {
            return { label, plist, plistExists, loaded: false, pid: null };
        }
        const r = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
        const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        const pidMatch = output.match(/"PID"\s*=\s*(\d+);/);
        return {
            label,
            plist,
            plistExists,
            loaded: r.status === 0,
            pid: pidMatch ? Number(pidMatch[1]) : null,
        };
    });
}

/**
 * Doctor check for the otlpd LaunchAgent. Consent-gated telemetry, so
 * "plist absent" (never consented) and "plist present, not loaded" (consent
 * written but not yet started) are both normal - never a failure. Purely
 * informational, like the platform check above it. Pure + exported for tests.
 */
export function otlpdDoctorCheck(agent: AgentRuntimeStatus): DoctorCheck {
    return {
        name: "otlpd",
        ok: true,
        detail: !agent.plistExists
            ? "not installed (telemetry consent not granted; 'ax install --telemetry' opts in)"
            : agent.loaded
                ? `loaded${agent.pid === null ? "" : ` pid=${agent.pid}`}`
                : "plist present, not loaded",
    };
}

/**
 * Doctor check that surfaces an OTLP redirect (#1014). Before this, ax rewrote
 * the harness's OTLP logs endpoint at install and NOTHING - not the install
 * output, not doctor - said so; a user found it nine days later by diffing
 * settings.json. The redirect is legitimate (ax needs the harness pointed at
 * its receiver), so this is informational (ok:true), never a failure - but when
 * a `~/.ax/otel-previous.json` backup exists it names the takeover and the
 * restore path. Pure + exported for tests.
 */
export function otelRedirectDoctorCheck(args: {
    readonly backupExists: boolean;
    readonly backupPath: string;
    readonly logsEndpoint: string | null;
    /** Forwarding signals from `~/.ax/otel-forward.json` (#1017), empty if off. */
    readonly forwardingSignals?: readonly string[];
}): DoctorCheck {
    const forwarding = args.forwardingSignals ?? [];
    if (forwarding.length > 0) {
        return {
            name: "otel",
            ok: true,
            detail: `ax receives + FORWARDS ${forwarding.join(", ")} to your own collector (--otel-forward); ax OTLP surfaces stay active`,
        };
    }
    if (args.backupExists) {
        return {
            name: "otel",
            ok: true,
            detail: `ax redirected an existing OTLP destination to its receiver; original saved at ${args.backupPath} - restore, or re-run with --otel-forward to relay to it`,
        };
    }
    return {
        name: "otel",
        ok: true,
        detail: args.logsEndpoint
            ? `OTLP logs → ${args.logsEndpoint} (no external redirect recorded)`
            : "no OTLP logs endpoint configured",
    };
}

/**
 * Ingest wall-clock budget (seconds). Doctor has no AxConfig layer, so mirror
 * the `AX_INGEST_TIMEOUT_SECONDS` knob with the same lenient
 * parse-or-fallback the config layer uses.
 */
function ingestTimeoutSecondsFromEnv(): number {
    const parsed = Number.parseInt(process.env.AX_INGEST_TIMEOUT_SECONDS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_TIMEOUT_SECONDS;
}

/**
 * Rows whose newest heartbeat is older than `staleAfterMs` - crash residue that
 * never finalized (issue #269). Thin filter over the shared
 * {@link isStrandedRun} rule so doctor and the reapers can't drift. Exported
 * for tests.
 */
export function staleRunningIngestRuns(
    rows: readonly IngestRunHeartbeatRow[],
    nowMs: number,
    staleAfterMs: number,
): IngestRunHeartbeatRow[] {
    return rows.filter((row) => isStrandedRun(row, nowMs, staleAfterMs));
}

const StaleIngestRunRow = Schema.Struct({
    id: Schema.String,
    command: Schema.String,
    started_at: TimestampColumn,
    last_progress_at: Schema.NullOr(TimestampColumn),
});

/**
 * "ingest-runs" doctor check, read straight off the published DuckDB
 * snapshot. ALWAYS returns a check (never omits it): a report that silently
 * drops a check on cache-unavailable is exactly the "stops evaluating and
 * prints nothing" failure mode doctor exists to avoid.
 */
function collectIngestRunsDoctorCheck(
    staleAfterMs: number,
    ingestTimeoutSeconds: number,
): Effect.Effect<DoctorCheck, never, CacheRead> {
    return Effect.gen(function* () {
        const cache = yield* CacheRead;
        const rows = yield* cache.rows(
            StaleIngestRunRow,
            "SELECT id, command, started_at, last_progress_at FROM ingest_run WHERE status = 'running';",
        );
        const stale = staleRunningIngestRuns(rows, Date.now(), staleAfterMs);
        const ids = stale.slice(0, 3).map((row) => String(row.id ?? "?")).join(", ");
        return {
            name: "ingest-runs",
            ok: stale.length === 0,
            detail: stale.length === 0
                ? `no ingest_run rows stuck in status "running"`
                : `${stale.length} ingest_run row(s) stuck in status "running" past the ` +
                    `${ingestTimeoutSeconds}s ingest timeout (${ids}); the run crashed or was killed ` +
                    `without finalizing - the next 'ax ingest' auto-sweeps them, or run 'ax ingest reap' now`,
        };
    }).pipe(
        Effect.catch(() =>
            Effect.succeed({
                name: "ingest-runs",
                ok: false,
                detail: "cache unavailable - no snapshot published yet; run 'ax ingest'",
            })),
    );
}

/**
 * "cache" doctor check: the graph's own freshness, read off the published
 * snapshot - the same question the #697 stale-graph warning silently answers
 * on every DB-backed command, surfaced here explicitly. ALWAYS returns a
 * check for the same reason {@link collectIngestRunsDoctorCheck} does.
 */
function collectCacheDoctorCheck(): Effect.Effect<DoctorCheck, never, CacheRead> {
    return Effect.gen(function* () {
        const lastOkMs = yield* fetchLastSuccessfulIngestAt;
        const warning = formatStaleIngestWarning({
            lastOkMs,
            nowMs: Date.now(),
            thresholdMs: staleIngestThresholdMs(),
        });
        return {
            name: "cache",
            ok: warning === null,
            detail: warning ?? `last successful ingest: ${new Date(lastOkMs as number).toISOString()}`,
        };
    }).pipe(
        Effect.catch(() =>
            Effect.succeed({
                name: "cache",
                ok: false,
                detail: "cache unavailable - no snapshot published yet; run 'ax ingest'",
            })),
    );
}

export function collectDoctorReport(): Effect.Effect<
    DoctorReport,
    never,
    FileSystem.FileSystem | Path.Path | CacheRead
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binLink = path.join(BIN_DIR, "axctl");
        const binExists = yield* fs.exists(binLink).pipe(orAbsent(false));
        const dataDirExists = yield* fs.exists(DATA_DIR).pipe(orAbsent(false));
        const logDirExists = yield* fs.exists(LOG_DIR).pipe(orAbsent(false));
        const otlpdStatus = yield* launchdStatus(OTLPD_LABEL, OTLPD_PLIST);

        // Stale "running" runs: anything past the ingest timeout (+grace, same
        // margin the ingest lock uses) without a heartbeat is a crashed run
        // that never finalized.
        const ingestTimeoutSeconds = ingestTimeoutSecondsFromEnv();
        const ingestRunsCheck = yield* collectIngestRunsDoctorCheck(
            (ingestTimeoutSeconds + REAP_GRACE_SECONDS) * 1000,
            ingestTimeoutSeconds,
        );
        const cacheCheck = yield* collectCacheDoctorCheck();

        const checks: DoctorCheck[] = [
            {
                name: "platform",
                ok: true,
                detail: isMacos()
                    ? `${process.platform} - no daemon required; otlpd (macOS launchd) is available`
                    : `${process.platform} - no daemon required; otlpd (macOS-only) is unavailable here`,
            },
            {
                name: "binary",
                ok: binExists,
                detail: binExists ? binLink : `${binLink} missing; run axctl install`,
            },
            {
                name: "data-dir",
                ok: dataDirExists,
                detail: DATA_DIR,
            },
            {
                name: "logs-dir",
                ok: logDirExists,
                detail: LOG_DIR,
            },
            cacheCheck,
            ingestRunsCheck,
            otlpdDoctorCheck(otlpdStatus),
        ];

        // OTLP redirect visibility (#1014): read whether install saved a
        // foreign-endpoint backup, plus the harness's current logs endpoint.
        const otelBackupPath = posixPath.join(HOME, ".ax", "otel-previous.json");
        const otelBackupExists = yield* fs.exists(otelBackupPath).pipe(orAbsent(false));
        const claudeLogsEndpoint = yield* Effect.promise(async () => {
            try {
                const raw = await Bun.file(posixPath.join(HOME, ".claude", "settings.json")).text();
                const env = (JSON.parse(raw) as { env?: Record<string, string> }).env ?? {};
                return env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
            } catch { return null; }
        });
        // OTLP forwarding (#1017): is the relay config present + enabled?
        const forwardingSignals = yield* Effect.promise(async () => {
            try {
                const raw = await Bun.file(defaultForwardConfigPath()).text();
                const cfg = asForwardConfig(JSON.parse(raw));
                return cfg?.enabled ? cfg.targets.map((t) => t.signal) : [];
            } catch { return [] as string[]; }
        });
        checks.push(otelRedirectDoctorCheck({
            backupExists: otelBackupExists,
            backupPath: otelBackupPath,
            logsEndpoint: claudeLogsEndpoint,
            forwardingSignals,
        }));
        // agent_event ghost-index health (#680): a cheap fs read of the marker
        // the codex self-heal writes only when an auto-rebuild couldn't clear a
        // residual duplicate. No query, so it stays fast on a large agent_event.
        const indexMarker = yield* readIndexUnhealthyMarker(DATA_DIR);
        checks.push(agentEventIndexDoctorCheck(indexMarker));

        const onboarding = yield* buildOnboardingReport();
        const onboardingChecks: DoctorCheck[] = onboarding.checks.map((c) => ({
            name: `onboarding:${c.id}`,
            ok: c.status === "ok",
            detail: c.recommendation,
        }));
        return { platform: process.platform, checks: [...checks, ...onboardingChecks] };
    });
}

export function formatDoctorReport(report: DoctorReport, json = false): string {
    if (json) return JSON.stringify(report, null, 2);
    const lines = ["axctl doctor"];
    for (const check of report.checks) {
        lines.push(`  ${check.ok ? "ok  " : "warn"} ${check.name}: ${check.detail}`);
    }
    return lines.join("\n");
}

export function cmdInstall(options: {
    readonly telemetry?: TelemetryConsent;
    /**
     * `--keep-otel` (#1014): when the harness already points OTLP at a non-ax
     * collector, leave that config untouched instead of redirecting it to ax's
     * receiver. ax's OTLP-fed surfaces (`ax otel`, telemetry enrichment) stay
     * dark, but the user's own collector keeps receiving. No-op when nothing
     * foreign is configured.
     */
    readonly keepOtel?: boolean;
    /**
     * `--otel-forward` (#1017): redirect the harness to ax AND capture the
     * user's own OTLP collector so `otlpd` relays each body onward - ax becomes
     * additive, not exclusive. Mutually exclusive with `--keep-otel`. No-op
     * when nothing foreign is configured.
     */
    readonly otelForward?: boolean;
} = {}): Effect.Effect<
    void,
    Error,
    FileSystem.FileSystem | Path.Path | CacheRead
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        console.log("[axctl] install");
        yield* ensureDirs();

        const binSource = resolveBinaryPath();
        const binLink = path.join(BIN_DIR, "axctl");
        const aliasBinLink = path.join(BIN_DIR, "ax");
        if (binSource !== binLink) {
            yield* ensureSymlink(binSource, binLink);
            console.log(`  symlink: ${binLink} → ${binSource}`);
        }
        if (binSource !== aliasBinLink) {
            yield* ensureSymlink(binSource, aliasBinLink);
            console.log(`  alias symlink: ${aliasBinLink} → ${binSource}`);
        }

        // ax no longer runs a SurrealDB daemon - embedded DuckDB needs
        // nothing held open, and reads go through a published snapshot
        // ingest writes. A machine that installed an earlier version still
        // has the old rocksdb store on disk; it is dead weight now, not a
        // migration source (re-running 'ax ingest' rebuilds the graph
        // straight from transcripts).
        const oldDbDir = path.join(DATA_DIR, "db");
        if (yield* fs.exists(oldDbDir).pipe(orAbsent(false))) {
            console.log(
                `  note: ${oldDbDir} is the old SurrealDB data dir - ax no longer runs that daemon; ` +
                    "it is safe to delete ('rm -rf' it) once 'ax ingest' has rebuilt the graph",
            );
        }

        // otlpd is the one LaunchAgent left. Nothing else can hold its port
        // anymore - ephemeral `ax studio` runs only while a client is
        // attached - so it always loads on fresh consent. Tri-state:
        // "preserve" (no --telemetry/--no-telemetry flag - the common re-run
        // case) touches neither the plist file nor its loaded state, so a
        // bare `ax install` never silently revokes a prior `--telemetry`
        // consent.
        const consent: TelemetryConsent = options.telemetry ?? "preserve";
        const otlpdDecision = resolveOtlpdPlistDecision(consent);
        switch (otlpdDecision.action) {
            case "write-and-load": {
                yield* fs.writeFileString(OTLPD_PLIST, otlpdPlist(binSource));
                console.log(`  wrote:  ${OTLPD_PLIST}`);
                yield* Effect.promise(() => loadAgent(OTLPD_PLIST));
                break;
            }
            case "unload": {
                yield* unloadAgent(OTLPD_PLIST);
                break;
            }
            case "noop":
                break;
        }

        // Write OTLP telemetry env into each installed harness config only
        // on fresh explicit consent - "preserve" must not rewrite it either.
        // Receiver listens on 127.0.0.1:1738 (the ax OTLP port).
        if (consent === "grant") {
            const OTLP_ENDPOINT = "http://127.0.0.1:1738";
            const claudeDir = posixPath.join(HOME, ".claude");
            const claudeSettings = posixPath.join(claudeDir, "settings.json");
            // Claude: only touch if ~/.claude exists (harness is installed).
            const claudeDirExists = yield* fs.exists(claudeDir).pipe(orAbsent(false));
            if (claudeDirExists) {
                const keepOtel = options.keepOtel ?? false;
                const otelForward = options.otelForward ?? false;
                const { replaced, forwardTargets } = yield* Effect.promise(async () => {
                    const none = { replaced: [] as OtelEnvReplacement[], forwardTargets: [] as OtelForwardTarget[] };
                    try {
                        let raw = "{}";
                        try { raw = await Bun.file(claudeSettings).text(); } catch { /* absent - use default */ }
                        const parsed = JSON.parse(raw) as Record<string, unknown>;
                        // Detect a pre-existing non-ax OTLP destination BEFORE we
                        // overwrite it, so the redirect is visible, not silent (#1014).
                        const reps = detectClaudeOtelReplacements(parsed, OTLP_ENDPOINT);
                        // --keep-otel: a foreign collector is already configured and
                        // the user asked us to respect it - leave settings untouched.
                        if (keepOtel && reps.length > 0) {
                            console.log(`  otel: --keep-otel - left your OTLP config in ${claudeSettings} untouched`);
                            console.log(`        ax OTLP surfaces ('ax otel', telemetry enrichment) stay inactive; run 'ax install' without --keep-otel to redirect.`);
                            return none;
                        }
                        // --otel-forward: capture the user's collector (endpoint +
                        // headers) from the PRE-rewrite env so otlpd can relay onward.
                        const env = (parsed.env ?? {}) as Record<string, string>;
                        const forwardTargets = otelForward ? resolveForwardTargets(env) : [];
                        const next = applyClaudeOtelEnv(parsed, OTLP_ENDPOINT);
                        await Bun.write(claudeSettings, JSON.stringify(next, null, 2) + "\n");
                        console.log(`  otel: wrote Claude Code OTLP env → ${claudeSettings}`);
                        return { replaced: reps, forwardTargets };
                    } catch (err) {
                        console.warn(`  otel: could not update ${claudeSettings}: ${(err as Error).message}`);
                        return none;
                    }
                });
                if (replaced.length > 0) {
                    // Persist the original ONCE (never clobber an earlier backup) so
                    // the user can restore their own collector, and warn loudly.
                    const axDir = posixPath.join(HOME, ".ax");
                    const backupPath = posixPath.join(axDir, "otel-previous.json");
                    const backupExists = yield* fs.exists(backupPath).pipe(orAbsent(false));
                    if (!backupExists) {
                        yield* fs.makeDirectory(axDir, { recursive: true }).pipe(Effect.ignore);
                        const payload = JSON.stringify({
                            saved_at: new Date().toISOString(),
                            source: claudeSettings,
                            note: "ax install redirected these OTLP env keys to its local receiver (http://127.0.0.1:1738). Restore any value below in ~/.claude/settings.json to send that signal to your own collector again.",
                            replaced: replaced.map((r) => ({ key: r.key, previous: r.previous })),
                        }, null, 2) + "\n";
                        yield* fs.writeFileString(backupPath, payload).pipe(Effect.ignore);
                    }
                    console.warn(`  otel: ⚠ redirected an existing non-ax OTLP destination in ${claudeSettings}:`);
                    for (const r of replaced) {
                        console.warn(`          ${r.key}`);
                        console.warn(`            was: ${r.previous}`);
                        console.warn(`            now: ${r.next}`);
                    }
                    console.warn(`        that collector no longer receives these signals.`);
                    console.warn(`        original ${backupExists ? "already saved" : "saved"} at ${backupPath} - restore to re-enable it.`);
                }
                // --otel-forward: write the relay config otlpd reads at boot, so
                // ax becomes ADDITIVE - the harness feeds ax, ax feeds the user's
                // collector. The config carries the collector's auth headers; it
                // is 0600 (the secret already sat at rest in settings.json, same
                // trust level).
                if (otelForward && forwardTargets.length > 0) {
                    const forwardPath = defaultForwardConfigPath();
                    yield* fs.makeDirectory(posixPath.dirname(forwardPath), { recursive: true }).pipe(Effect.ignore);
                    const cfg = buildForwardConfig(forwardTargets, new Date().toISOString());
                    yield* fs.writeFileString(forwardPath, JSON.stringify(cfg, null, 2) + "\n").pipe(Effect.ignore);
                    yield* fs.chmod(forwardPath, 0o600).pipe(Effect.ignore);
                    console.log(`  otel: --otel-forward - ax will relay ${forwardTargets.map((t) => t.signal).join(", ")} to your collector (${forwardPath})`);
                    console.log(`        the otlpd receiver applies this on its next start; run 'ax daemon restart' (or re-login) to pick it up now.`);
                } else if (otelForward) {
                    console.log(`  otel: --otel-forward - no existing collector found to relay to; ax OTLP set up normally.`);
                }
            }

            const codexDir = posixPath.join(HOME, ".codex");
            const codexConfig = posixPath.join(codexDir, "config.toml");
            // Codex: only touch if ~/.codex exists (harness is installed).
            const codexDirExists = yield* fs.exists(codexDir).pipe(orAbsent(false));
            if (codexDirExists) {
                yield* Effect.promise(async () => {
                    try {
                        let existing = "";
                        try { existing = await Bun.file(codexConfig).text(); } catch { /* absent - start empty */ }
                        const next = applyCodexOtelToml(existing, OTLP_ENDPOINT);
                        if (next !== existing) {
                            await Bun.write(codexConfig, next);
                            console.log(`  otel: wrote Codex OTLP config → ${codexConfig}`);
                        }
                    } catch (err) {
                        console.warn(`  otel: could not update ${codexConfig}: ${(err as Error).message}`);
                    }
                });
            }
        }

        const { BANNER } = yield* Effect.promise(() => import("./banner.ts"));
        console.log(BANNER);
        console.log("  installed. try:");
        console.log("    axctl ingest          # initial fill");
        console.log("    axctl studio          # live web dashboard");
        console.log("    axctl tui             # interactive terminal dashboard");
        console.log();
        console.log("  set up agent guards (worktree safety + model-routing hooks):");
        console.log("    axctl hooks init && axctl hooks install --all --providers=claude,codex");
        console.log();
        console.log("  questions or feedback? join the community:");
        console.log("    https://discord.gg/E4R88Cvr5R");
        console.log();
        console.log(formatInstallOnboardingGuidance(yield* buildOnboardingReport()));

        // Fresh install flows straight into setup (skills + first ingest + doctor).
        console.log();
        yield* cmdSetup({ fromInstall: true });
    });
}

// ---------------------------------------------------------------------------
// `ax setup` - install the agent skills, run the first ingest, verify.
// Runnable standalone AND auto-invoked at the tail of `ax install`.
// ---------------------------------------------------------------------------

/** Agents ax can install skills for. `dir` is the install-presence probe. */
const SETUP_AGENTS: ReadonlyArray<{ id: string; label: string; dir: string }> = [
    { id: "claude-code", label: "Claude Code", dir: posixPath.join(HOME, ".claude") },
    { id: "codex", label: "Codex", dir: posixPath.join(HOME, ".codex") },
    { id: "cursor", label: "Cursor", dir: posixPath.join(HOME, ".cursor") },
];

export interface SetupOptions {
    /** Explicit agent ids; skips detection/prompt when set. */
    readonly agents?: ReadonlyArray<string>;
    /** Non-interactive: take detected defaults, no prompts. */
    readonly yes?: boolean;
    /** Internal: invoked from `cmdInstall` (tweaks headers). */
    readonly fromInstall?: boolean;
    /** Print ONLY the paste-into-your-agent prompt and exit (for copy / install.sh). */
    readonly agentPromptOnly?: boolean;
}

/** Choose which agents to install skills for. Interactive on a TTY, else the
 *  detected (present-on-disk) set, falling back to claude-code + codex. */
function resolveSetupAgents(
    opts: SetupOptions,
): Effect.Effect<string[], never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (opts.agents && opts.agents.length > 0) return [...opts.agents];
        const presence = yield* Effect.forEach(SETUP_AGENTS, (a) =>
            fs.exists(a.dir).pipe(orAbsent(false), Effect.map((exists) => ({ a, exists }))),
        );
        const present = presence.filter((p) => p.exists).map((p) => p.a);
        const fallback = present.length > 0 ? present.map((a) => a.id) : ["claude-code", "codex"];

        if (opts.yes || !process.stdin.isTTY) return fallback;

        // Interactive: per detected agent, ask yes/no (default = detected).
        const chosen: string[] = [];
        for (const { a, exists: detected } of presence) {
            const def = detected ? "Y/n" : "y/N";
            const ans = (globalThis.prompt?.(`  install ax skills for ${a.label}? [${def}]`) ?? "").trim().toLowerCase();
            const yes = ans === "" ? detected : ans === "y" || ans === "yes";
            if (yes) chosen.push(a.id);
        }
        return chosen.length > 0 ? chosen : fallback;
    });
}

export function cmdSetup(
    opts: SetupOptions = {},
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path | CacheRead> {
    return Effect.gen(function* () {
        const { AGENT_ONBOARDING_PROMPT, renderAgentOnboarding } = yield* Effect.promise(
            () => import("@ax/lib/agent-onboarding"),
        );
        if (opts.agentPromptOnly) {
            console.log(AGENT_ONBOARDING_PROMPT);
            return;
        }
        console.log(opts.fromInstall ? "[axctl] setup (skills + onboarding)" : "[axctl] setup");

        const agents = yield* resolveSetupAgents(opts);

        // 1. agent skills via the `skills` tool (npx). Non-fatal if npx is absent.
        if (agents.length === 0) {
            console.log("  skills: no agents selected, skipping");
        } else if (!which("npx")) {
            console.log("  skills: npx not found (install Node), then run:");
            console.log(`    npx skills add Necmttn/ax ${agents.map((a) => `-a ${a}`).join(" ")} -g -y`);
        } else {
            const args = ["-y", "skills", "add", "Necmttn/ax", "-g", ...agents.flatMap((a) => ["-a", a]), "-y"];
            console.log(`  skills: npx ${args.join(" ")}`);
            // Run from HOME, never the caller's cwd. `skills add -g` is a global
            // op, but npx reads the nearest package.json first - and if the
            // caller sits inside an npm/bun workspace whose `overrides` npm
            // dislikes (e.g. dogfooding inside the ax monorepo), npx aborts with
            // EOVERRIDE before it ever fetches `skills`. A neutral cwd keeps the
            // surrounding project from poisoning the global install.
            const r = spawnSync("npx", args, { stdio: "inherit", cwd: HOME });
            if (r.status === 0) console.log(`  skills: installed for ${agents.join(", ")}`);
            else console.log(`  skills: npx exited ${r.status ?? "?"} (re-run 'ax setup' or the npx command above)`);
        }

        // 2. Claude Code agent templates. The embedded template keeps compiled
        // binaries self-contained; the provisioner only refreshes ax-owned
        // files and never clobbers a user's agent of the same name.
        if (agents.includes("claude-code")) {
            const provisioned = yield* provisionRetroReviewerAgent(
                posixPath.join(HOME, ".claude", "agents"),
            );
            if (provisioned.status === "skipped_user_owned") {
                console.log(`  agents: kept user-authored ${provisioned.path}`);
            } else {
                console.log(`  agents: ${provisioned.status} ${provisioned.path}`);
            }
        }

        // 3. ingest is NOT run here. A full backfill can take minutes; blocking
        // setup on it makes install feel frozen, and re-running it on every
        // `ax update` is pure waste (the watcher + daily ETL keep the graph
        // fresh). The onboarding brief hands ingest to the agent as a narrated
        // step (dry-run ETA -> background run -> dashboard -> takeaways). Users
        // without an agent get the explicit next-step below.
        console.log("  ingest: not run yet (kept out of setup so it never blocks). populate the graph:");
        console.log("          ax ingest --dry-run   # see how long a full backfill will take");
        console.log("          ax ingest             # full backfill (watch live in ax studio)");
        console.log("          ...or the daily 04:00 sync fills it overnight.");

        // 4. verify.
        console.log();
        yield* cmdDoctor([]);

        // 5. hand off to the agent for ingest + the labeling loop (classify -> fill -> lint).
        console.log();
        console.log(renderAgentOnboarding());
    });
}

export function cmdDoctor(
    args: string[],
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | CacheRead> {
    return Effect.gen(function* () {
        const json = args.includes("--json");
        console.log(formatDoctorReport(yield* collectDoctorReport(), json));
    });
}

/**
 * Classify + reclaim a single bin-link slot during uninstall. Mirrors the
 * original lstat-based partition EXACTLY:
 *
 *   old: lstat ENOENT          -> "absent"
 *   old: lstat ok && symlink   -> unlink -> "removed"
 *   old: lstat ok && NOT link  -> "skipped" (left intact; uninstall continues)
 *
 * lstat never followed symlinks, so a regular file always classified as
 * "skipped" - never an abort. Built on the shared classifyNoFollow so a regular
 * file (whose readLink fails with EINVAL, NOT NotFound) is treated as
 * not-a-symlink -> "skipped" and is NOT re-raised: uninstall must continue to
 * the purge step regardless of what occupies the slot.
 */
export function removeBinLinkSlot(
    binLink: string,
): Effect.Effect<"removed" | "absent" | "skipped", Error, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const kind = yield* classifyNoFollow(binLink);
        if (kind === "SymbolicLink") {
            yield* fs.remove(binLink);
            return "removed";
        }
        if (kind === "Missing") return "absent";
        // "File"/"Directory"/"Other": a non-symlink in the slot. Leave intact.
        return "skipped";
    });
}

export function cmdUninstall(
    purge = false,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        console.log("[axctl] uninstall");
        const removed = yield* unloadAgent(OTLPD_PLIST);
        console.log(`  ${removed ? "removed" : "absent "}: ${OTLPD_PLIST}`);

        for (const binLink of [path.join(BIN_DIR, "axctl"), path.join(BIN_DIR, "ax")]) {
            const symlinkStatus = yield* removeBinLinkSlot(binLink);
            if (symlinkStatus === "removed") {
                console.log(`  removed symlink: ${binLink}`);
            } else if (symlinkStatus === "absent") {
                console.log(`  absent  symlink: ${binLink}`);
            } else {
                console.log(`  skipped symlink: ${binLink} (not a symlink)`);
            }
        }

        console.log();
        if (purge) {
            // --purge wipes the whole install root: the compiled binary, the
            // DuckDB cache (and any leftover SurrealDB store from an earlier
            // version), transcript/codex buckets, and logs. The symlinks +
            // the otlpd LaunchAgent are already gone above, so this leaves
            // nothing behind.
            yield* fs.remove(DATA_DIR, { recursive: true, force: true });
            console.log(`  purged data dir: ${DATA_DIR}`);
            console.log();
            console.log("ax fully removed. Thanks for trying it.");
        } else {
            console.log(`Data preserved at ${DATA_DIR}.`);
            console.log("Re-run with --purge (or 'rm -rf' it) for a clean slate.");
        }
    });
}
