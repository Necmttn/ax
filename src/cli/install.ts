import { mkdir, writeFile, unlink, symlink, lstat, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
// Schema is embedded at build time so the compiled binary is self-contained.
import schemaSurql from "../../schema/schema.surql" with { type: "text" };

const HOME = homedir();
const DATA_DIR = process.env.AGENTCTL_DATA_DIR ?? join(HOME, ".local", "share", "agentctl");
const LOG_DIR = join(DATA_DIR, "logs");
const BUCKETS_DIR = join(DATA_DIR, "buckets");
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const BIN_DIR = join(HOME, ".local", "bin");
const VENDOR_BIN_DIR = join(DATA_DIR, "bin");

// Pin to a known-good SurrealDB. Override via env to test newer versions.
const SURREAL_VERSION = process.env.AGENTCTL_SURREAL_VERSION ?? "3.0.5";

const DB_LABEL = "com.necmttn.agentctl-db";
const WATCH_LABEL = "com.necmttn.agentctl-watch";
const DB_PLIST = join(LAUNCH_AGENTS_DIR, `${DB_LABEL}.plist`);
const WATCH_PLIST = join(LAUNCH_AGENTS_DIR, `${WATCH_LABEL}.plist`);

const dbPlist = (_binPath: string, surrealPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DB_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "${surrealPath}" start --user root --pass root --bind 127.0.0.1:8521 --log info --allow-experimental=files "rocksdb://${DATA_DIR}/db"</string>
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
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
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
    <string>${binPath} ingest --since=1 >>${LOG_DIR}/watcher.log 2>&amp;1</string>
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
 * falls back to a pinned download into ~/.local/share/agentctl/bin/surreal.
 * Override via env: AGENTCTL_SURREAL_PATH (explicit path), AGENTCTL_FORCE_DOWNLOAD=1.
 */
async function ensureSurreal(): Promise<string> {
    if (process.env.AGENTCTL_SURREAL_PATH) {
        const v = surrealVersionString(process.env.AGENTCTL_SURREAL_PATH);
        if (!v) throw new Error(`AGENTCTL_SURREAL_PATH is not executable`);
        console.log(`  surreal: pinned ${process.env.AGENTCTL_SURREAL_PATH} (${v})`);
        return process.env.AGENTCTL_SURREAL_PATH;
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
    if (!process.env.AGENTCTL_FORCE_DOWNLOAD) {
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
        return join(import.meta.dir, "..", "..", "bin", "agentctl");
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

export interface DaemonStatus {
    readonly platform: NodeJS.Platform;
    readonly macosLaunchd: boolean;
    readonly dataDir: string;
    readonly logDir: string;
    readonly dbListening: boolean;
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
            `agentctl daemon: unknown command "${command}" (expected status, start, stop, or restart)`,
        );
    }
    return { command: command as DaemonCommand, json };
}

function isMacos(): boolean {
    return process.platform === "darwin";
}

function isDbListening(): boolean {
    const r = spawnSync("lsof", ["-iTCP:8521", "-sTCP:LISTEN", "-nP"], { stdio: "ignore" });
    return r.status === 0;
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

function collectDaemonStatus(): DaemonStatus {
    return {
        platform: process.platform,
        macosLaunchd: isMacos(),
        dataDir: DATA_DIR,
        logDir: LOG_DIR,
        dbListening: isDbListening(),
        agents: [
            launchdStatus(DB_LABEL, DB_PLIST),
            launchdStatus(WATCH_LABEL, WATCH_PLIST),
        ],
    };
}

export function formatDaemonStatus(status: DaemonStatus, json = false): string {
    if (json) return JSON.stringify(status, null, 2);
    const lines = [
        "agentctl daemon",
        `  platform: ${status.platform}${status.macosLaunchd ? "" : " (launchd unavailable)"}`,
        `  database: ${status.dbListening ? "listening on 127.0.0.1:8521" : "not listening on 127.0.0.1:8521"}`,
        `  data: ${status.dataDir}`,
        `  logs: ${status.logDir}`,
    ];
    for (const agent of status.agents) {
        const runtime = agent.loaded
            ? `loaded${agent.pid === null ? "" : ` pid=${agent.pid}`}`
            : "not loaded";
        lines.push(`  ${agent.label}: ${runtime}; plist=${agent.plistExists ? "present" : "absent"}`);
    }
    return lines.join("\n");
}

function collectDoctorReport(): DoctorReport {
    const binLink = join(BIN_DIR, "agentctl");
    const surrealPath = process.env.AGENTCTL_SURREAL_PATH ?? which("surreal") ?? join(VENDOR_BIN_DIR, "surreal");
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
            detail: existsSync(binLink) ? binLink : `${binLink} missing; run agentctl install`,
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
            ok: daemon.dbListening,
            detail: daemon.dbListening ? "127.0.0.1:8521 is listening" : "127.0.0.1:8521 is not listening",
        },
        ...daemon.agents.map((agent): DoctorCheck => ({
            name: agent.label,
            ok: !isMacos() || (agent.plistExists && agent.loaded),
            detail: `${agent.loaded ? "loaded" : "not loaded"}; plist=${agent.plistExists ? "present" : "absent"}`,
        })),
    ];
    return { platform: process.platform, checks };
}

export function formatDoctorReport(report: DoctorReport, json = false): string {
    if (json) return JSON.stringify(report, null, 2);
    const lines = ["agentctl doctor"];
    for (const check of report.checks) {
        lines.push(`  ${check.ok ? "ok  " : "warn"} ${check.name}: ${check.detail}`);
    }
    return lines.join("\n");
}

export async function cmdInstall() {
    console.log("[agentctl] install");
    await ensureDirs();

    const surrealPath = await ensureSurreal();

    const binSource = resolveBinaryPath();
    const binLink = join(BIN_DIR, "agentctl");
    if (binSource !== binLink) {
        await ensureSymlink(binSource, binLink);
        console.log(`  symlink: ${binLink} → ${binSource}`);
    }

    await writeFile(DB_PLIST, dbPlist(binSource, surrealPath));
    console.log(`  wrote:  ${DB_PLIST}`);
    await loadAgent(DB_PLIST);

    // Wait for daemon to bind
    for (let i = 0; i < 8; i++) {
        const r = spawnSync("lsof", ["-iTCP:8521", "-sTCP:LISTEN", "-nP"], { stdio: "ignore" });
        if (r.status === 0) {
            console.log("  daemon: listening on 127.0.0.1:8521");
            break;
        }
        await new Promise((res) => setTimeout(res, 500));
    }

    await writeFile(WATCH_PLIST, watchPlist(binSource));
    console.log(`  wrote:  ${WATCH_PLIST}`);
    await loadAgent(WATCH_PLIST);

    // Apply schema from embedded resource via surreal import.
    const schemaPath = join(DATA_DIR, ".schema-cache.surql");
    await writeFile(schemaPath, schemaSurql);
    const r = spawnSync(
        surrealPath,
        [
            "import",
            "--endpoint",
            "http://127.0.0.1:8521",
            "--user",
            "root",
            "--pass",
            "root",
            "--ns",
            "agentctl",
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
        console.warn("  schema: apply failed (daemon may not be ready); re-run 'agentctl install'");
        if (out) {
            for (const line of out.split("\n")) {
                if (line.trim()) console.warn(`    ${line}`);
            }
        }
    }
    await unlink(schemaPath).catch(() => undefined);

    console.log();
    console.log("Installed. Try:");
    console.log("  agentctl ingest          # initial fill");
    console.log("  agentctl tui             # interactive dashboard");
    console.log("  launchctl list | grep agentctl   # verify both LaunchAgents loaded");
}

export async function cmdDaemon(args: string[]) {
    const parsed = parseDaemonCommand(args);
    if (!isMacos()) {
        console.log(formatDaemonStatus(collectDaemonStatus(), parsed.json));
        if (parsed.command !== "status") {
            console.error("agentctl daemon: start/stop/restart use launchd and are macOS-only");
            process.exit(2);
        }
        return;
    }

    if (parsed.command === "start") {
        if (!existsSync(DB_PLIST) || !existsSync(WATCH_PLIST)) {
            await cmdInstall();
        } else {
            await loadAgent(DB_PLIST);
            await loadAgent(WATCH_PLIST);
        }
    } else if (parsed.command === "stop") {
        await unloadAgentKeepPlist(WATCH_PLIST);
        await unloadAgentKeepPlist(DB_PLIST);
    } else if (parsed.command === "restart") {
        await unloadAgentKeepPlist(WATCH_PLIST);
        await unloadAgentKeepPlist(DB_PLIST);
        if (!existsSync(DB_PLIST) || !existsSync(WATCH_PLIST)) {
            await cmdInstall();
        } else {
            await loadAgent(DB_PLIST);
            await loadAgent(WATCH_PLIST);
        }
    }

    console.log(formatDaemonStatus(collectDaemonStatus(), parsed.json));
}

export async function cmdDoctor(args: string[]) {
    const json = args.includes("--json");
    console.log(formatDoctorReport(collectDoctorReport(), json));
}

export async function cmdUninstall() {
    console.log("[agentctl] uninstall");
    for (const plist of [WATCH_PLIST, DB_PLIST]) {
        const removed = await unloadAgent(plist);
        console.log(`  ${removed ? "removed" : "absent "}: ${plist}`);
    }

    const binLink = join(BIN_DIR, "agentctl");
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

    console.log();
    console.log(`Data preserved at ${DATA_DIR}. Delete manually if you want a clean slate.`);
}
