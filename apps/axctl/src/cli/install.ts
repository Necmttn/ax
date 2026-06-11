import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { posixPath } from "@ax/lib/shared/path";
import { buildOnboardingReport, formatInstallOnboardingGuidance } from "./onboarding.ts";
import {
    candidatePorts,
    pickFreePort,
    probePort,
    type PortHolder,
    type PortProbeResult,
} from "@ax/lib/port";
import {
    DEFAULT_DB_HOST,
    DEFAULT_DB_PORT,
    dbUrlFromState,
    readRuntimeState,
    runtimeStatePath,
    writeRuntimeState,
} from "@ax/lib/runtime-state";
import { prettyPrint } from "@ax/lib/json";
// Schema is embedded at build time so the compiled binary is self-contained.
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import { bucketNames, renderBucketBackends } from "@ax/schema/render";
import { envConfig as readDbEnvConfig } from "@ax/lib/db";

/**
 * Tagged failure for install steps (surreal resolution, symlinking). Extends
 * `Error`, so existing `Error`-typed failure channels and `.message` readers
 * keep working unchanged.
 */
export class InstallStepError extends Schema.TaggedErrorClass<InstallStepError>(
    "InstallStepError",
)("InstallStepError", {
    message: Schema.String,
}) {}

const HOME = homedir();
const DATA_DIR = process.env.AX_DATA_DIR ?? posixPath.join(HOME, ".local", "share", "ax");
const LOG_DIR = posixPath.join(DATA_DIR, "logs");
const BUCKETS_DIR = posixPath.join(DATA_DIR, "buckets");
const LAUNCH_AGENTS_DIR = posixPath.join(HOME, "Library", "LaunchAgents");
const BIN_DIR = posixPath.join(HOME, ".local", "bin");
const VENDOR_BIN_DIR = posixPath.join(DATA_DIR, "bin");

// Pin to a known-good SurrealDB. Override via env to test newer versions.
// 3.0.x is NOT acceptable for new downloads: `SELECT ... FROM [recordid]`
// throws "Specify a database to use" (issue #251). The query shape is now
// version-portable (see @ax/lib/shared/record-select), but pin past the bug.
const SURREAL_VERSION = process.env.AXCTL_SURREAL_VERSION ?? "3.1.0";

const DB_LABEL = "com.necmttn.ax-db";
const WATCH_LABEL = "com.necmttn.ax-watch";
const DERIVE_LABEL = "com.necmttn.ax-derive-daily";
const DB_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${DB_LABEL}.plist`);
const WATCH_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${WATCH_LABEL}.plist`);
const DERIVE_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${DERIVE_LABEL}.plist`);
const ROCKSDB_BLOCK_CACHE_SIZE = process.env.AX_DB_ROCKSDB_BLOCK_CACHE_SIZE ?? "268435456";
const ROCKSDB_WRITE_BUFFER_SIZE = process.env.AX_DB_ROCKSDB_WRITE_BUFFER_SIZE ?? "33554432";
const ROCKSDB_MAX_WRITE_BUFFER_NUMBER = process.env.AX_DB_ROCKSDB_MAX_WRITE_BUFFER_NUMBER ?? "4";

const dbPlist = (
    _binPath: string,
    surrealPath: string,
    bind: { host: string; port: number },
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DB_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>ulimit -n 8192; exec "${surrealPath}" start --user root --pass root --bind ${bind.host}:${bind.port} --log info --allow-experimental=files "rocksdb://${DATA_DIR}/db"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/db.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/db.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SURREAL_BUCKET_FOLDER_ALLOWLIST</key>
    <string>${BUCKETS_DIR}</string>
    <key>SURREAL_ROCKSDB_BLOCK_CACHE_SIZE</key>
    <string>${ROCKSDB_BLOCK_CACHE_SIZE}</string>
    <key>SURREAL_ROCKSDB_WRITE_BUFFER_SIZE</key>
    <string>${ROCKSDB_WRITE_BUFFER_SIZE}</string>
    <key>SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER</key>
    <string>${ROCKSDB_MAX_WRITE_BUFFER_NUMBER}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <!--
    RocksDB opens one FD per .sst file plus WAL, MANIFEST, and OPTIONS files.
    A 100MB+ store easily clears macOS launchd's default 256 soft cap and
    /api/skills (which fans out many concurrent reads) starts returning
    "Too many open files" errors. Raise to a comfortable headroom.
  -->
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>8192</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>16384</integer>
  </dict>
</dict>
</plist>
`;

