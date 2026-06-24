import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { posixPath } from "@ax/lib/shared/path";
import { buildOnboardingReport, formatInstallOnboardingGuidance } from "./onboarding.ts";
import { applyClaudeOtelEnv, applyCodexOtelToml } from "../otel/install-config.ts";
import { fail } from "./commands/shared.ts";
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
    type RuntimeState,
    runtimeStatePath,
    writeRuntimeState,
} from "@ax/lib/runtime-state";
import { prettyPrint } from "@ax/lib/json";
// Schema is embedded at build time so the compiled binary is self-contained.
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import { bucketNames, renderBucketBackends } from "@ax/schema/render";
import { envConfig as readDbEnvConfig } from "@ax/lib/db";
import { DEFAULT_INGEST_TIMEOUT_SECONDS } from "@ax/lib/config";
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";

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
const QUOTA_REFRESH_LABEL = "com.necmttn.ax-quota-refresh";
export const PROFILE_PUBLISH_IF_STALE_HOURS = 2;
const DB_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${DB_LABEL}.plist`);
const WATCH_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${WATCH_LABEL}.plist`);
const DERIVE_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${DERIVE_LABEL}.plist`);
const QUOTA_REFRESH_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${QUOTA_REFRESH_LABEL}.plist`);
const SERVE_LABEL = "com.necmttn.ax-serve";
const SERVE_PLIST = posixPath.join(LAUNCH_AGENTS_DIR, `${SERVE_LABEL}.plist`);

/** Candidate install locations for the `ax studio` desktop app bundle (productName "ax studio"). */
export const DESKTOP_APP_CANDIDATES: readonly string[] = [
    "/Applications/ax studio.app",
    posixPath.join(HOME, "Applications", "ax studio.app"),
];

/**
 * Locate an installed `ax studio.app`. When present, the desktop app owns the
 * surreal + serve daemon (IDE model - see
 * docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md), so
 * `cmdInstall` skips the 5 background LaunchAgents (no more "bash - unidentified
 * developer" Login Items) and migrates any pre-existing ones. `exists` is
 * injected (the caller resolves existence via the Effect `FileSystem`, so this
 * stays pure + node:fs-free - the check:no-node-fs gate bans node:fs in apps/).
 */
export function findDesktopApp(
    candidates: readonly string[],
    exists: (p: string) => boolean,
): string | undefined {
    return candidates.find(exists);
}
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
    <string>ulimit -n 65536; exec "${surrealPath}" start --user root --pass root --bind ${bind.host}:${bind.port} --log info --allow-experimental=files "rocksdb://${DATA_DIR}/db"</string>
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
    "Too many open files" errors. The store grows unbounded as telemetry
    accumulates - a real dogfood DB hit 734 .sst files and the prior 8192 cap
    was reachable for heavy users (ingest then fails / the watcher wedges).
    Raised to generous headroom, well under macOS kern.maxfilesperproc (~245k).
  -->
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>65536</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>131072</integer>
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
    <string>${binPath} ingest --since=1 >>${LOG_DIR}/watcher.log 2>&amp;1 &amp;&amp; ${binPath} derive-signals --since=1 >>${LOG_DIR}/watcher.log 2>&amp;1; ${binPath} profile publish --if-stale=${PROFILE_PUBLISH_IF_STALE_HOURS} >>${LOG_DIR}/watcher.log 2>&amp;1 || true</string>
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

export function watcherProfilePublishDoctorCheck(plistText: string): DoctorCheck {
    const expected = PROFILE_PUBLISH_IF_STALE_HOURS;
    const match = /profile publish --if-stale=(\d+)/.exec(plistText);
    if (!match) {
        return {
            name: "watcher-profile-publish",
            ok: false,
            detail: `watcher plist is missing profile publish --if-stale=${expected}; run 'axctl install' to refresh the watcher plist`,
        };
    }

    const actual = Number.parseInt(match[1] ?? "", 10);
    if (actual === expected) {
        return {
            name: "watcher-profile-publish",
            ok: true,
            detail: `profile publish freshness gate: ${expected}h`,
        };
    }

    return {
        name: "watcher-profile-publish",
        ok: false,
        detail: `profile publish uses --if-stale=${actual}; expected --if-stale=${expected}; run 'axctl install' to refresh the watcher plist`,
    };
}

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

