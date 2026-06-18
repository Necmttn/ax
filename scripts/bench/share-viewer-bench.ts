#!/usr/bin/env bun
/**
 * Browser benchmark for the public session share viewer.
 *
 * Measures the real route in Chrome through the DevTools protocol:
 * - first rendered turn
 * - search input response and next-result jump
 * - quick-filter jump
 * - scroll-to-end incremental loading
 * - first subagent/session-part load
 *
 * Example:
 *   bun scripts/bench/share-viewer-bench.ts \
 *     --url=http://127.0.0.1:5178/share/Necmttn/b0064222c94cc4f0a09bd8da1b7d21cd
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

interface Args {
    readonly url: string;
    readonly chrome: string | null;
    readonly out: string | null;
    readonly json: boolean;
    readonly search: string;
    readonly timeoutMs: number;
    readonly maxFirstRenderMs: number | null;
    readonly maxScrollEndMs: number | null;
    readonly maxInteractionMs: number | null;
    readonly maxSubloadMs: number | null;
    readonly maxBlankMs: number | null;
}

interface CdpMessage {
    readonly id?: number;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: { readonly message?: string; readonly data?: string };
}

interface PageMetrics {
    readonly url: string;
    readonly readyState: string;
    readonly firstTurnMs: number | null;
    readonly viewerControlsMs: number | null;
    readonly fcpMs: number | null;
    readonly loadEventMs: number | null;
    readonly domContentLoadedMs: number | null;
    readonly turnRows: number;
    readonly totalTurnsLabel: string | null;
    readonly scrollHeight: number;
    readonly longTasks: ReadonlyArray<{ readonly start: number; readonly duration: number }>;
    readonly resources: ReadonlyArray<{
        readonly name: string;
        readonly initiatorType: string;
        readonly transferSize: number;
        readonly encodedBodySize: number;
        readonly duration: number;
    }>;
}

interface BenchReport {
    readonly schema: "ax.share_viewer_bench.v1";
    readonly generated_at: string;
    readonly url: string;
    readonly chrome: string;
    readonly budgets_ms: {
        readonly first_render: number | null;
        readonly scroll_end: number | null;
        readonly interaction: number | null;
        readonly subload: number | null;
        readonly blank: number | null;
    };
    readonly metrics: {
        readonly first_render_ms: number | null;
        readonly viewer_controls_ms: number | null;
        readonly fcp_ms: number | null;
        readonly load_event_ms: number | null;
        readonly dom_content_loaded_ms: number | null;
        readonly initial_turn_rows: number;
        readonly total_turns_label: string | null;
        readonly search_input_ms: number | null;
        readonly search_jump_ms: number | null;
        readonly quick_jump_ms: number | null;
        readonly fast_scroll_blank_ms: number | null;
        readonly scroll_to_end_ms: number | null;
        readonly scroll_passes: number | null;
        readonly final_turn_rows: number | null;
        readonly all_turns_loaded: boolean | null;
        readonly subagent_load_ms: number | null;
        readonly subagent_turn_rows: number | null;
        readonly long_tasks: {
            readonly count: number;
            readonly total_ms: number;
            readonly max_ms: number;
        };
        readonly resources: {
            readonly json_count: number;
            readonly json_transfer_bytes: number;
            readonly js_transfer_bytes: number;
            readonly css_transfer_bytes: number;
            readonly slowest: ReadonlyArray<{ readonly name: string; readonly duration: number; readonly transferSize: number }>;
        };
    };
    readonly samples: Record<string, unknown>;
    readonly failures: ReadonlyArray<string>;
}

const DEFAULT_URL = "http://127.0.0.1:5178/share/Necmttn/b0064222c94cc4f0a09bd8da1b7d21cd";

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/bench/share-viewer-bench.ts [--url=URL] [options]

Options:
  --url=URL                     Share viewer URL. Default: ${DEFAULT_URL}
  --chrome=PATH                 Chrome/Chromium executable. Default: auto-detect
  --search=TEXT                 Search query for input/jump latency. Default: profile
  --timeout-ms=N                Per-wait timeout. Default: 30000
  --out=PATH                    Write JSON report to PATH
  --json                        Print only JSON
  --max-first-render-ms=N       Optional failing budget
  --max-scroll-end-ms=N         Optional failing budget
  --max-interaction-ms=N        Optional failing budget for search/quick jumps
  --max-subload-ms=N            Optional failing budget
  --max-blank-ms=N              Optional failing budget for fast-scroll blank time
`);
    process.exit(code);
};

const parsePositive = (raw: string, name: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
    return n;
};

const parseArgs = (argv: readonly string[]): Args => {
    let url = process.env.AX_SHARE_BENCH_URL ?? DEFAULT_URL;
    let chrome = process.env.CHROME_BIN ?? null;
    let out = process.env.AX_SHARE_BENCH_OUT ?? null;
    let json = false;
    let search = process.env.AX_SHARE_BENCH_SEARCH ?? "profile";
    let timeoutMs = Number(process.env.AX_SHARE_BENCH_TIMEOUT_MS ?? 30_000);
    let maxFirstRenderMs = process.env.GOLD_FIRST_RENDER_MS ? Number(process.env.GOLD_FIRST_RENDER_MS) : null;
    let maxScrollEndMs = process.env.GOLD_SCROLL_END_MS ? Number(process.env.GOLD_SCROLL_END_MS) : null;
    let maxInteractionMs = process.env.GOLD_INTERACTION_MS ? Number(process.env.GOLD_INTERACTION_MS) : null;
    let maxSubloadMs = process.env.GOLD_SUBLOAD_MS ? Number(process.env.GOLD_SUBLOAD_MS) : null;
    let maxBlankMs = process.env.GOLD_BLANK_MS ? Number(process.env.GOLD_BLANK_MS) : null;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") usage(0);
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("--url=")) {
            url = arg.slice("--url=".length);
            continue;
        }
        if (arg.startsWith("--chrome=")) {
            chrome = arg.slice("--chrome=".length);
            continue;
        }
        if (arg.startsWith("--out=")) {
            out = arg.slice("--out=".length);
            continue;
        }
        if (arg.startsWith("--search=")) {
            search = arg.slice("--search=".length);
            continue;
        }
        if (arg.startsWith("--timeout-ms=")) {
            timeoutMs = parsePositive(arg.slice("--timeout-ms=".length), "--timeout-ms");
            continue;
        }
        if (arg.startsWith("--max-first-render-ms=")) {
            maxFirstRenderMs = parsePositive(arg.slice("--max-first-render-ms=".length), "--max-first-render-ms");
            continue;
        }
        if (arg.startsWith("--max-scroll-end-ms=")) {
            maxScrollEndMs = parsePositive(arg.slice("--max-scroll-end-ms=".length), "--max-scroll-end-ms");
            continue;
        }
        if (arg.startsWith("--max-interaction-ms=")) {
            maxInteractionMs = parsePositive(arg.slice("--max-interaction-ms=".length), "--max-interaction-ms");
            continue;
        }
        if (arg.startsWith("--max-subload-ms=")) {
            maxSubloadMs = parsePositive(arg.slice("--max-subload-ms=".length), "--max-subload-ms");
            continue;
        }
        if (arg.startsWith("--max-blank-ms=")) {
            maxBlankMs = parsePositive(arg.slice("--max-blank-ms=".length), "--max-blank-ms");
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    if (!/^https?:\/\//.test(url)) throw new Error("--url must be an http(s) URL");
    return { url, chrome, out, json, search, timeoutMs, maxFirstRenderMs, maxScrollEndMs, maxInteractionMs, maxSubloadMs, maxBlankMs };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fileExists = async (path: string): Promise<boolean> => {
    try {
        await Bun.file(path).stat();
        return true;
    } catch {
        return false;
    }
};

const findExecutable = async (explicit: string | null): Promise<string> => {
    const candidates = [
        explicit,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter((path): path is string => !!path);

    for (const candidate of candidates) {
        if (await fileExists(candidate)) return candidate;
    }
    throw new Error("Could not find Chrome/Chromium. Pass --chrome=/path/to/chrome or set CHROME_BIN.");
};

class CdpClient {
    private nextId = 1;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
    private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

    private constructor(private readonly ws: WebSocket) {
        ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    }

    static async connect(wsUrl: string): Promise<CdpClient> {
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out opening DevTools WebSocket")), 10_000);
            ws.addEventListener("open", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
            ws.addEventListener("error", () => {
                clearTimeout(timer);
                reject(new Error("Could not open DevTools WebSocket"));
            }, { once: true });
        });
        return new CdpClient(ws);
    }

    send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params });
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
            });
            this.ws.send(payload);
        });
    }

    once<T = unknown>(method: string, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                off();
                reject(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);
            const handler = (params: unknown) => {
                clearTimeout(timer);
                off();
                resolve(params as T);
            };
            const off = () => this.off(method, handler);
            this.on(method, handler);
        });
    }

    on(method: string, handler: (params: unknown) => void): void {
        const set = this.listeners.get(method) ?? new Set();
        set.add(handler);
        this.listeners.set(method, set);
    }

    off(method: string, handler: (params: unknown) => void): void {
        const set = this.listeners.get(method);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(method);
    }

    close(): void {
        this.ws.close();
    }

    private onMessage(raw: string): void {
        const message = JSON.parse(raw) as CdpMessage;
        if (message.id != null) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
            else pending.resolve(message.result);
            return;
        }
        if (message.method) {
            for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
        }
    }
}

const launchChrome = async (chrome: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; userDataDir: string; httpBase: string }> => {
    const userDataDir = await mkdtemp(join(tmpdir(), "ax-share-bench-"));
    const proc = Bun.spawn([
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--window-size=1440,1000",
        "about:blank",
    ], {
        stdout: "ignore",
        stderr: "pipe",
    });

    let exited = false;
    void proc.exited.then(() => {
        exited = true;
    });
    const activePortPath = join(userDataDir, "DevToolsActivePort");
    const started = Date.now();
    while (Date.now() - started < 10_000) {
        if (exited && !(await fileExists(activePortPath))) {
            const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
            throw new Error(`Chrome exited before DevTools became ready:\n${stderr}`);
        }
        if (await fileExists(activePortPath)) {
            const [port] = (await readFile(activePortPath, "utf8")).trim().split("\n");
            return { proc, userDataDir, httpBase: `http://127.0.0.1:${port}` };
        }
        await sleep(50);
    }

    proc.kill();
    throw new Error("Timed out waiting for Chrome DevToolsActivePort");
};

const newPageWebSocket = async (httpBase: string): Promise<string> => {
    const targetUrl = `${httpBase}/json/new?${encodeURIComponent("about:blank")}`;
    let response = await fetch(targetUrl, { method: "PUT" });
    if (!response.ok) response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`Could not open Chrome tab: ${response.status} ${response.statusText}`);
    const json = await response.json() as { webSocketDebuggerUrl?: string };
    if (!json.webSocketDebuggerUrl) throw new Error("Chrome did not return a page webSocketDebuggerUrl");
    return json.webSocketDebuggerUrl;
};

const BENCH_SOURCE = String.raw`
(() => {
  if (window.__axShareBench) return;
  const bench = { events: [], longTasks: [] };
  const hasEvent = (name) => bench.events.some((event) => event.name === name);
  const mark = (name, data = {}) => {
    if (hasEvent(name)) return;
    const t = performance.now();
    bench.events.push({ name, t, ...data });
    try { performance.mark("ax:" + name); } catch {}
  };
  window.__axShareBench = bench;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        bench.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const check = () => {
    const rows = document.querySelectorAll(".turn-row").length;
    if (rows > 0) mark("first_turn", { turnRows: rows });
    if (document.querySelector(".filter-bar input[type=search]")) mark("viewer_controls", { turnRows: rows });
  };
  const schedule = () => requestAnimationFrame(check);
  const observe = () => {
    const target = document.documentElement || document.body;
    if (!target) {
      setTimeout(observe, 10);
      return;
    }
    new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
  };
  document.addEventListener("DOMContentLoaded", () => { mark("dom_content_loaded"); schedule(); });
  window.addEventListener("load", () => { mark("load"); schedule(); });
  observe();
  setInterval(check, 100);
})();
`;

const evalPage = async <T>(cdp: CdpClient, expression: string, timeoutMs = 30_000): Promise<T> => {
    const result = await cdp.send<{
        readonly result?: { readonly value?: T };
        readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } };
    }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime.evaluate failed");
    }
    return result.result?.value as T;
};

const waitForPage = async <T>(
    cdp: CdpClient,
    expression: string,
    timeoutMs: number,
    intervalMs = 50,
): Promise<T> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await evalPage<T | null>(cdp, expression, timeoutMs);
        if (value) return value;
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for page condition: ${expression.slice(0, 120)}`);
};

const diagnosticExpression = `(() => ({
  url: location.href,
  readyState: document.readyState,
  title: document.title,
  bodyText: (document.body?.innerText ?? "").slice(0, 3000),
  rootHtml: (document.getElementById("root")?.innerHTML ?? "").slice(0, 3000),
  turnRows: document.querySelectorAll(".turn-row").length,
  scripts: [...document.scripts].map((script) => script.src || "[inline]").slice(0, 20),
  bench: window.__axShareBench ?? null,
  resources: performance.getEntriesByType("resource").map((r) => ({
    name: r.name,
    initiatorType: r.initiatorType,
    duration: Number(r.duration.toFixed(1)),
    transferSize: r.transferSize,
  })).slice(-30),
}))()`;

const pageMetricsExpression = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
  const bench = window.__axShareBench ?? { events: [], longTasks: [] };
  const eventAt = (name) => bench.events.find((event) => event.name === name)?.t ?? null;
  const resources = performance.getEntriesByType("resource")
    .filter((r) => /\\.json($|\\?)|\\/assets\\//.test(r.name))
    .map((r) => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize,
      encodedBodySize: r.encodedBodySize,
      duration: Number(r.duration.toFixed(1)),
    }));
  const totalTurnsLabel = [...document.querySelectorAll("header, div, span")]
    .map((el) => el.textContent?.trim() ?? "")
    .find((text) => /^\\d+ turns · this session$/.test(text)) ?? null;
  return {
    url: location.href,
    readyState: document.readyState,
    firstTurnMs: eventAt("first_turn"),
    viewerControlsMs: eventAt("viewer_controls"),
    fcpMs: paints["first-contentful-paint"] ?? null,
    loadEventMs: nav ? nav.loadEventEnd : eventAt("load"),
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : eventAt("dom_content_loaded"),
    turnRows: document.querySelectorAll(".turn-row").length,
    totalTurnsLabel,
    scrollHeight: document.documentElement.scrollHeight,
    longTasks: bench.longTasks,
    resources,
  };
})()`;

const searchInteractionExpression = (query: string) => `((async () => {
  const waitFrames = (n) => new Promise((resolve) => {
    const step = () => --n <= 0 ? resolve() : requestAnimationFrame(step);
    requestAnimationFrame(step);
  });
  const input = document.querySelector('input[type="search"][aria-label="find in turns"]');
  if (!input) return null;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const inputStart = performance.now();
  input.focus();
  setValue.call(input, ${JSON.stringify(query)});
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(query)} }));
  await new Promise((resolve) => setTimeout(resolve, 280));
  await waitFrames(2);
  const inputMs = performance.now() - inputStart;
  const hitText = [...document.querySelectorAll("span")]
    .map((el) => el.textContent?.trim() ?? "")
    .find((text) => /^\\d+ hits?$/.test(text) || text === "no hits" || text === "no hits in loaded window") ?? null;
  const nextButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "next");
  let jumpMs = null;
  if (nextButton && !nextButton.disabled) {
    const beforeHash = location.hash;
    const beforeY = scrollY;
    const clickStart = performance.now();
    nextButton.click();
    for (let i = 0; i < 40; i += 1) {
      await waitFrames(1);
      if (location.hash !== beforeHash || Math.abs(scrollY - beforeY) > 4) break;
    }
    jumpMs = performance.now() - clickStart;
  }
  return {
    input_ms: Number(inputMs.toFixed(1)),
    jump_ms: jumpMs == null ? null : Number(jumpMs.toFixed(1)),
    hit_text: hitText,
    hash: location.hash,
    scroll_y: Math.round(scrollY),
  };
})())`;

const quickJumpExpression = `((async () => {
  const waitFrames = (n) => new Promise((resolve) => {
    const step = () => --n <= 0 ? resolve() : requestAnimationFrame(step);
    requestAnimationFrame(step);
  });
  const button = [...document.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes("next tool call") && !b.disabled);
  if (!button) return null;
  const beforeHash = location.hash;
  const beforeY = scrollY;
  const started = performance.now();
  button.click();
  for (let i = 0; i < 40; i += 1) {
    await waitFrames(1);
    if (location.hash !== beforeHash || Math.abs(scrollY - beforeY) > 4) break;
  }
  return {
    ms: Number((performance.now() - started).toFixed(1)),
    hash: location.hash,
    scroll_y: Math.round(scrollY),
  };
})())`;

const fastScrollBlankExpression = `((async () => {
  const waitFrames = (n) => new Promise((resolve) => {
    const step = () => --n <= 0 ? resolve() : requestAnimationFrame(step);
    requestAnimationFrame(step);
  });
  const windowSummary = () => {
    const el = document.querySelector("[data-share-window-summary]");
    if (!el) return null;
    return {
      start: Number(el.getAttribute("data-window-start") ?? 0),
      end: Number(el.getAttribute("data-window-end") ?? 0),
      total: Number(el.getAttribute("data-window-total") ?? 0),
      text: el.textContent?.trim() ?? "",
    };
  };
  const probe = () => {
    const x = Math.round(Math.max(90, Math.min(window.innerWidth - 380, window.innerWidth * 0.36)));
    const y = Math.round(Math.min(window.innerHeight - 48, Math.max(180, window.innerHeight * 0.58)));
    const el = document.elementFromPoint(x, y);
    return {
      x,
      y,
      row: el?.closest?.(".turn-row")?.id ?? null,
      tag: el?.tagName ?? null,
      text: (el?.textContent ?? "").trim().slice(0, 80),
    };
  };
  const started = performance.now();
  const target = Math.min(
    document.documentElement.scrollHeight - window.innerHeight,
    window.scrollY + Math.max(window.innerHeight * 7, 32000),
  );
  window.scrollTo(0, target);
  let current = probe();
  let blankMs = current.row ? 0 : null;
  let blankSamples = current.row ? 0 : 1;
  const samples = [{ t: 0, y: Math.round(window.scrollY), ...current, window: windowSummary() }];
  for (let i = 0; i < 120 && blankMs == null; i += 1) {
    await waitFrames(1);
    current = probe();
    const t = Number((performance.now() - started).toFixed(1));
    samples.push({ t, y: Math.round(window.scrollY), ...current, window: windowSummary() });
    if (current.row) blankMs = t;
    else blankSamples += 1;
  }
  return {
    blank_ms: blankMs,
    blank_samples: blankSamples,
    target_y: Math.round(target),
    scroll_y: Math.round(window.scrollY),
    turn_rows: document.querySelectorAll(".turn-row").length,
    window: windowSummary(),
    samples: samples.slice(0, 12),
  };
})())`;

const scrollToEndExpression = `((async () => {
  const waitFrames = (n) => new Promise((resolve) => {
    const step = () => --n <= 0 ? resolve() : requestAnimationFrame(step);
    requestAnimationFrame(step);
  });
  const windowSummary = () => {
    const el = document.querySelector("[data-share-window-summary]");
    if (!el) return null;
    return {
      start: Number(el.getAttribute("data-window-start") ?? 0),
      end: Number(el.getAttribute("data-window-end") ?? 0),
      total: Number(el.getAttribute("data-window-total") ?? 0),
      text: el.textContent?.trim() ?? "",
    };
  };
  const reachedEnd = () => {
    const summary = windowSummary();
    if (summary && summary.total > 0) return summary.end >= summary.total;
    return !/loading \\d+ more turns/.test(document.body.textContent ?? "");
  };
  const started = performance.now();
  let passes = 0;
  let stable = 0;
  let previousKey = "";
  for (; passes < 80; passes += 1) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await waitFrames(2);
    const rows = document.querySelectorAll(".turn-row").length;
    const summary = windowSummary();
    const key = summary
      ? \`\${summary.start}:\${summary.end}:\${summary.total}:\${rows}:\${document.documentElement.scrollHeight}\`
      : \`\${rows}:\${document.documentElement.scrollHeight}\`;
    if (reachedEnd() && key === previousKey) stable += 1;
    else stable = 0;
    previousKey = key;
    if (stable >= 2) break;
  }
  const summary = windowSummary();
  return {
    ms: Number((performance.now() - started).toFixed(1)),
    passes,
    turn_rows: document.querySelectorAll(".turn-row").length,
    all_loaded: reachedEnd(),
    window: summary,
    scroll_height: document.documentElement.scrollHeight,
    scroll_y: Math.round(scrollY),
  };
})())`;

const subagentLoadExpression = `((async () => {
  const waitFrames = (n) => new Promise((resolve) => {
    const step = () => --n <= 0 ? resolve() : requestAnimationFrame(step);
    requestAnimationFrame(step);
  });
  const button = document.querySelector('button[aria-label^="Open subagent:"]')
    ?? [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("spawned subagent"));
  if (!button) return null;
  const beforeUrl = location.href;
  const beforeSub = new URL(location.href).searchParams.get("sub");
  const beforeFirstTurn = document.querySelector(".turn-row")?.id ?? null;
  const started = performance.now();
  button.click();
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const currentSub = new URL(location.href).searchParams.get("sub");
    const firstTurn = document.querySelector(".turn-row")?.id ?? null;
    const body = document.body.textContent ?? "";
    if (currentSub && currentSub !== beforeSub && firstTurn && firstTurn !== beforeFirstTurn) break;
    if (body.includes("Error:")) break;
  }
  return {
    ms: Number((performance.now() - started).toFixed(1)),
    url: location.href,
    turn_rows: document.querySelectorAll(".turn-row").length,
    first_turn: document.querySelector(".turn-row")?.id ?? null,
    body_text: (document.body?.innerText ?? "").slice(0, 1200),
  };
})())`;

const summarizeResources = (resources: PageMetrics["resources"]) => {
    const json = resources.filter((r) => /\.json($|\?)/.test(r.name));
    const js = resources.filter((r) => /\/assets\/.*\.js($|\?)/.test(r.name));
    const css = resources.filter((r) => /\/assets\/.*\.css($|\?)/.test(r.name));
    return {
        json_count: json.length,
        json_transfer_bytes: json.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0),
        js_transfer_bytes: js.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0),
        css_transfer_bytes: css.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0),
        slowest: [...resources]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 8)
            .map((r) => ({
                name: basename(new URL(r.name).pathname) || r.name,
                duration: r.duration,
                transferSize: r.transferSize || r.encodedBodySize || 0,
            })),
    };
};

const longTaskSummary = (longTasks: PageMetrics["longTasks"]) => ({
    count: longTasks.length,
    total_ms: Number(longTasks.reduce((sum, task) => sum + task.duration, 0).toFixed(1)),
    max_ms: Number(Math.max(0, ...longTasks.map((task) => task.duration)).toFixed(1)),
});

const failIfOver = (
    failures: string[],
    label: string,
    value: number | null,
    budget: number | null,
) => {
    if (value == null || budget == null) return;
    if (value > budget) failures.push(`${label} ${value.toFixed(1)}ms > ${budget.toFixed(1)}ms`);
};

const printHuman = (report: BenchReport): void => {
    console.log(`share-viewer bench · ${report.url}`);
    console.log(`chrome: ${report.chrome}`);
    console.table([{
        first_render: report.metrics.first_render_ms,
        fcp: report.metrics.fcp_ms,
        controls: report.metrics.viewer_controls_ms,
        search_input: report.metrics.search_input_ms,
        search_jump: report.metrics.search_jump_ms,
        quick_jump: report.metrics.quick_jump_ms,
        fast_blank: report.metrics.fast_scroll_blank_ms,
        scroll_end: report.metrics.scroll_to_end_ms,
        subload: report.metrics.subagent_load_ms,
    }]);
    console.log(`turn rows: initial ${report.metrics.initial_turn_rows} -> final ${report.metrics.final_turn_rows ?? "?"} (${report.metrics.total_turns_label ?? "unknown total"})`);
    console.log(`long tasks: ${report.metrics.long_tasks.count} · total ${report.metrics.long_tasks.total_ms}ms · max ${report.metrics.long_tasks.max_ms}ms`);
    console.log(`resources: json ${report.metrics.resources.json_transfer_bytes}B · js ${report.metrics.resources.js_transfer_bytes}B · css ${report.metrics.resources.css_transfer_bytes}B`);
    if (report.metrics.resources.slowest.length > 0) {
        console.table(report.metrics.resources.slowest);
    }
    if (report.failures.length > 0) {
        console.error(`FAIL\n${report.failures.map((f) => `  - ${f}`).join("\n")}`);
    } else {
        console.log("PASS · no configured budget failures");
    }
};

const main = async (): Promise<void> => {
    const args = parseArgs(Bun.argv.slice(2));
    const chrome = await findExecutable(args.chrome);
    const chromeRun = await launchChrome(chrome);
    let cdp: CdpClient | null = null;
    let exitCode = 0;
    try {
        cdp = await CdpClient.connect(await newPageWebSocket(chromeRun.httpBase));
        const runtimeEvents: string[] = [];
        const networkFailures: string[] = [];
        cdp.on("Runtime.consoleAPICalled", (params) => {
            const p = params as { readonly type?: string; readonly args?: ReadonlyArray<{ readonly value?: unknown; readonly description?: string }> };
            const argsText = (p.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
            runtimeEvents.push(`${p.type ?? "console"}: ${argsText}`.slice(0, 800));
        });
        cdp.on("Runtime.exceptionThrown", (params) => {
            const p = params as { readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } } };
            runtimeEvents.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "unknown"}`.slice(0, 1200));
        });
        cdp.on("Network.loadingFailed", (params) => {
            const p = params as { readonly requestId?: string; readonly errorText?: string; readonly canceled?: boolean };
            networkFailures.push(`${p.requestId ?? "request"}: ${p.errorText ?? "failed"}${p.canceled ? " (canceled)" : ""}`);
        });
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Network.enable");
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: BENCH_SOURCE });

        const loadEvent = cdp.once("Page.loadEventFired", args.timeoutMs).catch(() => null);
        await cdp.send("Page.navigate", { url: args.url });
        try {
            await waitForPage(cdp, "window.__axShareBench?.events?.some((event) => event.name === 'first_turn') ? true : null", args.timeoutMs);
        } catch (err) {
            const diagnostic = await evalPage<unknown>(cdp, diagnosticExpression, 5_000).catch((diagErr) => ({
                diagnostic_error: diagErr instanceof Error ? diagErr.message : String(diagErr),
            }));
            throw new Error([
                err instanceof Error ? err.message : String(err),
                `diagnostic=${JSON.stringify(diagnostic, null, 2)}`,
                `console=${JSON.stringify(runtimeEvents.slice(-30), null, 2)}`,
                `network_failures=${JSON.stringify(networkFailures.slice(-30), null, 2)}`,
            ].join("\n"));
        }
        await loadEvent;
        const initial = await evalPage<PageMetrics>(cdp, pageMetricsExpression, args.timeoutMs);
        const search = await evalPage<{
            readonly input_ms: number;
            readonly jump_ms: number | null;
            readonly hit_text: string | null;
            readonly hash: string;
            readonly scroll_y: number;
        } | null>(cdp, searchInteractionExpression(args.search), args.timeoutMs);
        const quick = await evalPage<{ readonly ms: number; readonly hash: string; readonly scroll_y: number } | null>(
            cdp,
            quickJumpExpression,
            args.timeoutMs,
        );
        const fastScroll = await evalPage<{
            readonly blank_ms: number | null;
            readonly blank_samples: number;
            readonly target_y: number;
            readonly scroll_y: number;
            readonly turn_rows: number;
            readonly window?: { readonly start: number; readonly end: number; readonly total: number; readonly text: string } | null;
            readonly samples: ReadonlyArray<unknown>;
        } | null>(cdp, fastScrollBlankExpression, args.timeoutMs);
        const scroll = await evalPage<{
            readonly ms: number;
            readonly passes: number;
            readonly turn_rows: number;
            readonly all_loaded: boolean;
            readonly window?: { readonly start: number; readonly end: number; readonly total: number; readonly text: string } | null;
            readonly scroll_height: number;
            readonly scroll_y: number;
        }>(cdp, scrollToEndExpression, args.timeoutMs * 3);
        const subagent = await evalPage<{
            readonly ms: number;
            readonly url: string;
            readonly turn_rows: number;
            readonly first_turn: string | null;
            readonly body_text?: string;
        } | null>(cdp, subagentLoadExpression, args.timeoutMs);
        const final = await evalPage<PageMetrics>(cdp, pageMetricsExpression, args.timeoutMs);

        const failures: string[] = [];
        failIfOver(failures, "first render", initial.firstTurnMs, args.maxFirstRenderMs);
        failIfOver(failures, "scroll to end", scroll.ms, args.maxScrollEndMs);
        failIfOver(failures, "search input", search?.input_ms ?? null, args.maxInteractionMs);
        failIfOver(failures, "search jump", search?.jump_ms ?? null, args.maxInteractionMs);
        failIfOver(failures, "quick jump", quick?.ms ?? null, args.maxInteractionMs);
        failIfOver(failures, "subagent load", subagent?.ms ?? null, args.maxSubloadMs);
        failIfOver(failures, "fast-scroll blank", fastScroll?.blank_ms ?? null, args.maxBlankMs);
        if (!scroll.all_loaded) failures.push("scroll-to-end did not reach the final turn window");

        const report: BenchReport = {
            schema: "ax.share_viewer_bench.v1",
            generated_at: new Date().toISOString(),
            url: args.url,
            chrome,
            budgets_ms: {
                first_render: args.maxFirstRenderMs,
                scroll_end: args.maxScrollEndMs,
                interaction: args.maxInteractionMs,
                subload: args.maxSubloadMs,
                blank: args.maxBlankMs,
            },
            metrics: {
                first_render_ms: initial.firstTurnMs,
                viewer_controls_ms: initial.viewerControlsMs,
                fcp_ms: initial.fcpMs,
                load_event_ms: initial.loadEventMs,
                dom_content_loaded_ms: initial.domContentLoadedMs,
                initial_turn_rows: initial.turnRows,
                total_turns_label: initial.totalTurnsLabel ?? final.totalTurnsLabel,
                search_input_ms: search?.input_ms ?? null,
                search_jump_ms: search?.jump_ms ?? null,
                quick_jump_ms: quick?.ms ?? null,
                fast_scroll_blank_ms: fastScroll?.blank_ms ?? null,
                scroll_to_end_ms: scroll.ms,
                scroll_passes: scroll.passes,
                final_turn_rows: scroll.turn_rows,
                all_turns_loaded: scroll.all_loaded,
                subagent_load_ms: subagent?.ms ?? null,
                subagent_turn_rows: subagent?.turn_rows ?? null,
                long_tasks: longTaskSummary(final.longTasks),
                resources: summarizeResources(final.resources),
            },
            samples: { initial, search, quick, fastScroll, scroll, subagent, final },
            failures,
        };

        if (args.out) {
            await Bun.$`mkdir -p ${dirname(args.out)}`;
            await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
        }
        if (args.json) console.log(JSON.stringify(report, null, 2));
        else printHuman(report);
        if (failures.length > 0) exitCode = 1;
    } finally {
        cdp?.close();
        chromeRun.proc.kill();
        await Promise.race([
            chromeRun.proc.exited.catch(() => {}),
            sleep(1_500).then(() => {
                chromeRun.proc.kill("SIGKILL");
            }),
        ]);
        await rm(chromeRun.userDataDir, { recursive: true, force: true });
    }
    process.exit(exitCode);
};

main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
});