/**
 * Optional OTLP passthrough for the background agents: when the user installs
 * with `AX_OTLP_URL` set (e.g. a local Maple/Jaeger on 127.0.0.1:4318), bake it
 * into the generated plists so watcher/daily ingests export traces too.
 * Re-running `axctl install` without the env removes it again.
 */
const otlpEnvEntry = (): string => {
    const url = process.env["AX_OTLP_URL"];
    if (!url) return "";
    return `
    <key>AX_OTLP_URL</key>
    <string>${url}</string>`;
};

const watchPlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${binPath} ingest --since=1 >>${LOG_DIR}/watcher.log 2>&amp;1 &amp;&amp; ${binPath} derive-signals --since=1 >>${LOG_DIR}/watcher.log 2>&amp;1</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>${HOME}/.claude/projects</string>
    <string>${HOME}/.codex/sessions</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/watcher.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/watcher.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>${otlpEnvEntry()}
  </dict>
</dict>
</plist>
`;

// Daily full ETL: runs once a day at 04:00 local time. Full ingest (no
// --since) repulls every transcript file mtime cutoff = 0, then derives all
// signals. Idempotent thanks to UPSERTs; safe to overlap with the watcher.
const derivePlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DERIVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${binPath} ingest >>${LOG_DIR}/derive-daily.log 2>&amp;1 &amp;&amp; ${binPath} derive-signals >>${LOG_DIR}/derive-daily.log 2>&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/derive-daily.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/derive-daily.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>${otlpEnvEntry()}
  </dict>
</dict>
</plist>
`;

