import { mkdir, writeFile, unlink, symlink, lstat, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
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

const HOME = homedir();
const DATA_DIR = process.env.AX_DATA_DIR ?? join(HOME, ".local", "share", "ax");
const LOG_DIR = join(DATA_DIR, "logs");
const BUCKETS_DIR = join(DATA_DIR, "buckets");
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const BIN_DIR = join(HOME, ".local", "bin");
const VENDOR_BIN_DIR = join(DATA_DIR, "bin");

// Pin to a known-good SurrealDB. Override via env to test newer versions.
const SURREAL_VERSION = process.env.AXCTL_SURREAL_VERSION ?? "3.0.5";

const DB_LABEL = "com.necmttn.ax-db";
const WATCH_LABEL = "com.necmttn.ax-watch";
const DERIVE_LABEL = "com.necmttn.ax-derive-daily";
const DB_PLIST = join(LAUNCH_AGENTS_DIR, `${DB_LABEL}.plist`);
const WATCH_PLIST = join(LAUNCH_AGENTS_DIR, `${WATCH_LABEL}.plist`);
const DERIVE_PLIST = join(LAUNCH_AGENTS_DIR, `${DERIVE_LABEL}.plist`);
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
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
    <string>${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
async function ensureSurreal(): Promise<string> {
    const pinnedSurreal = process.env.AXCTL_SURREAL_PATH;
    if (pinnedSurreal) {
        const v = surrealVersionString(pinnedSurreal);
        if (!v) throw new Error(`AXCTL_SURREAL_PATH is not executable`);
        console.log(`  surreal: pinned ${pinnedSurreal} (${v})`);
        return pinnedSurreal;
    }

    const localBin = join(VENDOR_BIN_DIR, "surreal");

    // Reuse a previously-downloaded vendor binary if it boots - fastest path.
    if (existsSync(localBin)) {
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
        throw new Error(
            `Unsupported platform ${process.platform}/${process.arch}. ` +
                `Install surreal manually: https://surrealdb.com/install`,
        );
    }

    const tag = `v${SURREAL_VERSION}`;
    const url = `https://github.com/surrealdb/surrealdb/releases/download/${tag}/surreal-${tag}.${platform}.tgz`;
    console.log(`  surreal: downloading ${tag} for ${platform}...`);

    await mkdir(VENDOR_BIN_DIR, { recursive: true });
    const tmpTar = join(VENDOR_BIN_DIR, "surreal.tgz");

    const startedAt = Date.now();
    try {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
        }
        const buf = await res.arrayBuffer();
        const sizeMB = (buf.byteLength / (1024 * 1024)).toFixed(1);
        await writeFile(tmpTar, new Uint8Array(buf));

        const ex = spawnSync("tar", ["-xzf", tmpTar, "-C", VENDOR_BIN_DIR], {
            stdio: "inherit",
        });
        if (ex.status !== 0) throw new Error("tar extract failed");
        await chmod(localBin, 0o755);
        await unlink(tmpTar).catch(() => undefined);

        const v = surrealVersionString(localBin);
        if (!v) throw new Error(`downloaded surreal at ${localBin} did not run`);
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`  surreal: installed ${localBin} (${v}) [${sizeMB} MB in ${elapsedSec}s]`);
        return localBin;
    } catch (err) {
        // Offline / GitHub down - fall back to system surreal if present at all.
        const sys = which("surreal");
        if (sys) {
            console.warn(`  surreal: download failed (${(err as Error).message}); falling back to ${sys}`);
            return sys;
        }
        throw err;
    }
}

