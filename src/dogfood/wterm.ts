import { mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { recordRef } from "../ingest/evidence-writers.ts";

export type DogfoodScenario = "agentctl-setup";

export interface DogfoodTerminalArgs {
    readonly scenario: DogfoodScenario;
    readonly port: number;
    readonly json: boolean;
}

export interface DogfoodTerminalServer {
    readonly url: string;
    readonly port: number;
    readonly scenario: DogfoodScenario;
    readonly stop: () => void;
}

interface DogfoodResult {
    readonly runId: string;
    readonly scenario: DogfoodScenario;
    readonly status: "passed" | "failed";
    readonly transcript: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly cwd: string;
    readonly markerFound: boolean;
    readonly persisted: boolean;
    readonly transport: "process";
}

const DEFAULT_PORT = 1742;
const SUCCESS_MARKER = "AGENTCTL_DOGFOOD_SETUP_OK";

const sqlString = (value: string): string => JSON.stringify(value);
const sqlJson = (value: unknown): string => sqlString(JSON.stringify(value) ?? "null");
const sqlDate = (value: string): string => `d${JSON.stringify(value)}`;
const sqlObject = (fields: readonly (readonly [string, string])[]): string =>
    `{ ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

function shortHash(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

function repoRoot(): string {
    if (process.env.AGENTCTL_REPO_ROOT) return process.env.AGENTCTL_REPO_ROOT;
    if (existsSync(join(process.cwd(), "package.json")) && existsSync(join(process.cwd(), "node_modules"))) {
        return process.cwd();
    }
    return join(import.meta.dir, "..", "..");
}

function currentAgentctlPath(root: string): string {
    if (!process.argv[1]?.endsWith(".ts") && existsSync(process.execPath)) {
        return process.execPath;
    }
    if (existsSync(join(root, "dist", "agentctl"))) return join(root, "dist", "agentctl");
    return join(root, "bin", "agentctl");
}

export function parseDogfoodTerminalArgs(args: readonly string[]): DogfoodTerminalArgs {
    const flag = (name: string): string | undefined => {
        const found = args.find((arg) => arg.startsWith(`--${name}=`));
        return found?.split("=")[1];
    };
    const scenario = flag("scenario") ?? "agentctl-setup";
    if (scenario !== "agentctl-setup") {
        throw new Error(`unknown dogfood scenario "${scenario}"`);
    }
    const rawPort = flag("port");
    const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port must be a valid TCP port (got "${rawPort}")`);
    }
    return { scenario, port, json: args.includes("--json") };
}

export async function createAgentctlSetupDemoScript(root = repoRoot()): Promise<{
    readonly cwd: string;
    readonly command: string;
}> {
    const workRoot = await mkdtemp(join(tmpdir(), "agentctl-wterm-dogfood-"));
    const home = join(workRoot, "home");
    const scratch = join(workRoot, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    for (const dir of [".claude", ".codex", ".agents"]) {
        await mkdir(join(home, dir), { recursive: true });
    }

    const agentctl = currentAgentctlPath(root);

    const lines = [
        "set -euo pipefail",
        "clear",
        "printf '\\033[1;36magentctl wterm dogfood: fresh setup demo\\033[0m\\r\\n'",
        `printf 'repo: %s\\r\\n' ${JSON.stringify(root)}`,
        `printf 'scratch home: %s\\r\\n\\r\\n' ${JSON.stringify(home)}`,
        "printf '$ agentctl --help\\r\\n'",
        `${JSON.stringify(agentctl)} --help | sed -n '1,18p'`,
        "printf '\\r\\n$ HOME=<scratch> agentctl onboarding --json\\r\\n'",
        `HOME=${JSON.stringify(home)} ${JSON.stringify(agentctl)} onboarding --json`,
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
        "  git -C \"$d\" -c user.name='agentctl dogfood' -c user.email='dogfood@example.invalid' commit -qm 'chore: track agent harness'",
        "done",
        "printf '\\r\\n$ HOME=<scratch> agentctl onboarding --json\\r\\n'",
        `HOME=${JSON.stringify(home)} ${JSON.stringify(agentctl)} onboarding --json`,
        `printf '\\r\\n%s\\r\\n' ${JSON.stringify(SUCCESS_MARKER)}`,
        "printf '\\r\\nDogfood complete. Transcript will be saved as evidence if the agentctl DB is reachable.\\r\\n'",
    ];

    return {
        cwd: scratch,
        command: lines.join("\n"),
    };
}

export function dogfoodHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agentctl wterm dogfood</title>
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
  <header><h1>agentctl wterm dogfood <span id="status">connecting</span></h1></header>
  <main><div id="terminal" aria-label="agentctl setup terminal"></div></main>
  <footer>Scenario: fresh setup in a scratch HOME. No launchd or real global config mutation.</footer>
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
      window.__agentctlDogfoodResult = result;
      window.dispatchEvent(new CustomEvent("agentctl-dogfood-complete", { detail: result }));
    }).catch(() => undefined);
  },
  onError: () => {
    statusEl.textContent = "error";
  },
});

