import { mkdir, writeFile, unlink, symlink, lstat } from "node:fs/promises";
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

const DB_LABEL = "com.necmttn.agentctl-db";
const WATCH_LABEL = "com.necmttn.agentctl-watch";
const DB_PLIST = join(LAUNCH_AGENTS_DIR, `${DB_LABEL}.plist`);
const WATCH_PLIST = join(LAUNCH_AGENTS_DIR, `${WATCH_LABEL}.plist`);

const dbPlist = (binPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DB_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec surreal start --user root --pass root --bind 127.0.0.1:8521 --log info --allow-experimental=files "rocksdb://${DATA_DIR}/db"</string>
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

async function ensureDirs() {
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(LOG_DIR, { recursive: true });
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

async function unloadAgent(plistPath: string) {
    try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
        // ok
    }
    try {
        await unlink(plistPath);
    } catch {
        // ok
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

export async function cmdInstall() {
    console.log("[agentctl] install");
    await ensureDirs();

    if (!which("surreal")) {
        console.error("ERROR: 'surreal' CLI not on PATH. Install: brew install surrealdb/tap/surreal");
        process.exit(1);
    }

    const binSource = resolveBinaryPath();
    const binLink = join(BIN_DIR, "agentctl");
    if (binSource !== binLink) {
        await ensureSymlink(binSource, binLink);
        console.log(`  symlink: ${binLink} → ${binSource}`);
    }

    await writeFile(DB_PLIST, dbPlist(binSource));
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
        "surreal",
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
        { stdio: "inherit" },
    );
    if (r.status === 0) {
        console.log("  schema: applied");
    } else {
        console.warn("  schema: apply failed (daemon may not be ready); re-run 'agentctl install'");
    }
    await unlink(schemaPath).catch(() => undefined);

    console.log();
    console.log("Installed. Try:");
    console.log("  agentctl ingest          # initial fill");
    console.log("  agentctl tui             # interactive dashboard");
    console.log("  launchctl list | grep agentctl   # verify both LaunchAgents loaded");
}

export async function cmdUninstall() {
    console.log("[agentctl] uninstall");
    await unloadAgent(WATCH_PLIST);
    console.log(`  removed: ${WATCH_PLIST}`);
    await unloadAgent(DB_PLIST);
    console.log(`  removed: ${DB_PLIST}`);

    const binLink = join(BIN_DIR, "agentctl");
    try {
        const st = await lstat(binLink);
        if (st.isSymbolicLink()) {
            await unlink(binLink);
            console.log(`  removed symlink: ${binLink}`);
        }
    } catch {
        // ok
    }

    console.log();
    console.log(`Data preserved at ${DATA_DIR}. Delete manually if you want a clean slate.`);
}