function which(cmd: string): string | null {
    const r = spawnSync("which", [cmd], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
}

// Strip ANSI color/control sequences. The surreal CLI emits SGR codes when it
// thinks it's attached to a TTY; we capture stdout/stderr and clean before re-logging.
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function stripAnsi(s: string): string {
    return s.replace(ANSI_REGEX, "");
}

function platformArtifact(): string | null {
    const p = process.platform;
    const a = process.arch;
    if (p === "darwin" && a === "arm64") return "darwin-arm64";
    if (p === "darwin" && a === "x64") return "darwin-amd64";
    if (p === "linux" && a === "x64") return "linux-amd64";
    if (p === "linux" && a === "arm64") return "linux-arm64";
    return null;
}

function surrealVersionString(path: string): string | null {
    const r = spawnSync(path, ["version"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return r.stdout.trim() || r.stderr.trim() || null;
}

/** True when version string starts with `3.` (any 3.x is acceptable). */
function isSupportedVersion(v: string | null): boolean {
    return !!v && /^\s*(?:surreal\s+)?3\.\d/.test(v);
}

/**
 * Resolve the surreal CLI to use. Prefers a system install with version >= 3.0,
 * falls back to a pinned download into ~/.local/share/ax/bin/surreal.
 * Override via env: AXCTL_SURREAL_PATH (explicit path), AXCTL_FORCE_DOWNLOAD=1.
 */
function ensureSurreal(): Effect.Effect<string, Error, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const pinnedSurreal = process.env.AXCTL_SURREAL_PATH;
        if (pinnedSurreal) {
            const v = surrealVersionString(pinnedSurreal);
            if (!v) return yield* new InstallStepError({ message: `AXCTL_SURREAL_PATH is not executable` });
            console.log(`  surreal: pinned ${pinnedSurreal} (${v})`);
            return pinnedSurreal;
        }

        const localBin = path.join(VENDOR_BIN_DIR, "surreal");

        // Reuse a previously-downloaded vendor binary if it boots - fastest path.
        if (yield* fs.exists(localBin).pipe(orAbsent(false))) {
            const v = surrealVersionString(localBin);
            if (isSupportedVersion(v)) {
                console.log(`  surreal: vendored ${localBin} (${v})`);
                return localBin;
            }
        }

        // Prefer system install when present and version-compatible (any 3.x).
        if (!process.env.AXCTL_FORCE_DOWNLOAD) {
            const sys = which("surreal");
            if (sys) {
                const v = surrealVersionString(sys);
                if (isSupportedVersion(v)) {
                    console.log(`  surreal: system ${sys} (${v})`);
                    return sys;
                }
                console.log(`  surreal: system ${sys} unsupported (${v}); will download`);
            }
        }

        const platform = platformArtifact();
        if (!platform) {
            return yield* new InstallStepError({
                message:
                    `Unsupported platform ${process.platform}/${process.arch}. ` +
                    `Install surreal manually: https://surrealdb.com/install`,
            });
        }

        const tag = `v${SURREAL_VERSION}`;
        const url = `https://github.com/surrealdb/surrealdb/releases/download/${tag}/surreal-${tag}.${platform}.tgz`;
        console.log(`  surreal: downloading ${tag} for ${platform}...`);

        yield* fs.makeDirectory(VENDOR_BIN_DIR, { recursive: true });
        const tmpTar = path.join(VENDOR_BIN_DIR, "surreal.tgz");

        const startedAt = Date.now();
        // The download+extract block mirrors the original try/catch: ANY failure
        // (network, HTTP, tar, fs PlatformError) falls back to a system surreal
        // if present, else re-raises. `catchCause` recovers BOTH typed failures
        // and unexpected defects, matching the original blanket `catch (err)`.
        return yield* Effect.gen(function* () {
            const res = yield* Effect.promise(() => fetch(url));
            if (!res.ok) {
                return yield* new InstallStepError({
                    message: `download failed: HTTP ${res.status} ${res.statusText}`,
                });
            }
            const buf = yield* Effect.promise(() => res.arrayBuffer());
            const sizeMB = (buf.byteLength / (1024 * 1024)).toFixed(1);
            yield* fs.writeFile(tmpTar, new Uint8Array(buf));

            const ex = spawnSync("tar", ["-xzf", tmpTar, "-C", VENDOR_BIN_DIR], {
                stdio: "inherit",
            });
            if (ex.status !== 0) return yield* new InstallStepError({ message: "tar extract failed" });
            yield* fs.chmod(localBin, 0o755);
            yield* fs.remove(tmpTar, { force: true });

            const v = surrealVersionString(localBin);
            if (!v) return yield* new InstallStepError({ message: `downloaded surreal at ${localBin} did not run` });
            const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.log(`  surreal: installed ${localBin} (${v}) [${sizeMB} MB in ${elapsedSec}s]`);
            return localBin;
        }).pipe(
            Effect.catchCause((cause) => {
                // Offline / GitHub down - fall back to system surreal if present at all.
                const err = Cause.squash(cause);
                const sys = which("surreal");
                if (sys) {
                    console.warn(
                        `  surreal: download failed (${(err as Error).message}); falling back to ${sys}`,
                    );
                    return Effect.succeed(sys);
                }
                return Effect.fail(err as Error);
            }),
        );
    });
}

function ensureDirs(): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(DATA_DIR, { recursive: true });
        yield* fs.makeDirectory(LOG_DIR, { recursive: true });
        yield* fs.makeDirectory(VENDOR_BIN_DIR, { recursive: true });
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

export type DaemonCommand = "status" | "start" | "stop" | "restart";

export interface ParsedDaemonCommand {
    readonly command: DaemonCommand;
    readonly json: boolean;
}

export interface AgentRuntimeStatus {
    readonly label: string;
    readonly plist: string;
    readonly plistExists: boolean;
    readonly loaded: boolean;
    readonly pid: number | null;
}

export interface DaemonEndpoint {
    readonly host: string;
    readonly port: number;
    readonly url: string;
    readonly listening: boolean;
    readonly conflict: PortHolder | null;
    readonly runtimeStatePath: string;
}