term.onData = (data) => transport.send(data);
transport.connect();
window.__wterm = term;
window.__agentctlDogfood = { term, transport };
`;
}

async function persistDogfoodResult(result: DogfoodResult): Promise<boolean> {
    const transcriptKey = `dogfood_wterm_setup__${result.runId}__transcript`;
    const observationKey = `dogfood_wterm_setup__${result.runId}`;
    const artifactRef = recordRef("artifact", transcriptKey);
    const statements = [
        `UPSERT ${artifactRef} MERGE ${sqlObject([
            ["kind", sqlString("dogfood_wterm_transcript")],
            ["title", sqlString("wterm agentctl setup dogfood transcript")],
            ["uri", sqlString(`dogfood://wterm/${result.runId}/transcript`)],
            ["path", "NONE"],
            ["content_hash", sqlString(shortHash(result.transcript))],
            ["raw", sqlJson({
                scenario: result.scenario,
                transcript: result.transcript,
                started_at: result.startedAt,
                ended_at: result.endedAt,
                cwd: result.cwd,
            })],
            ["updated_at", "time::now()"],
        ])};`,
        `UPSERT ${recordRef("intervention_observation", observationKey)} MERGE ${sqlObject([
            ["intervention", "NONE"],
            ["target", sqlString("agentctl_setup_wterm_dogfood")],
            ["status", sqlString(result.status)],
            ["metrics_before", sqlJson({ setup_verified: 0 })],
            ["metrics_after", sqlJson({ setup_verified: result.status === "passed" ? 1 : 0 })],
            ["metrics", sqlJson({
                scenario: result.scenario,
                driver: "wterm",
                transport: result.transport,
                marker_found: result.markerFound,
                transcript_artifact: transcriptKey,
            })],
            ["notes", sqlJson([
                "wterm rendered a browser terminal connected to a scripted process transport",
                "scenario demonstrated agentctl onboarding from a scratch HOME",
            ])],
            ["observed_at", sqlDate(result.endedAt)],
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
    const runId = shortHash(`${Date.now()}|${Math.random()}`);
    const startedAt = new Date().toISOString();
    const scenario = await createAgentctlSetupDemoScript();
    let transcript = "";
    let result: DogfoodResult | null = null;
    let childProcess: ReturnType<typeof Bun.spawn> | null = null;
    let sessionStarted = false;

    const finish = async () => {
        if (result !== null) return;
        const endedAt = new Date().toISOString();
        const markerFound = transcript.includes(SUCCESS_MARKER);
        const base: DogfoodResult = {
            runId,
            scenario: args.scenario,
            status: markerFound ? "passed" : "failed",
            transcript,
            startedAt,
            endedAt,
            cwd: scenario.cwd,
            markerFound,
            persisted: false,
            transport: "process",
        };
        const persisted = await persistDogfoodResult(base);
        result = { ...base, persisted };
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
                childProcess = Bun.spawn(["bash", "-lc", scenario.command], {
                    cwd: scenario.cwd,
                    env: {
                        PATH: process.env.PATH ?? "",
                        TERM: "xterm-256color",
                        CI: "1",
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
                        const data = decoder.decode(chunk.value);
                        transcript += data;
                        ws.send(data);
                    }
                };
                Promise.all([pump(childProcess.stdout), pump(childProcess.stderr)])
                    .then(() => childProcess?.exited)
                    .then(() => {
                        childProcess = null;
                        return finish();
                    })
                    .finally(() => ws.close());
            },
            message(_ws, message) {
                const input = typeof message === "string"
                    ? message
                    : Buffer.from(message).toString("utf8");
                if (input.startsWith("\x1b[RESIZE:")) {
                    return;
                }
            },
            close() {
                if (childProcess) {
                    const current = childProcess;
                    childProcess = null;
                    try {
                        current.kill();
                    } catch {
                        // Already exited.
                    }
                }
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
                return new Response(dogfoodHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
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
        stop: () => server.stop(true),
    };
}

export async function cmdDogfoodTerminal(rawArgs: readonly string[]): Promise<void> {
    const args = parseDogfoodTerminalArgs(rawArgs);
    const server = await startWtermDogfoodServer(args);
    if (args.json) {
        console.log(JSON.stringify({
            kind: "agentctl.dogfood.terminal",
            scenario: server.scenario,
            url: server.url,
            port: server.port,
        }, null, 2));
    } else {
        console.log(`agentctl dogfood terminal: ${server.url}`);
        console.log("Open the URL, or drive it with: agent-browser open " + server.url);
    }
}
