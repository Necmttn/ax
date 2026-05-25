import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ServerWebSocket } from "bun";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { recordRef } from "../ingest/evidence-writers.ts";
import { surrealJson, surrealString } from "../lib/shared/surql.ts";

export type DogfoodScenario = "axctl-setup" | "interactive";
export type DogfoodTransport = "auto" | "pty" | "process";
export type DogfoodAgent = "shell" | "claude" | "codex" | "opencode";
type EffectiveDogfoodTransport = "pty" | "process";
type DogfoodStatus = "passed" | "failed" | "completed" | "timed_out";

export interface DogfoodTerminalArgs {
    readonly scenario: DogfoodScenario;
    readonly port: number;
    readonly json: boolean;
    readonly transport: DogfoodTransport;
    readonly agent?: DogfoodAgent;
    readonly command?: string;
    readonly successMarker?: string;
    readonly timeoutSeconds?: number;
}

export interface DogfoodTerminalServer {
    readonly url: string;
    readonly port: number;
    readonly scenario: DogfoodScenario;
    readonly transport: EffectiveDogfoodTransport;
    readonly requestedTransport: DogfoodTransport;
    readonly transportFallbackReason?: string;
    readonly stop: () => void;
}

interface DogfoodResult {
    readonly runId: string;
    readonly scenario: DogfoodScenario;
    readonly status: DogfoodStatus;
    readonly transcript: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly cwd: string;
    readonly markerFound: boolean;
    readonly persisted: boolean;
    readonly transport: EffectiveDogfoodTransport;
    readonly requestedTransport: DogfoodTransport;
    readonly agent?: DogfoodAgent;
    readonly command: string;
    readonly commandSource: "preset" | "override";
    readonly successMarker?: string;
    readonly timedOut: boolean;
    readonly timeoutSeconds?: number;
    readonly transportFallbackReason?: string;
}

export interface DogfoodTerminalSession {
    readonly title: string;
    readonly cwd: string;
    readonly command: string;
    readonly commandSource: "preset" | "override";
    readonly agent?: DogfoodAgent;
    readonly env: Record<string, string>;
    readonly successMarker?: string;
}

export interface DogfoodOutcome {
    readonly status: DogfoodStatus;
    readonly markerFound: boolean;
}

export interface DogfoodAgentPreset {
    readonly agent: DogfoodAgent;
    readonly command: string;
    readonly title: string;
}

const DEFAULT_PORT = 1742;
const SUCCESS_MARKER = "AXCTL_DOGFOOD_SETUP_OK";