async function ensureDirs() {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(LOG_DIR, { recursive: true });
    await mkdir(VENDOR_BIN_DIR, { recursive: true });
    await mkdir(join(BUCKETS_DIR, "transcripts"), { recursive: true });
    await mkdir(join(BUCKETS_DIR, "codex_artifacts"), { recursive: true });
    await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
    await mkdir(BIN_DIR, { recursive: true });
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
async function unloadAgent(plistPath: string): Promise<boolean> {
    await unloadAgentKeepPlist(plistPath);
    if (!existsSync(plistPath)) return false;
    try {
        await unlink(plistPath);
        return true;
    } catch {
        return false;
    }
}

async function ensureSymlink(target: string, link: string) {
    try {
        const st = await lstat(link);
        if (st.isSymbolicLink()) await unlink(link);
        else throw new Error(`${link} exists and is not a symlink`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await symlink(target, link);
}

function resolveBinaryPath(): string {
    // When compiled with bun build --compile, process.execPath points at the binary.
    // When run via bun src/cli/index.ts, process.execPath is the bun binary; use argv[1] instead.
    const arg = process.argv[1] ?? "";
    if (arg.endsWith(".ts")) {
        // Dev mode: point at the bin wrapper
        return join(import.meta.dir, "..", "..", "bin", "axctl");
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

function launchdStatus(label: string, plist: string): AgentRuntimeStatus {
    if (!isMacos()) {
        return { label, plist, plistExists: existsSync(plist), loaded: false, pid: null };
    }
    const r = spawnSync("launchctl", ["list", label], { encoding: "utf8" });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const pidMatch = output.match(/"PID"\s*=\s*(\d+);/);
    return {
        label,
        plist,
        plistExists: existsSync(plist),
        loaded: r.status === 0,
        pid: pidMatch ? Number(pidMatch[1]) : null,
    };
}

function collectDaemonEndpoint(): DaemonEndpoint {
    const state = readRuntimeState();
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
}

function collectDaemonStatus(): DaemonStatus {
    const endpoint = collectDaemonEndpoint();
    return {
        platform: process.platform,
        macosLaunchd: isMacos(),
        dataDir: DATA_DIR,
        logDir: LOG_DIR,
        dbListening: endpoint.listening,
        endpoint,
        agents: [
            launchdStatus(DB_LABEL, DB_PLIST),
            launchdStatus(WATCH_LABEL, WATCH_PLIST),
            launchdStatus(DERIVE_LABEL, DERIVE_PLIST),
        ],
    };
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

export function collectDoctorReport(): DoctorReport {
    const binLink = join(BIN_DIR, "axctl");
    const surrealPath = process.env.AXCTL_SURREAL_PATH ?? which("surreal") ?? join(VENDOR_BIN_DIR, "surreal");
    const surrealVersion = existsSync(surrealPath) ? surrealVersionString(surrealPath) : null;
    const daemon = collectDaemonStatus();
    const checks: DoctorCheck[] = [
        {
            name: "platform",
            ok: isMacos(),
            detail: isMacos() ? "macOS launchd supported" : `${process.platform}; daemon install is macOS-only`,
        },
        {
            name: "binary",
            ok: existsSync(binLink),
            detail: existsSync(binLink) ? binLink : `${binLink} missing; run axctl install`,
        },
        {
            name: "data-dir",
            ok: existsSync(DATA_DIR),
            detail: DATA_DIR,
        },
        {
            name: "logs-dir",
            ok: existsSync(LOG_DIR),
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
            ok: existsSync(daemon.endpoint.runtimeStatePath),
            detail: daemon.endpoint.runtimeStatePath,
        },
        ...daemon.agents.map((agent): DoctorCheck => ({
            name: agent.label,
            ok: !isMacos() || (agent.plistExists && agent.loaded),
            detail: `${agent.loaded ? "loaded" : "not loaded"}; plist=${agent.plistExists ? "present" : "absent"}`,
        })),
    ];
    const onboarding = buildOnboardingReport();
    const onboardingChecks: DoctorCheck[] = onboarding.checks.map((c) => ({
        name: `onboarding:${c.id}`,
        ok: c.status === "ok",
        detail: c.recommendation,
    }));
    return { platform: process.platform, checks: [...checks, ...onboardingChecks] };
}

export function formatDoctorReport(report: DoctorReport, json = false): string {
    if (json) return JSON.stringify(report, null, 2);
    const lines = ["axctl doctor"];
    for (const check of report.checks) {
        lines.push(`  ${check.ok ? "ok  " : "warn"} ${check.name}: ${check.detail}`);
    }
    return lines.join("\n");
}

export async function cmdInstall() {
    console.log("[axctl] install");
    await ensureDirs();

    const surrealPath = await ensureSurreal();

    const binSource = resolveBinaryPath();
    const binLink = join(BIN_DIR, "axctl");
    const aliasBinLink = join(BIN_DIR, "ax");
    if (binSource !== binLink) {
        await ensureSymlink(binSource, binLink);
        console.log(`  symlink: ${binLink} → ${binSource}`);
    }
    if (binSource !== aliasBinLink) {
        await ensureSymlink(binSource, aliasBinLink);
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
    writeRuntimeState({ db: { host: DEFAULT_DB_HOST, port: bind.chosen } });
    console.log(`  runtime-state: ${runtimeStatePath()} (db @ ${DEFAULT_DB_HOST}:${bind.chosen})`);

    await writeFile(
        DB_PLIST,
        dbPlist(binSource, surrealPath, { host: DEFAULT_DB_HOST, port: bind.chosen }),
    );
    console.log(`  wrote:  ${DB_PLIST}`);
    await loadAgent(DB_PLIST);

    // Wait for daemon to bind
    for (let i = 0; i < 8; i++) {
        if (probePort(bind.chosen).listening) {
            console.log(`  daemon: listening on ${DEFAULT_DB_HOST}:${bind.chosen}`);
            break;
        }
        await new Promise((res) => setTimeout(res, 500));
    }

    await writeFile(WATCH_PLIST, watchPlist(binSource));
    console.log(`  wrote:  ${WATCH_PLIST}`);
    await loadAgent(WATCH_PLIST);

    await writeFile(DERIVE_PLIST, derivePlist(binSource));
    console.log(`  wrote:  ${DERIVE_PLIST}`);
    await loadAgent(DERIVE_PLIST);

    // Apply schema from embedded resource via surreal import.
    const schemaPath = join(DATA_DIR, ".schema-cache.surql");
    await writeFile(schemaPath, schemaSurql);
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
        console.warn("  schema: apply failed (daemon may not be ready); re-run 'axctl install'");
        if (out) {
            for (const line of out.split("\n")) {
                if (line.trim()) console.warn(`    ${line}`);
            }
        }
    }
    await unlink(schemaPath).catch(() => undefined);

    const { BANNER } = await import("./banner.ts");
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
    console.log(formatInstallOnboardingGuidance(buildOnboardingReport()));

    // Fresh install flows straight into setup (skills + first ingest + doctor).
    console.log();
    await cmdSetup({ fromInstall: true });
}

// ---------------------------------------------------------------------------
// `ax setup` - install the agent skills, run the first ingest, verify.
// Runnable standalone AND auto-invoked at the tail of `ax install`.
// ---------------------------------------------------------------------------

/** Agents ax can install skills for. `dir` is the install-presence probe. */
const SETUP_AGENTS: ReadonlyArray<{ id: string; label: string; dir: string }> = [
    { id: "claude-code", label: "Claude Code", dir: join(HOME, ".claude") },
    { id: "codex", label: "Codex", dir: join(HOME, ".codex") },
    { id: "cursor", label: "Cursor", dir: join(HOME, ".cursor") },
];

export interface SetupOptions {
    /** Explicit agent ids; skips detection/prompt when set. */
    readonly agents?: ReadonlyArray<string>;
    /** Skip the initial `ax ingest`. */
    readonly skipIngest?: boolean;
    /** Non-interactive: take detected defaults, no prompts. */
    readonly yes?: boolean;
    /** Internal: invoked from `cmdInstall` (tweaks headers). */
    readonly fromInstall?: boolean;
    /** Print ONLY the paste-into-your-agent prompt and exit (for copy / install.sh). */
    readonly agentPromptOnly?: boolean;
}

/** Resolve the real binary to re-invoke for the first ingest. */
const selfBin = (): string => {
    const vendored = join(VENDOR_BIN_DIR, "axctl");
    return existsSync(vendored) ? vendored : process.execPath;
};

/** Choose which agents to install skills for. Interactive on a TTY, else the
 *  detected (present-on-disk) set, falling back to claude-code + codex. */
function resolveSetupAgents(opts: SetupOptions): string[] {
    if (opts.agents && opts.agents.length > 0) return [...opts.agents];
    const present = SETUP_AGENTS.filter((a) => existsSync(a.dir));
    const fallback = present.length > 0 ? present.map((a) => a.id) : ["claude-code", "codex"];

    if (opts.yes || !process.stdin.isTTY) return fallback;

    // Interactive: per detected agent, ask yes/no (default = detected).
    const chosen: string[] = [];
    for (const a of SETUP_AGENTS) {
        const detected = existsSync(a.dir);
        const def = detected ? "Y/n" : "y/N";
        const ans = (globalThis.prompt?.(`  install ax skills for ${a.label}? [${def}]`) ?? "").trim().toLowerCase();
        const yes = ans === "" ? detected : ans === "y" || ans === "yes";
        if (yes) chosen.push(a.id);
    }
    return chosen.length > 0 ? chosen : fallback;
}

export async function cmdSetup(opts: SetupOptions = {}) {
    const { AGENT_ONBOARDING_PROMPT, renderAgentOnboarding } = await import("@ax/lib/agent-onboarding");
    if (opts.agentPromptOnly) {
        console.log(AGENT_ONBOARDING_PROMPT);
        return;
    }
    console.log(opts.fromInstall ? "[axctl] setup (skills + first ingest)" : "[axctl] setup");

    const agents = resolveSetupAgents(opts);

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

    // 2. first ingest so the graph is populated immediately.
    if (opts.skipIngest) {
        console.log("  ingest: skipped (--no-ingest)");
    } else {
        console.log("  ingest: running initial backfill...");
        const r = spawnSync(selfBin(), ["ingest"], { stdio: "inherit" });
        if (r.status !== 0) console.log(`  ingest: exited ${r.status ?? "?"} (run 'ax ingest' manually)`);
    }

    // 3. verify.
    console.log();
    await cmdDoctor([]);

    // 4. hand off to the agent for the labeling loop (classify -> fill -> lint).
    console.log();
    console.log(renderAgentOnboarding());
}

export async function cmdDaemon(args: string[]) {
    const parsed = parseDaemonCommand(args);
    if (!isMacos()) {
        console.log(formatDaemonStatus(collectDaemonStatus(), parsed.json));
        if (parsed.command !== "status") {
            console.error("axctl daemon: start/stop/restart use launchd and are macOS-only");
            process.exit(2);
        }
        return;
    }

    if (parsed.command === "start") {
        if (!existsSync(DB_PLIST) || !existsSync(WATCH_PLIST) || !existsSync(DERIVE_PLIST)) {
            await cmdInstall();
        } else {
            await loadAgent(DB_PLIST);
            await loadAgent(WATCH_PLIST);
            await loadAgent(DERIVE_PLIST);
        }
    } else if (parsed.command === "stop") {
        await unloadAgentKeepPlist(DERIVE_PLIST);
        await unloadAgentKeepPlist(WATCH_PLIST);
        await unloadAgentKeepPlist(DB_PLIST);
    } else if (parsed.command === "restart") {
        await unloadAgentKeepPlist(DERIVE_PLIST);
        await unloadAgentKeepPlist(WATCH_PLIST);
        await unloadAgentKeepPlist(DB_PLIST);
        if (!existsSync(DB_PLIST) || !existsSync(WATCH_PLIST) || !existsSync(DERIVE_PLIST)) {
            await cmdInstall();
        } else {
            await loadAgent(DB_PLIST);
            await loadAgent(WATCH_PLIST);
            await loadAgent(DERIVE_PLIST);
        }
    }

    console.log(formatDaemonStatus(collectDaemonStatus(), parsed.json));
}

export async function cmdDoctor(args: string[]) {
    const json = args.includes("--json");
    console.log(formatDoctorReport(collectDoctorReport(), json));
}

export async function cmdUninstall(purge = false) {
    console.log("[axctl] uninstall");
    for (const plist of [DERIVE_PLIST, WATCH_PLIST, DB_PLIST]) {
        const removed = await unloadAgent(plist);
        console.log(`  ${removed ? "removed" : "absent "}: ${plist}`);
    }

    for (const binLink of [join(BIN_DIR, "axctl"), join(BIN_DIR, "ax")]) {
        let symlinkStatus: "removed" | "absent" | "skipped" = "absent";
        try {
            const st = await lstat(binLink);
            if (st.isSymbolicLink()) {
                await unlink(binLink);
                symlinkStatus = "removed";
            } else {
                symlinkStatus = "skipped";
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
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
        await rm(DATA_DIR, { recursive: true, force: true });
        console.log(`  purged data dir: ${DATA_DIR}`);
        console.log();
        console.log("ax fully removed. Thanks for trying it.");
    } else {
        console.log(`Data preserved at ${DATA_DIR}.`);
        console.log("Re-run with --purge (or 'rm -rf' it) for a clean slate.");
    }
}