// Periodic quota cache refresh: fires every 5 minutes so the routing hook and
// statusline always have a fresh-enough snapshot without hammering the API.
// The StartInterval approach is simpler than a WatchPaths trigger and avoids
// the watcher's ThrottleInterval stacking. RunAtLoad=false: no immediate fetch
// on login - the first natural session start is enough for the initial warm.
const quotaRefreshPlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${QUOTA_REFRESH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${binPath} quota --fresh >>${LOG_DIR}/quota-refresh.log 2>&amp;1 || true</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/quota-refresh.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/quota-refresh.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

export const servePlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "${binPath}" serve --port=${DEFAULT_DASHBOARD_PORT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/serve.out</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/serve.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
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
    /**
     * IDE model: the `ax studio` desktop app is installed and owns surreal +
     * serve via its SMAppService helper, so the background LaunchAgents are
     * intentionally absent and the DB port is held by the app's helper - both
     * are healthy states, not failures (#568).
     */
    readonly ideModel: boolean;
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

/** Parse `ws://host:port` (or http/wss) into host + port. null on garbage. */
function hostPortFromUrl(url: string): { host: string; port: number } | null {
    try {
        const u = new URL(url);
        const port = u.port ? Number(u.port) : NaN;
        if (!u.hostname || !Number.isFinite(port)) return null;
        return { host: u.hostname, port };
    } catch {
        return null;
    }
}

/**
 * Resolve the DB endpoint doctor should probe. Mirrors the SurrealClient's own
 * precedence (`AX_DB_URL` wins, else the daemon's runtime-state port - see
 * packages/lib/src/config.ts) so doctor checks the SAME instance the rest of the
 * CLI connects to. Without this, an `AX_DB_URL` override (remote DB, custom port,
 * a second instance) silently left doctor probing the default 8521 daemon and
 * reporting another instance's listener / buckets / stuck ingest_runs.
 *
 * Pure (no fs / process.env reads) so it is unit-testable.
 */
export function resolveDaemonHostPort(
    state: RuntimeState,
    envUrl: string | undefined,
): { host: string; port: number; url: string } {
    const override = envUrl ? hostPortFromUrl(envUrl) : null;
    if (override) return { host: override.host, port: override.port, url: envUrl as string };
    return { host: state.db.host, port: state.db.port, url: dbUrlFromState(state) };
}

/**
 * Decide whether a DB-port holder is a genuine foreign conflict. Returns null
 * (no conflict) when the holder is our own launchd ax-db agent, OR - in IDE
 * model - when the holder is a surreal process: that's the `ax studio` app's
 * helper legitimately owning the DB port, not a foreign conflict (#568).
 * Pure, so the suppression rule is unit-testable.
 */
export function dbPortConflict(
    holder: PortHolder | null,
    loadedPid: number | null,
    ideModel: boolean,
): PortHolder | null {
    if (!holder) return null;
    if (loadedPid !== null && holder.pid === loadedPid) return null;
    if (ideModel && /surreal/i.test(holder.command)) return null;
    return holder;
}

/**
 * Doctor check for one background LaunchAgent. In IDE model the desktop app
 * owns the daemons, so an absent/unloaded agent is the expected, healthy state
 * - not a failure (#568). Pure, so the IDE-model carve-out is unit-testable.
 */
export function agentDoctorCheck(
    agent: AgentRuntimeStatus,
    ideModel: boolean,
    macos: boolean,
): DoctorCheck {
    return {
        name: agent.label,
        ok: ideModel || !macos || (agent.plistExists && agent.loaded),
        detail: ideModel && !agent.loaded
            ? "owned by ax studio app (IDE model)"
            : `${agent.loaded ? "loaded" : "not loaded"}; plist=${agent.plistExists ? "present" : "absent"}`,
    };
}

function collectDaemonEndpoint(
    ideModel: boolean,
): Effect.Effect<DaemonEndpoint, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const state = yield* readRuntimeState();
        const { host, port, url } = resolveDaemonHostPort(state, process.env.AX_DB_URL);
        const probe = probePort(port);
        const loadedPid = loadedDbPid();
        const conflict = dbPortConflict(probe.holder, loadedPid, ideModel);
        return {
            host,
            port,
            url,
            listening: probe.listening,
            conflict,
            runtimeStatePath: runtimeStatePath(),
        };
    });
}

/** True when the `ax studio` desktop app is installed (IDE daemon model). */
function detectIdeModel(): Effect.Effect<boolean, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const candidate of DESKTOP_APP_CANDIDATES) {
            if (yield* fs.exists(candidate).pipe(orAbsent(false))) return true;
        }
        return false;
    });
}