const sqlString = surrealString;
const sqlJson = surrealJson;
const sqlObject = (fields: readonly (readonly [string, string])[]): string =>
    `{ ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

function shortHash(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

function repoRoot(): string {
    if (process.env.AX_REPO_ROOT) return process.env.AX_REPO_ROOT;
    if (existsSync(join(process.cwd(), "package.json")) && existsSync(join(process.cwd(), "node_modules"))) {
        return process.cwd();
    }
    return join(import.meta.dir, "..", "..");
}

function currentAxctlPath(root: string): string {
    if (!process.argv[1]?.endsWith(".ts") && existsSync(process.execPath)) {
        return process.execPath;
    }
    if (existsSync(join(root, "dist", "axctl"))) return join(root, "dist", "axctl");
    return join(root, "bin", "axctl");
}

export function parseDogfoodTerminalArgs(args: readonly string[]): DogfoodTerminalArgs {
    const flag = (name: string): string | undefined => {
        const found = args.find((arg) => arg.startsWith(`--${name}=`));
        return found?.slice(name.length + 3);
    };
    const scenario = flag("scenario") ?? "axctl-setup";
    if (scenario !== "axctl-setup" && scenario !== "interactive") {
        throw new Error(`unknown dogfood scenario "${scenario}"`);
    }
    const rawPort = flag("port");
    const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port must be a valid TCP port (got "${rawPort}")`);
    }
    const transport = flag("transport") ?? "auto";
    if (transport !== "auto" && transport !== "pty" && transport !== "process") {
        throw new Error(`unknown dogfood transport "${transport}"`);
    }
    const agent = flag("agent");
    if (
        agent !== undefined
        && agent !== "shell"
        && agent !== "claude"
        && agent !== "codex"
        && agent !== "opencode"
    ) {
        throw new Error(`unknown dogfood agent "${agent}"`);
    }
    const command = flag("command");
    const successMarker = flag("success-marker");
    const rawTimeout = flag("timeout");
    const timeoutSeconds = rawTimeout === undefined ? undefined : Number(rawTimeout);
    if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
        throw new Error(`--timeout must be a positive integer number of seconds (got "${rawTimeout}")`);
    }
    return {
        scenario,
        port,
        json: args.includes("--json"),
        transport,
        ...(agent !== undefined ? { agent } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(successMarker !== undefined ? { successMarker } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };
}

export function dogfoodStatusForTranscript(input: {
    readonly transcript: string;
    readonly successMarker?: string;
    readonly timedOut: boolean;
}): DogfoodOutcome {
    const markerFound = input.successMarker ? input.transcript.includes(input.successMarker) : false;
    if (input.timedOut) return { status: "timed_out", markerFound };
    if (input.successMarker) return { status: markerFound ? "passed" : "failed", markerFound };
    return { status: "completed", markerFound };
}

export function resolveDogfoodAgentPreset(agent: DogfoodAgent = "shell"): DogfoodAgentPreset {
    switch (agent) {
        case "claude":
            return { agent, command: "claude", title: "Claude Code dogfood" };
        case "codex":
            return { agent, command: "codex", title: "Codex dogfood" };
        case "opencode":
            return { agent, command: "opencode", title: "OpenCode dogfood" };
        case "shell":
            return { agent, command: "bash -l", title: "interactive terminal" };
    }
}

export async function createAxctlSetupDemoScript(root = repoRoot()): Promise<DogfoodTerminalSession> {
    const workRoot = await mkdtemp(join(tmpdir(), "axctl-wterm-dogfood-"));
    const home = join(workRoot, "home");
    const scratch = join(workRoot, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    for (const dir of [".claude", ".codex", ".agents"]) {
        await mkdir(join(home, dir), { recursive: true });
    }

    const axctl = currentAxctlPath(root);

    const lines = [
        "set -euo pipefail",
        "clear",
        "printf '\\033[1;36maxctl wterm dogfood: fresh setup demo\\033[0m\\r\\n'",
        `printf 'repo: %s\\r\\n' ${JSON.stringify(root)}`,
        `printf 'scratch home: %s\\r\\n\\r\\n' ${JSON.stringify(home)}`,
        "printf '$ axctl --help\\r\\n'",
        `${JSON.stringify(axctl)} --help | sed -n '1,18p'`,
        "printf '\\r\\n$ HOME=<scratch> axctl doctor --json\\r\\n'",
        `HOME=${JSON.stringify(home)} ${JSON.stringify(axctl)} doctor --json`,
        "printf '\\r\\n$ host agent tracks harness dirs in git\\r\\n'",
        `for d in ${JSON.stringify(join(home, ".claude"))} ${JSON.stringify(join(home, ".codex"))} ${JSON.stringify(join(home, ".agents"))}; do`,
        "  git -C \"$d\" init -q",
        "  cat >\"$d/.gitignore\" <<'EOF'",
        "projects/",
        "sessions/",
        "logs/",
        "cache/",
        "node_modules/",
        "*.log",
        ".env*",
        "EOF",
        "  printf '# tracked harness baseline\\n' >\"$d/README.md\"",
        "  git -C \"$d\" add .gitignore README.md",
        "  git -C \"$d\" -c user.name='axctl dogfood' -c user.email='dogfood@example.invalid' commit -qm 'chore: track agent harness'",
        "done",
        "printf '\\r\\n$ HOME=<scratch> axctl doctor --json\\r\\n'",
        `HOME=${JSON.stringify(home)} ${JSON.stringify(axctl)} doctor --json`,
        `printf '\\r\\n%s\\r\\n' ${JSON.stringify(SUCCESS_MARKER)}`,
        "printf '\\r\\nDogfood complete. Transcript will be saved as evidence if the ax DB is reachable.\\r\\n'",
    ];

    return {
        title: "axctl setup demo",
        cwd: scratch,
        command: lines.join("\n"),
        commandSource: "preset",
        agent: "shell",
        env: {
            HOME: home,
            CI: "1",
        },
        successMarker: SUCCESS_MARKER,
    };
}

export async function createInteractiveDogfoodSession(options: {
    readonly agent?: DogfoodAgent;
    readonly command?: string;
    readonly successMarker?: string;
}): Promise<DogfoodTerminalSession> {
    const workRoot = await mkdtemp(join(tmpdir(), "axctl-wterm-dogfood-"));
    const home = join(workRoot, "home");
    const scratch = join(workRoot, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    for (const dir of [".claude", ".codex", ".agents"]) {
        await mkdir(join(home, dir), { recursive: true });
    }
    const preset = resolveDogfoodAgentPreset(options.agent ?? "shell");
    const command = options.command?.trim();
    return {
        title: preset.title,
        cwd: scratch,
        command: command || preset.command,
        commandSource: command ? "override" : "preset",
        agent: preset.agent,
        env: {
            HOME: home,
        },
        ...(options.successMarker ? { successMarker: options.successMarker } : {}),
    };
}

async function createDogfoodSession(args: DogfoodTerminalArgs, root: string): Promise<DogfoodTerminalSession> {
    if (args.scenario === "interactive") {
        return createInteractiveDogfoodSession({
            ...(args.agent ? { agent: args.agent } : {}),
            ...(args.command ? { command: args.command } : {}),
            ...(args.successMarker ? { successMarker: args.successMarker } : {}),
        });
    }
    return createAxctlSetupDemoScript(root);
}

export function dogfoodHtml(
    transport: DogfoodTransport | EffectiveDogfoodTransport = "auto",
    title = "axctl dogfood terminal",
): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>axctl wterm dogfood</title>
  <link rel="stylesheet" href="/vendor/wterm.css" />
  <style>
    html, body { height: 100%; margin: 0; background: #0b0d12; color: #d8dee9; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { display: grid; grid-template-rows: auto 1fr auto; }
    header, footer { padding: 12px 16px; border-color: #252a36; border-style: solid; border-width: 0 0 1px; background: #11151f; }
    footer { border-width: 1px 0 0; font-size: 13px; color: #9aa4b2; }
    h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: 0; }
    main { min-height: 0; padding: 12px; }
    #terminal { height: 100%; border: 1px solid #2a3140; border-radius: 8px; background: #05070b; overflow: auto; }
    #status { color: #9aa4b2; margin-left: 12px; font-size: 13px; }
  </style>
</head>
<body>
  <header><h1>${title} <span id="status">connecting</span></h1></header>
  <main><div id="terminal" aria-label="axctl dogfood terminal"></div></main>
  <footer>Scenario: fresh setup in a scratch HOME. Transport: ${transport}. No launchd or real global config mutation.</footer>
  <script type="importmap">
    {
      "imports": {
        "@wterm/dom": "/vendor/@wterm/dom/index.js",
        "@wterm/core": "/vendor/@wterm/core/index.js"
      }
    }
  </script>
  <script type="module" src="/client.js"></script>
</body>
</html>`;
}

export function dogfoodClientJs(): string {
    return `import { WTerm, WebSocketTransport } from "@wterm/dom";

const terminalEl = document.getElementById("terminal");
const statusEl = document.getElementById("status");
const term = new WTerm(terminalEl, { cols: 100, rows: 30, autoResize: false });
await term.init();

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const transport = new WebSocketTransport({
  url: protocol + "//" + location.host + "/api/terminal",
  reconnect: false,
  onOpen: () => {
    statusEl.textContent = "running";
    transport.send("\\x1b[RESIZE:100;30]");
  },
  onData: (data) => term.write(data),
  onClose: () => {
    statusEl.textContent = "complete";
    fetch("/api/result").then((res) => res.json()).then((result) => {
      window.__axctlDogfoodResult = result;
      window.dispatchEvent(new CustomEvent("axctl-dogfood-complete", { detail: result }));
    }).catch(() => undefined);
  },
  onError: () => {
    statusEl.textContent = "error";
  },
});

term.onData = (data) => transport.send(data);
transport.connect();
window.__wterm = term;
window.__axctlDogfood = { term, transport };
`;
}

async function persistDogfoodResult(result: DogfoodResult): Promise<boolean> {
    const scenarioKey = result.scenario.replaceAll("-", "_");
    const transcriptKey = `dogfood_wterm_${scenarioKey}__${result.runId}__transcript`;
    const runKey = `wterm_${scenarioKey}__${result.runId}`;
    const artifactRef = recordRef("artifact", transcriptKey);
    const runRef = recordRef("dogfood_run", runKey);
    // Phase C12: dogfood_run is the proper home for test-scenario results.
    // Replaces the intervention_observation overload from before A7.
    const statements = [
        `UPSERT ${artifactRef} MERGE ${sqlObject([
            ["kind", sqlString("dogfood_wterm_transcript")],
            ["title", sqlString(`wterm ${result.scenario} dogfood transcript`)],
            ["uri", sqlString(`dogfood://wterm/${result.runId}/transcript`)],
            ["path", "NONE"],
            ["content_hash", sqlString(shortHash(result.transcript))],
            ["raw", sqlJson({
                scenario: result.scenario,
                transcript: result.transcript,
                started_at: result.startedAt,
                ended_at: result.endedAt,
                cwd: result.cwd,
                command: result.command,
                command_source: result.commandSource,
                success_marker: result.successMarker,
                timed_out: result.timedOut,
                timeout_seconds: result.timeoutSeconds,
                agent: result.agent,
                transport: result.transport,
                requested_transport: result.requestedTransport,
            })],
            ["updated_at", "time::now()"],
        ])};`,
        `UPSERT ${runRef} MERGE ${sqlObject([
            ["run_id", sqlString(result.runId)],
            ["scenario", sqlString(result.scenario)],
            ["driver", sqlString("wterm")],
            ["status", sqlString(result.status)],
            ["agent", result.agent ? sqlString(result.agent) : "NONE"],
            ["command", sqlString(result.command)],
            ["command_source", sqlString(result.commandSource)],
            ["transport", sqlString(result.transport)],
            ["requested_transport", sqlString(result.requestedTransport)],
            ["transport_fallback_reason", result.transportFallbackReason ? sqlString(result.transportFallbackReason) : "NONE"],
            ["success_marker", result.successMarker ? sqlString(result.successMarker) : "NONE"],
            ["marker_found", result.markerFound ? "true" : "false"],
            ["timed_out", result.timedOut ? "true" : "false"],
            ["timeout_seconds", String(result.timeoutSeconds)],
            ["transcript_artifact", artifactRef],
            ["cwd", sqlString(result.cwd)],
            ["started_at", `d${JSON.stringify(result.startedAt)}`],
            ["ended_at", `d${JSON.stringify(result.endedAt)}`],
        ])};`,
    ];

    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(statements.join(""));
            }).pipe(Effect.provide(AppLayer), Effect.scoped),
        );
        return true;
    } catch {
        return false;
    }
}

async function ensureNodePtySpawnHelperExecutable(root: string): Promise<void> {
    const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    const helper = join(root, "node_modules", "node-pty", "prebuilds", arch, "spawn-helper");
    if (!existsSync(helper)) return;
    await chmod(helper, 0o755);
}

function ptySidecarPath(root: string): string {
    return join(root, "src", "dogfood", "pty-sidecar.mjs");
}

async function canUsePtyTransport(root: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    if (!existsSync(join(root, "node_modules", "node-pty"))) {
        return { ok: false, reason: "node-pty is not installed" };
    }
    if (!existsSync(ptySidecarPath(root))) {
        return { ok: false, reason: "PTY sidecar script is missing" };
    }
    if (Bun.which("node") === null) {
        return { ok: false, reason: "node is not on PATH" };
    }
    await ensureNodePtySpawnHelperExecutable(root);
    return { ok: true };
}

async function resolveEffectiveTransport(
    requested: DogfoodTransport,
    root: string,
): Promise<{
    readonly transport: EffectiveDogfoodTransport;
    readonly fallbackReason?: string;
}> {
    if (requested === "process") return { transport: "process" };
    const pty = await canUsePtyTransport(root);
    if (pty.ok) return { transport: "pty" };
    if (requested === "pty") {
        throw new Error(`PTY transport unavailable: ${pty.reason ?? "unknown reason"}`);
    }
    return { transport: "process", fallbackReason: pty.reason ?? "PTY transport unavailable" };
}

async function serveNodeModuleFile(pathname: string): Promise<Response | null> {
    const mappings: Record<string, string> = {
        "/vendor/@wterm/dom/index.js": join(repoRoot(), "node_modules", "@wterm", "dom", "dist", "index.js"),
        "/vendor/@wterm/dom/wterm.js": join(repoRoot(), "node_modules", "@wterm", "dom", "dist", "wterm.js"),
        "/vendor/@wterm/dom/renderer.js": join(repoRoot(), "node_modules", "@wterm", "dom", "dist", "renderer.js"),
        "/vendor/@wterm/dom/input.js": join(repoRoot(), "node_modules", "@wterm", "dom", "dist", "input.js"),
        "/vendor/@wterm/dom/debug.js": join(repoRoot(), "node_modules", "@wterm", "dom", "dist", "debug.js"),
        "/vendor/@wterm/core/index.js": join(repoRoot(), "node_modules", "@wterm", "core", "dist", "index.js"),
        "/vendor/@wterm/core/terminal-core.js": join(repoRoot(), "node_modules", "@wterm", "core", "dist", "terminal-core.js"),
        "/vendor/@wterm/core/wasm-bridge.js": join(repoRoot(), "node_modules", "@wterm", "core", "dist", "wasm-bridge.js"),
        "/vendor/@wterm/core/wasm-inline.js": join(repoRoot(), "node_modules", "@wterm", "core", "dist", "wasm-inline.js"),
        "/vendor/@wterm/core/transport.js": join(repoRoot(), "node_modules", "@wterm", "core", "dist", "transport.js"),
        "/vendor/wterm.css": join(repoRoot(), "node_modules", "@wterm", "dom", "src", "terminal.css"),
    };
    const filePath = mappings[pathname];
    if (!filePath) return null;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("missing vendor file", { status: 404 });
    const contentType = pathname.endsWith(".css") ? "text/css" : "text/javascript";
    return new Response(file, { headers: { "content-type": contentType } });
}

export async function startWtermDogfoodServer(
    args: DogfoodTerminalArgs,
): Promise<DogfoodTerminalServer> {
    const root = repoRoot();
    const effective = await resolveEffectiveTransport(args.transport, root);
    if (args.scenario === "interactive" && effective.transport !== "pty") {
        throw new Error("interactive dogfood requires PTY transport; install node-pty/node or use axctl-setup");
    }
    const runId = shortHash(`${Date.now()}|${Math.random()}`);
    const startedAt = new Date().toISOString();
    const scenario = await createDogfoodSession(args, root);
    let transcript = "";
    let result: DogfoodResult | null = null;
    let childProcess: ReturnType<typeof Bun.spawn> | null = null;
    let sessionStarted = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = async () => {
        if (result !== null) return;
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
        const endedAt = new Date().toISOString();
        const outcome = dogfoodStatusForTranscript({
            transcript,
            timedOut,
            ...(scenario.successMarker ? { successMarker: scenario.successMarker } : {}),
        });
        const base: DogfoodResult = {
            runId,
            scenario: args.scenario,
            status: outcome.status,
            transcript,
            startedAt,
            endedAt,
            cwd: scenario.cwd,
            markerFound: outcome.markerFound,
            persisted: false,
            transport: effective.transport,
            requestedTransport: args.transport,
            command: scenario.command,
            commandSource: scenario.commandSource,
            timedOut,
            ...(scenario.successMarker ? { successMarker: scenario.successMarker } : {}),
            ...(args.timeoutSeconds ? { timeoutSeconds: args.timeoutSeconds } : {}),
            ...(scenario.agent ? { agent: scenario.agent } : {}),
            ...(effective.fallbackReason ? { transportFallbackReason: effective.fallbackReason } : {}),
        };
        const persisted = await persistDogfoodResult(base);
        result = { ...base, persisted };
    };

    const appendOutput = (ws: ServerWebSocket<unknown>, data: string) => {
        transcript += data;
        ws.send(data);
    };

    const killChild = () => {
        if (childProcess) {
            const current = childProcess;
            childProcess = null;
            try {
                current.kill();
            } catch {
                // Already exited.
            }
        }
    };

    const startTimeout = (ws: ServerWebSocket<unknown>) => {
        if (!args.timeoutSeconds) return;
        timeout = setTimeout(() => {
            timedOut = true;
            appendOutput(ws, `\r\naxctl dogfood timed out after ${args.timeoutSeconds}s\r\n`);
            killChild();
            finish()
                .catch(() => undefined)
                .finally(() => ws.close());
        }, args.timeoutSeconds * 1000);
    };

    const spawnProcessTransport = (ws: ServerWebSocket<unknown>) => {
        childProcess = Bun.spawn(["bash", "-lc", scenario.command], {
            cwd: scenario.cwd,
            env: {
                PATH: process.env.PATH ?? "",
                TERM: "xterm-256color",
                ...scenario.env,
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const pump = async (stream: unknown) => {
            if (!(stream instanceof ReadableStream)) return;
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                appendOutput(ws, decoder.decode(chunk.value));
            }
        };
        Promise.all([pump(childProcess.stdout), pump(childProcess.stderr)])
            .then(() => childProcess?.exited)
            .then(() => {
                childProcess = null;
                return finish();
            })
            .finally(() => ws.close());
    };

    const writeSidecarMessage = (message: unknown) => {
        if (!childProcess?.stdin) return;
        if (typeof childProcess.stdin === "number") return;
        childProcess.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const spawnPtyTransport = (ws: ServerWebSocket<unknown>) => {
        childProcess = Bun.spawn([
            "node",
            ptySidecarPath(root),
            JSON.stringify({
                command: scenario.command,
                cwd: scenario.cwd,
                root,
                cols: 100,
                rows: 30,
                env: scenario.env,
            }),
        ], {
            cwd: scenario.cwd,
            env: {
                PATH: process.env.PATH ?? "",
                TERM: "xterm-256color",
                AX_REPO_ROOT: root,
                ...scenario.env,
            },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        const pumpJsonLines = async (stream: unknown, fallbackPrefix = "") => {
            if (!(stream instanceof ReadableStream)) return;
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value);
                let index = buffer.indexOf("\n");
                while (index >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    if (line.length > 0) {
                        try {
                            const event = JSON.parse(line) as { type?: string; data?: string; message?: string };
                            if (event.type === "data" && event.data) {
                                appendOutput(ws, Buffer.from(event.data, "base64").toString("utf8"));
                            } else if (event.type === "error" && event.message) {
                                appendOutput(ws, `\r\n${event.message}\r\n`);
                            }
                        } catch {
                            appendOutput(ws, `${fallbackPrefix}${line}\r\n`);
                        }
                    }
                    index = buffer.indexOf("\n");
                }
            }
            if (buffer.length > 0) appendOutput(ws, `${fallbackPrefix}${buffer}\r\n`);
        };
        Promise.all([pumpJsonLines(childProcess.stdout), pumpJsonLines(childProcess.stderr, "pty sidecar: ")])
            .then(() => childProcess?.exited)
            .then(() => {
                childProcess = null;
                return finish();
            })
            .finally(() => ws.close());
    };

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: args.port,
        websocket: {
            open(ws) {
                if (sessionStarted) {
                    ws.send("\r\nOnly one dogfood terminal may run per server.\r\n");
                    ws.close();
                    return;
                }
                sessionStarted = true;
                startTimeout(ws);
                if (effective.transport === "pty") {
                    spawnPtyTransport(ws);
                } else {
                    spawnProcessTransport(ws);
                }
            },
            message(_ws, message) {
                const input = typeof message === "string"
                    ? message
                    : Buffer.from(message).toString("utf8");
                if (input.startsWith("\x1b[RESIZE:")) {
                    const match = input.match(/\x1b\[RESIZE:(\d+);(\d+)\]/);
                    if (effective.transport === "pty" && match) {
                        writeSidecarMessage({
                            type: "resize",
                            cols: Number(match[1]),
                            rows: Number(match[2]),
                        });
                    }
                    return;
                }
                if (effective.transport === "pty") {
                    writeSidecarMessage({
                        type: "input",
                        data: Buffer.from(input).toString("base64"),
                    });
                }
            },
            close() {
                killChild();
                finish().catch(() => undefined);
            },
        },
        async fetch(req, server) {
            const url = new URL(req.url);
            if (url.pathname === "/api/terminal") {
                if (server.upgrade(req)) return undefined;
                return new Response("upgrade failed", { status: 400 });
            }
            if (url.pathname === "/api/result") {
                if (result === null) {
                    return Response.json({
                        runId,
                        scenario: args.scenario,
                        status: "running",
                        transcriptBytes: transcript.length,
                        startedAt,
                        cwd: scenario.cwd,
                        command: scenario.command,
                        agent: scenario.agent,
                        commandSource: scenario.commandSource,
                        successMarker: scenario.successMarker,
                        timeoutSeconds: args.timeoutSeconds,
                    });
                }
                return Response.json(result);
            }
            if (url.pathname === "/api/transcript") {
                return new Response(transcript, { headers: { "content-type": "text/plain; charset=utf-8" } });
            }
            if (url.pathname === "/client.js") {
                return new Response(dogfoodClientJs(), { headers: { "content-type": "text/javascript" } });
            }
            const vendor = await serveNodeModuleFile(url.pathname);
            if (vendor) return vendor;
            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(dogfoodHtml(effective.transport, scenario.title), {
                    headers: { "content-type": "text/html; charset=utf-8" },
                });
            }
            return new Response("not found", { status: 404 });
        },
    });

    const port = server.port ?? args.port;
    const url = `http://127.0.0.1:${port}/`;
    return {
        url,
        port,
        scenario: args.scenario,
        transport: effective.transport,
        requestedTransport: args.transport,
        ...(effective.fallbackReason ? { transportFallbackReason: effective.fallbackReason } : {}),
        stop: () => server.stop(true),
    };
}

export async function cmdDogfoodTerminal(rawArgs: readonly string[]): Promise<void> {
    const args = parseDogfoodTerminalArgs(rawArgs);
    const server = await startWtermDogfoodServer(args);
    if (args.json) {
        console.log(JSON.stringify({
            kind: "axctl.dogfood.terminal",
            scenario: server.scenario,
            transport: server.transport,
            requestedTransport: server.requestedTransport,
            transportFallbackReason: server.transportFallbackReason,
            url: server.url,
            port: server.port,
        }, null, 2));
    } else {
        console.log(`axctl dogfood terminal: ${server.url}`);
        console.log(`transport: ${server.transport}`);
        if (server.transportFallbackReason) console.log(`fallback: ${server.transportFallbackReason}`);
        console.log("Open the URL, or drive it with: agent-browser open " + server.url);
    }
}