export interface DaemonStatus {
    readonly platform: NodeJS.Platform;
    readonly macosLaunchd: boolean;
    readonly dataDir: string;
    readonly logDir: string;
    readonly dbListening: boolean;
    readonly endpoint: DaemonEndpoint;
    readonly agents: readonly AgentRuntimeStatus[];
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

export function parseDaemonCommand(args: string[]): ParsedDaemonCommand {
    const json = args.includes("--json");
    const positional = args.filter((arg) => !arg.startsWith("--"));
    const command = positional[0] ?? "status";
    if (!["status", "start", "stop", "restart"].includes(command)) {
        throw new Error(
            `axctl daemon: unknown command "${command}" (expected status, start, stop, or restart)`,
        );
    }
    return { command: command as DaemonCommand, json };
}

function isMacos(): boolean {
    return process.platform === "darwin";
}

/**
 * Decide which port the daemon should bind. Reuses 8521 if it's free *or* if
 * the existing listener is our own launchd-managed surreal process. Otherwise
 * scans the next 20 ports and returns the first free one.
 */
function chooseBindPort(): { chosen: number; attempted: ReadonlyArray<PortProbeResult> } {
    const probe = probePort(DEFAULT_DB_PORT);
    if (!probe.listening) {
        return { chosen: DEFAULT_DB_PORT, attempted: [probe] };
    }
    const loadedPid = loadedDbPid();
    if (probe.holder && loadedPid !== null && probe.holder.pid === loadedPid) {
        return { chosen: DEFAULT_DB_PORT, attempted: [probe] };
    }
    const pick = pickFreePort(candidatePorts(DEFAULT_DB_PORT + 1, 20));
    return { chosen: pick.chosen, attempted: [probe, ...pick.attempted] };
}

/**
 * launchctl reports the DB plist's current PID. Used to decide whether the
 * listener on the configured port is "our" daemon - if so, port conflict is a
 * non-issue.
 */
function loadedDbPid(): number | null {
    if (!isMacos()) return null;
    const r = spawnSync("launchctl", ["list", DB_LABEL], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const m = output.match(/"PID"\s*=\s*(\d+);/);
    if (!m) return null;
    const pid = Number.parseInt(m[1] ?? "", 10);
    return Number.isFinite(pid) ? pid : null;
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

function collectDaemonEndpoint(): Effect.Effect<DaemonEndpoint, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const state = yield* readRuntimeState();
        const probe = probePort(state.db.port);
        const loadedPid = loadedDbPid();
        // Treat conflict as "another process is listening", not us. When launchd
        // says our DB agent owns this PID, suppress the conflict in the report.
        const conflict =
            probe.holder && loadedPid !== null && probe.holder.pid === loadedPid
                ? null
                : probe.holder;
        return {
            host: state.db.host,
            port: state.db.port,
            url: dbUrlFromState(state),
            listening: probe.listening,
            conflict,
            runtimeStatePath: runtimeStatePath(),
        };
    });
}

function collectDaemonStatus(): Effect.Effect<DaemonStatus, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const endpoint = yield* collectDaemonEndpoint();
        return {
            platform: process.platform,
            macosLaunchd: isMacos(),
            dataDir: DATA_DIR,
            logDir: LOG_DIR,
            dbListening: endpoint.listening,
            endpoint,
            agents: [
                yield* launchdStatus(DB_LABEL, DB_PLIST),
                yield* launchdStatus(WATCH_LABEL, WATCH_PLIST),
                yield* launchdStatus(DERIVE_LABEL, DERIVE_PLIST),
            ],
        };
    });
}

export function formatDaemonStatus(status: DaemonStatus, json = false): string {
    if (json) return prettyPrint(status);
    const ep = status.endpoint;
    const endpointDesc = `${ep.host}:${ep.port}`;
    const dbLine = status.dbListening
        ? `listening on ${endpointDesc}`
        : `not listening on ${endpointDesc}`;
    const lines = [
        "axctl daemon",
        `  platform: ${status.platform}${status.macosLaunchd ? "" : " (launchd unavailable)"}`,
        `  endpoint: ${ep.url}`,
        `  database: ${dbLine}`,
        `  data: ${status.dataDir}`,
        `  logs: ${status.logDir}`,
        `  runtime-state: ${ep.runtimeStatePath}`,
    ];
    if (ep.conflict) {
        lines.push(
            `  conflict: port ${ep.port} held by pid=${ep.conflict.pid} (${ep.conflict.command}); rerun 'axctl install' to pick a free port`,
        );
    }
    for (const agent of status.agents) {
        const runtime = agent.loaded
            ? `loaded${agent.pid === null ? "" : ` pid=${agent.pid}`}`
            : "not loaded";
        lines.push(`  ${agent.label}: ${runtime}; plist=${agent.plistExists ? "present" : "absent"}`);
    }
    return lines.join("\n");
}