function collectDaemonStatus(): Effect.Effect<DaemonStatus, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const ideModel = yield* detectIdeModel();
        const endpoint = yield* collectDaemonEndpoint(ideModel);
        return {
            platform: process.platform,
            macosLaunchd: isMacos(),
            dataDir: DATA_DIR,
            logDir: LOG_DIR,
            dbListening: endpoint.listening,
            endpoint,
            ideModel,
            agents: [
                yield* launchdStatus(DB_LABEL, DB_PLIST),
                yield* launchdStatus(WATCH_LABEL, WATCH_PLIST),
                yield* launchdStatus(DERIVE_LABEL, DERIVE_PLIST),
                yield* launchdStatus(QUOTA_REFRESH_LABEL, QUOTA_REFRESH_PLIST),
                yield* launchdStatus(SERVE_LABEL, SERVE_PLIST),
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
    if (status.ideModel) {
        lines.push("  model: IDE (ax studio app owns surreal + serve; LaunchAgents intentionally absent)");
    }
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

/** A row from `SELECT ... FROM ingest_run WHERE status = 'running'`. */
export interface RunningIngestRunRow {
    readonly id?: unknown;
    readonly command?: unknown;
    readonly started_at?: unknown;
    readonly last_progress_at?: unknown;
}

/**
 * Ingest wall-clock budget (seconds). Doctor runs on the no-DB code path
 * (no AxConfig layer), so mirror the `AX_INGEST_TIMEOUT_SECONDS` knob with
 * the same lenient parse-or-fallback the config layer uses.
 */
function ingestTimeoutSecondsFromEnv(): number {
    const parsed = Number.parseInt(process.env.AX_INGEST_TIMEOUT_SECONDS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INGEST_TIMEOUT_SECONDS;
}

/**
 * Rows whose newest heartbeat (`last_progress_at`, else `started_at`) is older
 * than `staleAfterMs`. A run still in status "running" past the ingest timeout
 * was crashed/killed without finalizing - every clean exit path (ok, error,
 * interrupt, timeout) settles the row, so a stale "running" row is a lie that
 * misleads diagnosis (issue #269). Exported for tests.
 */
export function staleRunningIngestRuns(
    rows: readonly RunningIngestRunRow[],
    nowMs: number,
    staleAfterMs: number,
): RunningIngestRunRow[] {
    return rows.filter((row) => {
        const beat = Date.parse(String(row.last_progress_at ?? row.started_at ?? ""));
        // No parseable timestamp at all: can't prove it's live, flag it.
        if (!Number.isFinite(beat)) return true;
        return nowMs - beat > staleAfterMs;
    });
}

/**
 * ingest_run rows stuck in status "running" longer than `staleAfterMs`, or
 * null when the daemon could not be queried. Plain HTTP for the same reason
 * as {@link probeMissingBuckets}: doctor has no SurrealClient layer.
 */
async function probeStaleIngestRuns(
    endpoint: { host: string; port: number },
    staleAfterMs: number,
): Promise<RunningIngestRunRow[] | null> {
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
            body: "SELECT id, command, started_at, last_progress_at FROM ingest_run WHERE status = 'running';",
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const out = (await res.json()) as Array<{ result?: RunningIngestRunRow[] }>;
        const rows = out?.[0]?.result;
        if (!Array.isArray(rows)) return null;
        return staleRunningIngestRuns(rows, Date.now(), staleAfterMs);
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
        const watcherPlistText = yield* fs
            .readFileString(WATCH_PLIST)
            .pipe(orAbsent<string | null>(null));
        const dbReachable = daemon.dbListening && daemon.endpoint.conflict === null;
        const missingBuckets = dbReachable
            ? yield* Effect.promise(() => probeMissingBuckets(daemon.endpoint))
            : null;
        // Stale "running" runs: anything past the ingest timeout (+grace, same
        // margin the ingest lock uses) without a heartbeat is a crashed run
        // that never finalized.
        const ingestTimeoutSeconds = ingestTimeoutSecondsFromEnv();
        const staleIngestRuns = dbReachable
            ? yield* Effect.promise(() =>
                probeStaleIngestRuns(daemon.endpoint, (ingestTimeoutSeconds + 60) * 1000))
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
                        ? daemon.ideModel
                            ? `${daemon.endpoint.host}:${daemon.endpoint.port} is listening (ax studio app)`
                            : `${daemon.endpoint.host}:${daemon.endpoint.port} is listening`
                        : `${daemon.endpoint.host}:${daemon.endpoint.port} held by pid=${daemon.endpoint.conflict.pid} (${daemon.endpoint.conflict.command}); rerun 'axctl install' to pick a free port`
                    : daemon.ideModel
                        ? `${daemon.endpoint.host}:${daemon.endpoint.port} not listening - open ax studio (it owns the DB in IDE model)`
                        : `${daemon.endpoint.host}:${daemon.endpoint.port} is not listening`,
            },
            {
                name: "runtime-state",
                ok: runtimeStateExists,
                detail: daemon.endpoint.runtimeStatePath,
            },
            ...daemon.agents.map((agent): DoctorCheck =>
                agentDoctorCheck(agent, daemon.ideModel, isMacos())),
        ];
        if (watcherPlistText !== null) {
            checks.push(watcherProfilePublishDoctorCheck(watcherPlistText));
        }
        if (missingBuckets !== null) {
            checks.push({
                name: "db-buckets",
                ok: missingBuckets.length === 0,
                detail: missingBuckets.length === 0
                    ? `${EXPECTED_BUCKETS.join(", ")} defined`
                    : `missing bucket(s): ${missingBuckets.join(", ")}; re-run 'axctl install' to re-apply the schema`,
            });
        }
        if (staleIngestRuns !== null) {
            const ids = staleIngestRuns.slice(0, 3).map((row) => String(row.id ?? "?")).join(", ");
            checks.push({
                name: "ingest-runs",
                ok: staleIngestRuns.length === 0,
                detail: staleIngestRuns.length === 0
                    ? `no ingest_run rows stuck in status "running"`
                    : `${staleIngestRuns.length} ingest_run row(s) stuck in status "running" past the ` +
                        `${ingestTimeoutSeconds}s ingest timeout (${ids}); the run crashed or was killed ` +
                        `without finalizing - the next 'ax ingest' auto-sweeps them, or run 'ax ingest reap' now`,
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

        // IDE daemon model: when the ax studio desktop app is installed it owns
        // surreal + serve + schema (see DesktopSchema), so the CLI must NOT drop
        // the 5 background LaunchAgents that show as "bash - unidentified
        // developer" Login Items. Skip them + the schema import (the app applies
        // it on boot), and migrate away any pre-existing ones.
        const presentApps = new Set<string>();
        for (const candidate of DESKTOP_APP_CANDIDATES) {
            if (yield* fs.exists(candidate).pipe(orAbsent(false))) presentApps.add(candidate);
        }
        const desktopApp = findDesktopApp(DESKTOP_APP_CANDIDATES, (p) => presentApps.has(p));
        if (desktopApp) {
            console.log(`  desktop app detected: ${desktopApp}`);
            console.log(
                "  it owns surreal + serve + schema (IDE model) - skipping background LaunchAgents",
            );
            // Graceful handoff (#568): only drop the ax-db LaunchAgent once the
            // desktop app's helper is actually serving the DB. Tearing it down
            // before the replacement is live left the DB down with no listener.
            // Probe the configured port; a surreal holder that ISN'T our own
            // launchd ax-db pid is the app helper.
            const dbProbe = probePort(bind.chosen);
            const ourDbPid = loadedDbPid();
            const helperServesDb =
                dbProbe.listening && dbProbe.holder !== null
                && (ourDbPid === null || dbProbe.holder.pid !== ourDbPid)
                && /surreal/i.test(dbProbe.holder.command);
            const toMigrate = [WATCH_PLIST, DERIVE_PLIST, QUOTA_REFRESH_PLIST, SERVE_PLIST];
            if (helperServesDb) toMigrate.unshift(DB_PLIST);
            let migrated = 0;
            for (const plist of toMigrate) {
                if (yield* unloadAgent(plist)) migrated += 1;
            }
            if (migrated > 0) {
                console.log(`  migrated ${migrated} pre-existing LaunchAgent(s) (unloaded + removed)`);
            }
            if (!helperServesDb) {
                // The app isn't serving the DB yet - keep ax-db so the DB stays
                // up, and tell the user how to finish the handoff.
                console.log("  ax studio isn't serving the DB yet - keeping the ax-db LaunchAgent so the DB stays up");
                console.log("  → open ax studio + approve its background item (System Settings ▸ Login Items), then rerun 'axctl install'");
            }
        } else {
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

        yield* fs.writeFileString(QUOTA_REFRESH_PLIST, quotaRefreshPlist(binSource));
        console.log(`  wrote:  ${QUOTA_REFRESH_PLIST}`);
        yield* Effect.promise(() => loadAgent(QUOTA_REFRESH_PLIST));

        yield* fs.writeFileString(SERVE_PLIST, servePlist(binSource));
        console.log(`  wrote:  ${SERVE_PLIST}`);
        yield* Effect.promise(() => loadAgent(SERVE_PLIST));

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
        }

        // Write OTLP telemetry env into each installed harness config.
        // Receiver listens on 127.0.0.1:1738 (the ax OTLP port).
        const OTLP_ENDPOINT = "http://127.0.0.1:1738";
        const claudeDir = posixPath.join(HOME, ".claude");
        const claudeSettings = posixPath.join(claudeDir, "settings.json");
        // Claude: only touch if ~/.claude exists (harness is installed).
        const claudeDirExists = yield* fs.exists(claudeDir).pipe(orAbsent(false));
        if (claudeDirExists) {
            yield* Effect.promise(async () => {
                try {
                    let raw = "{}";
                    try { raw = await Bun.file(claudeSettings).text(); } catch { /* absent - use default */ }
                    const parsed = JSON.parse(raw) as Record<string, unknown>;
                    const next = applyClaudeOtelEnv(parsed, OTLP_ENDPOINT);
                    await Bun.write(claudeSettings, JSON.stringify(next, null, 2) + "\n");
                    console.log(`  otel: wrote Claude Code OTLP env → ${claudeSettings}`);
                } catch (err) {
                    console.warn(`  otel: could not update ${claudeSettings}: ${(err as Error).message}`);
                }
            });
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

        const { BANNER } = yield* Effect.promise(() => import("./banner.ts"));
        console.log(BANNER);
        console.log("  installed. try:");
        console.log("    axctl ingest          # initial fill");
        console.log("    axctl serve           # live web dashboard");
        console.log("    axctl tui             # interactive terminal dashboard");
        console.log(
            desktopApp
                ? "    open the ax studio app   # it runs the surreal + serve daemon"
                : "    launchctl list | grep 'com.necmttn.ax'   # verify the LaunchAgents loaded",
        );
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
        // Whether all four plists already exist on disk (probes; absent => false).
        const plistsPresent = (): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
            Effect.gen(function* () {
                const db = yield* fs.exists(DB_PLIST).pipe(orAbsent(false));
                const watch = yield* fs.exists(WATCH_PLIST).pipe(orAbsent(false));
                const derive = yield* fs.exists(DERIVE_PLIST).pipe(orAbsent(false));
                const quotaRefresh = yield* fs.exists(QUOTA_REFRESH_PLIST).pipe(orAbsent(false));
                const serve = yield* fs.exists(SERVE_PLIST).pipe(orAbsent(false));
                return db && watch && derive && quotaRefresh && serve;
            });

        if (!isMacos()) {
            console.log(formatDaemonStatus(yield* collectDaemonStatus(), parsed.json));
            if (parsed.command !== "status") {
                fail("axctl daemon: start/stop/restart use launchd and are macOS-only");
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
                yield* Effect.promise(() => loadAgent(QUOTA_REFRESH_PLIST));
                yield* Effect.promise(() => loadAgent(SERVE_PLIST));
            }
        } else if (parsed.command === "stop") {
            yield* Effect.promise(() => unloadAgentKeepPlist(SERVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(QUOTA_REFRESH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DERIVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(WATCH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DB_PLIST));
        } else if (parsed.command === "restart") {
            yield* Effect.promise(() => unloadAgentKeepPlist(SERVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(QUOTA_REFRESH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DERIVE_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(WATCH_PLIST));
            yield* Effect.promise(() => unloadAgentKeepPlist(DB_PLIST));
            if (!(yield* plistsPresent())) {
                yield* cmdInstall();
            } else {
                yield* Effect.promise(() => loadAgent(DB_PLIST));
                yield* Effect.promise(() => loadAgent(WATCH_PLIST));
                yield* Effect.promise(() => loadAgent(DERIVE_PLIST));
                yield* Effect.promise(() => loadAgent(QUOTA_REFRESH_PLIST));
                yield* Effect.promise(() => loadAgent(SERVE_PLIST));
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
        for (const plist of [SERVE_PLIST, QUOTA_REFRESH_PLIST, DERIVE_PLIST, WATCH_PLIST, DB_PLIST]) {
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