/**
 * Buckets schema.surql defines. A missing one means the schema import rolled
 * back partway - historically a bucket BACKEND path outside the daemon's
 * allowlist (issue #251) - and transcript snapshots silently no-op.
 */
const EXPECTED_BUCKETS = bucketNames(schemaSurql);

/**
 * Names from EXPECTED_BUCKETS that are NOT defined on the configured ns/db,
 * or null when the daemon could not be queried (down, auth, non-JSON). Plain
 * HTTP so doctor needs no SurrealClient layer; creds/ns/db come from the same
 * AX_DB_* env config the rest of ax uses.
 */
async function probeMissingBuckets(endpoint: { host: string; port: number }): Promise<string[] | null> {
    try {
        const db = readDbEnvConfig();
        const res = await fetch(`http://${endpoint.host}:${endpoint.port}/sql`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Basic ${Buffer.from(`${db.user}:${db.pass}`).toString("base64")}`,
                "surreal-ns": db.ns,
                "surreal-db": db.db,
            },
            body: "INFO FOR DB;",
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const out = (await res.json()) as Array<{ result?: { buckets?: Record<string, unknown> } }>;
        const buckets = out?.[0]?.result?.buckets;
        if (buckets === undefined) return null;
        return EXPECTED_BUCKETS.filter((name) => !(name in buckets));
    } catch {
        return null;
    }
}

export function collectDoctorReport(): Effect.Effect<
    DoctorReport,
    never,
    FileSystem.FileSystem | Path.Path
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binLink = path.join(BIN_DIR, "axctl");
        const surrealPath =
            process.env.AXCTL_SURREAL_PATH ?? which("surreal") ?? path.join(VENDOR_BIN_DIR, "surreal");
        const surrealExists = yield* fs.exists(surrealPath).pipe(orAbsent(false));
        const surrealVersion = surrealExists ? surrealVersionString(surrealPath) : null;
        const daemon = yield* collectDaemonStatus();
        const binExists = yield* fs.exists(binLink).pipe(orAbsent(false));
        const dataDirExists = yield* fs.exists(DATA_DIR).pipe(orAbsent(false));
        const logDirExists = yield* fs.exists(LOG_DIR).pipe(orAbsent(false));
        const runtimeStateExists = yield* fs
            .exists(daemon.endpoint.runtimeStatePath)
            .pipe(orAbsent(false));
        const missingBuckets = daemon.dbListening && daemon.endpoint.conflict === null
            ? yield* Effect.promise(() => probeMissingBuckets(daemon.endpoint))
            : null;
        const checks: DoctorCheck[] = [
            {
                name: "platform",
                ok: isMacos(),
                detail: isMacos() ? "macOS launchd supported" : `${process.platform}; daemon install is macOS-only`,
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
            {
                name: "surreal",
                ok: isSupportedVersion(surrealVersion),
                detail: surrealVersion ? `${surrealPath} (${surrealVersion})` : `${surrealPath} missing or not executable`,
            },
            {
                name: "db-listener",
                ok: daemon.dbListening && daemon.endpoint.conflict === null,
                detail: daemon.dbListening
                    ? daemon.endpoint.conflict === null
                        ? `${daemon.endpoint.host}:${daemon.endpoint.port} is listening`
                        : `${daemon.endpoint.host}:${daemon.endpoint.port} held by pid=${daemon.endpoint.conflict.pid} (${daemon.endpoint.conflict.command}); rerun 'axctl install' to pick a free port`
                    : `${daemon.endpoint.host}:${daemon.endpoint.port} is not listening`,
            },
            {
                name: "runtime-state",
                ok: runtimeStateExists,
                detail: daemon.endpoint.runtimeStatePath,
            },
            ...daemon.agents.map((agent): DoctorCheck => ({
                name: agent.label,
                ok: !isMacos() || (agent.plistExists && agent.loaded),
                detail: `${agent.loaded ? "loaded" : "not loaded"}; plist=${agent.plistExists ? "present" : "absent"}`,
            })),
        ];
        if (missingBuckets !== null) {
            checks.push({
                name: "db-buckets",
                ok: missingBuckets.length === 0,
                detail: missingBuckets.length === 0
                    ? `${EXPECTED_BUCKETS.join(", ")} defined`
                    : `missing bucket(s): ${missingBuckets.join(", ")}; re-run 'axctl install' to re-apply the schema`,
            });
        }
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

export function cmdInstall(): Effect.Effect<
    void,
    Error,
    FileSystem.FileSystem | Path.Path
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        console.log("[axctl] install");
        yield* ensureDirs();

        const surrealPath = yield* ensureSurreal();

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

        const bind = chooseBindPort();
        if (bind.chosen !== DEFAULT_DB_PORT) {
            const conflict = bind.attempted.find(
                (probe) => probe.port === DEFAULT_DB_PORT && probe.listening,
            )?.holder;
            if (conflict) {
                console.log(
                    `  port ${DEFAULT_DB_PORT} held by pid=${conflict.pid} (${conflict.command}); falling back to ${bind.chosen}`,
                );
            } else {
                console.log(`  port ${DEFAULT_DB_PORT} unavailable; using ${bind.chosen}`);
            }
        }
        yield* writeRuntimeState({ db: { host: DEFAULT_DB_HOST, port: bind.chosen } });
        console.log(`  runtime-state: ${runtimeStatePath()} (db @ ${DEFAULT_DB_HOST}:${bind.chosen})`);

        yield* fs.writeFileString(
            DB_PLIST,
            dbPlist(binSource, surrealPath, { host: DEFAULT_DB_HOST, port: bind.chosen }),
        );
        console.log(`  wrote:  ${DB_PLIST}`);
        yield* Effect.promise(() => loadAgent(DB_PLIST));

        // Wait for daemon to bind
        for (let i = 0; i < 8; i++) {
            if (probePort(bind.chosen).listening) {
                console.log(`  daemon: listening on ${DEFAULT_DB_HOST}:${bind.chosen}`);
                break;
            }
            yield* Effect.promise(() => new Promise((res) => setTimeout(res, 500)));
        }

        yield* fs.writeFileString(WATCH_PLIST, watchPlist(binSource));
        console.log(`  wrote:  ${WATCH_PLIST}`);
        yield* Effect.promise(() => loadAgent(WATCH_PLIST));

        yield* fs.writeFileString(DERIVE_PLIST, derivePlist(binSource));
        console.log(`  wrote:  ${DERIVE_PLIST}`);
        yield* Effect.promise(() => loadAgent(DERIVE_PLIST));

        // Apply schema from embedded resource via surreal import. Bucket
        // BACKEND paths are rewritten to THIS machine's buckets dir - the
        // committed schema.surql carries the committing machine's absolute
        // path, which the daemon's bucket allowlist would deny here,
        // rolling back the entire import transaction (issue #251).
        const schemaPath = path.join(DATA_DIR, ".schema-cache.surql");
        yield* fs.writeFileString(schemaPath, renderBucketBackends(schemaSurql, BUCKETS_DIR));
        const r = spawnSync(
            surrealPath,
            [
                "import",
                "--endpoint",
                `http://${DEFAULT_DB_HOST}:${bind.chosen}`,
                "--user",
                "root",
                "--pass",
                "root",
                "--ns",
                "ax",
                "--db",
                "main",
                schemaPath,
            ],
            { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
        );
        if (r.status === 0) {
            console.log("  schema: applied");
        } else {
            // Capture stdio so the surreal CLI doesn't paint raw ANSI escapes to the
            // user's terminal; surface only the relevant lines on failure.
            const out = stripAnsi(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim();
            // Don't guess the cause - surface the real surreal error below. The
            // common one is a UNIQUE-index rebuild aborting on duplicate data;
            // index defs are now `IF NOT EXISTS` so re-apply is a no-op on an
            // already-populated DB. A genuine connection error reads "refused".
            const looksLikeConn = /refus|connect|unreachable|timed out/i.test(out);
            console.warn(
                looksLikeConn
                    ? "  schema: apply failed (daemon not reachable); re-run 'axctl install' once it is up"
                    : "  schema: apply failed; resolve the error below, then re-run 'axctl install':",
            );
            if (out) {
                for (const line of out.split("\n")) {
                    if (line.trim()) console.warn(`    ${line}`);
                }
            }
        }
        yield* fs.remove(schemaPath, { force: true });

        const { BANNER } = yield* Effect.promise(() => import("./banner.ts"));
        console.log(BANNER);
        console.log("  installed. try:");
        console.log("    axctl ingest          # initial fill");
        console.log("    axctl serve           # live web dashboard");
        console.log("    axctl tui             # interactive terminal dashboard");
        console.log("    launchctl list | grep 'com.necmttn.ax'   # verify both LaunchAgents loaded");
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
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
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
            const r = spawnSync("npx", args, { stdio: "inherit" });
            if (r.status === 0) console.log(`  skills: installed for ${agents.join(", ")}`);
            else console.log(`  skills: npx exited ${r.status ?? "?"} (re-run 'ax setup' or the npx command above)`);
        }

        // 2. ingest is NOT run here. A full backfill can take minutes; blocking
        // setup on it makes install feel frozen, and re-running it on every
        // `ax update` is pure waste (the watcher + daily ETL keep the graph
        // fresh). The onboarding brief hands ingest to the agent as a narrated
        // step (dry-run ETA -> background run -> dashboard -> takeaways). Users
        // without an agent get the explicit next-step below.
        console.log("  ingest: not run yet (kept out of setup so it never blocks). populate the graph:");
        console.log("          ax ingest --dry-run   # see how long a full backfill will take");
        console.log("          ax ingest             # full backfill (watch live in ax serve)");
        console.log("          ...or the daily 04:00 sync fills it overnight.");

        // 3. verify.
        console.log();
        yield* cmdDoctor([]);

        // 4. hand off to the agent for ingest + the labeling loop (classify -> fill -> lint).
        console.log();
        console.log(renderAgentOnboarding());
    });
}

export function cmdDaemon(
    args: string[],
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parsed = parseDaemonCommand(args);
        // Whether all three plists already exist on disk (probes; absent => false).
        const plistsPresent = (): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
            Effect.gen(function* () {
                const db = yield* fs.exists(DB_PLIST).pipe(orAbsent(false));
                const watch = yield* fs.exists(WATCH_PLIST).pipe(orAbsent(false));
                const derive = yield* fs.exists(DERIVE_PLIST).pipe(orAbsent(false));
                return db && watch && derive;
            });

        if (!isMacos()) {
            console.log(formatDaemonStatus(yield* collectDaemonStatus(), parsed.json));
            if (parsed.command !== "status") {
                console.error("axctl daemon: start/stop/restart use launchd and are macOS-only");
                process.exit(2);
            }
            return;
        }

        if (parsed.command === "start") {
            if (!(yield* plistsPresent())) {
                yield* cmdInstall();
            } else {
                yield* Effect.promise(() => loadAgent(DB_PLIST));
                yield* Effect.promise(() => loadAgent(WATCH_PLIST));
                yield* Effect.promise(() => loadAgent(DERIVE_PLIST));
            }
        } else if (parsed.command === "stop") {
            yield* Effect.promise(() => unloadAgentKeepPlist(DERIVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(WATCH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DB_PLIST));
        } else if (parsed.command === "restart") {
            yield* Effect.promise(() => unloadAgentKeepPlist(DERIVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(WATCH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DB_PLIST));
            if (!(yield* plistsPresent())) {
                yield* cmdInstall();
            } else {
                yield* Effect.promise(() => loadAgent(DB_PLIST));
                yield* Effect.promise(() => loadAgent(WATCH_PLIST));
                yield* Effect.promise(() => loadAgent(DERIVE_PLIST));
            }
        }

        console.log(formatDaemonStatus(yield* collectDaemonStatus(), parsed.json));
    });
}

export function cmdDoctor(
    args: string[],
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
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
        for (const plist of [DERIVE_PLIST, WATCH_PLIST, DB_PLIST]) {
            const removed = yield* unloadAgent(plist);
            console.log(`  ${removed ? "removed" : "absent "}: ${plist}`);
        }

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
            // SurrealDB store, transcript/codex buckets, and logs. The symlinks +
            // launchd jobs are already gone above, so this leaves nothing behind.
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
