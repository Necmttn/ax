/**
 * Stream-style HTML inspector for a Claude Code session.
 *
 * Renders each JSONL message as a row in a single column, role-indicated by a
 * coloured left margin and a semantic role badge (the badge reflects what the
 * content ACTUALLY is, not just the JSONL framing - e.g. a JSONL `user` entry
 * whose content is 100% tool_result spans gets labelled "tool result", not
 * "user").
 *
 * Usage: bun scripts/prototypes/ax-session-inspect.ts <session-id|--latest> [out.html]
 */

import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { dissectTurn, type TurnSpan } from "/Users/necmttn/Projects/ax/src/ingest/turn-dissect.ts";

const SPAN_COLOR: Record<TurnSpan["kind"], { bg: string; fg: string; bar: string; label: string }> = {
    user_input:           { bg: "#fef9c3", fg: "#78350f", bar: "#eab308", label: "user input" },
    assistant_text:       { bg: "#f3f4f6", fg: "#111827", bar: "#0f172a", label: "assistant text" },
    tool_use:             { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool use" },
    skill_context:        { bg: "#dbeafe", fg: "#1e3a8a", bar: "#3b82f6", label: "skill" },
    system_context:       { bg: "#e5e7eb", fg: "#1f2937", bar: "#64748b", label: "system" },
    wrapper_instruction:  { bg: "#fde68a", fg: "#92400e", bar: "#f59e0b", label: "wrapper" },
    hook_injection:       { bg: "#bbf7d0", fg: "#065f46", bar: "#10b981", label: "hook" },
    tool_result:          { bg: "#e9d5ff", fg: "#5b21b6", bar: "#a855f7", label: "tool result" },
    subagent_notification:{ bg: "#fed7aa", fg: "#9a3412", bar: "#f97316", label: "subagent" },
    pasted_reference:     { bg: "#fecaca", fg: "#7f1d1d", bar: "#ef4444", label: "pasted" },
};

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeAttr = (s: string): string => escapeHtml(s).replace(/'/g, "&#39;");

interface JsonlContentBlock {
    type: string;
    text?: string;
    content?: unknown;
    name?: string;
    input?: unknown;
}
interface JsonlMessage {
    type: string;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    message?: {
        role?: string;
        content?: string | JsonlContentBlock[];
    };
}

interface InspectedTurn {
    seq: number;
    role: string;          // raw JSONL role (user/assistant)
    semanticRole: TurnSpan["kind"]; // dominant kind - what the content actually IS
    ts: string | undefined;
    text: string;
    spans: readonly TurnSpan[];
}

async function findJsonl(sessionId: string): Promise<string> {
    const projectsDir = join(homedir(), ".claude", "projects");
    const subdirs = await readdir(projectsDir);
    for (const sub of subdirs) {
        const candidate = join(projectsDir, sub, `${sessionId}.jsonl`);
        try { await stat(candidate); return candidate; } catch {}
    }
    throw new Error(`could not find ${sessionId}.jsonl under ${projectsDir}/*/`);
}

async function findLatestSessionInCwd(): Promise<string> {
    const projectsDir = join(homedir(), ".claude", "projects");
    const cwd = process.cwd();
    const slug = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
    const sub = join(projectsDir, slug);
    const files = await readdir(sub);
    let newest = ""; let newestMtime = 0;
    for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const s = await stat(join(sub, f));
        if (s.mtimeMs > newestMtime) { newestMtime = s.mtimeMs; newest = f.replace(/\.jsonl$/, ""); }
    }
    if (!newest) throw new Error(`no .jsonl files found under ${sub}`);
    return newest;
}

function blockToText(block: JsonlContentBlock): string {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "tool_result") {
        const inner = block.content;
        if (typeof inner === "string") return `<local-command-stdout>${inner}</local-command-stdout>`;
        if (Array.isArray(inner)) {
            const joined = (inner as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
            return `<local-command-stdout>${joined}</local-command-stdout>`;
        }
        return "<local-command-stdout></local-command-stdout>";
    }
    if (block.type === "tool_use") {
        const name = block.name ? ` name="${block.name.replace(/"/g, "")}"` : "";
        const input = JSON.stringify(block.input ?? {});
        const clipped = input.length > 400 ? `${input.slice(0, 400)}...` : input;
        return `<tool_use${name}>${clipped}</tool_use>`;
    }
    return "";
}

/** Pick the kind that occupies the most chars as the semantic role. Used to
 *  override the misleading JSONL `user/assistant` framing when a turn is
 *  entirely tool output or skill autoload. */
function dominantKind(spans: readonly TurnSpan[]): TurnSpan["kind"] | null {
    if (spans.length === 0) return null;
    const sizes = new Map<TurnSpan["kind"], number>();
    for (const s of spans) sizes.set(s.kind, (sizes.get(s.kind) ?? 0) + s.text.length);
    let best: TurnSpan["kind"] | null = null;
    let bestSize = -1;
    for (const [k, sz] of sizes) {
        if (sz > bestSize) { best = k; bestSize = sz; }
    }
    return best;
}

async function readMessages(jsonlPath: string): Promise<readonly InspectedTurn[]> {
    const raw = await readFile(jsonlPath, "utf8");
    const turns: InspectedTurn[] = [];
    let seq = 0;
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let entry: JsonlMessage;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        const content = entry.message?.content;
        const text = typeof content === "string"
            ? content
            : Array.isArray(content) ? content.map(blockToText).join("") : "";
        if (!text) continue;
        const role = entry.message?.role ?? entry.type;
        const spans = dissectTurn(text, role === "assistant" ? { defaultKind: "assistant_text" } : {});
        const semanticRole = dominantKind(spans) ?? (role === "assistant" ? "assistant_text" : "user_input");
        turns.push({ seq: seq++, role, semanticRole, ts: entry.timestamp, text, spans });
    }
    return turns;
}

function renderSpan(span: TurnSpan): string {
    const c = SPAN_COLOR[span.kind];
    const title = span.label ? `${c.label}: ${span.label}` : c.label;
    return `<span class="span" style="background:${c.bg};color:${c.fg}" title="${escapeAttr(title)}">${escapeHtml(span.text)}</span>`;
}

function renderTurn(turn: InspectedTurn): string {
    const semantic = SPAN_COLOR[turn.semanticRole];
    const kindCounts = new Map<TurnSpan["kind"], number>();
    for (const s of turn.spans) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + s.text.length);
    const chips = [...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, n]) => {
            const c = SPAN_COLOR[kind];
            const pct = ((n / turn.text.length) * 100).toFixed(0);
            return `<span class="chip" style="background:${c.bg};color:${c.fg}">${c.label} ${pct}%</span>`;
        })
        .join("");
    const ts = turn.ts ? new Date(turn.ts).toISOString().slice(11, 19) : "";
    const sizeStr = turn.text.length > 1000
        ? `${(turn.text.length / 1000).toFixed(1)}k`
        : `${turn.text.length}`;
    // JSONL role and semantic role often diverge - keep both visible.
    const jsonlBadge = turn.role !== turn.semanticRole.replace(/_text$|_input$/, "")
        ? `<span class="jsonl-role">(jsonl: ${escapeHtml(turn.role)})</span>` : "";
    return `
        <div class="turn" style="--bar:${semantic.bar}">
            <div class="meta">
                <span class="seq">#${turn.seq}</span>
                <span class="role-badge" style="background:${semantic.bg};color:${semantic.fg}">${semantic.label}</span>
                ${jsonlBadge}
                <span class="ts">${escapeHtml(ts)}</span>
                <span class="size">${sizeStr}c · ${turn.spans.length}span</span>
                <span class="chips">${chips}</span>
            </div>
            <div class="body">${turn.spans.map(renderSpan).join("")}</div>
        </div>
    `;
}

function renderHtml(sessionId: string, turns: readonly InspectedTurn[]): string {
    const totalChars = turns.reduce((acc, t) => acc + t.text.length, 0);
    const totalsByKind = new Map<TurnSpan["kind"], number>();
    for (const t of turns) for (const s of t.spans)
        totalsByKind.set(s.kind, (totalsByKind.get(s.kind) ?? 0) + s.text.length);
    const legend = (Object.keys(SPAN_COLOR) as TurnSpan["kind"][])
        .map((kind) => {
            const c = SPAN_COLOR[kind];
            const n = totalsByKind.get(kind) ?? 0;
            const pct = totalChars > 0 ? ((n / totalChars) * 100).toFixed(1) : "0";
            return `<span class="legend-pill" style="background:${c.bg};color:${c.fg};--bar:${c.bar}">${c.label} <em>${pct}%</em></span>`;
        }).join("");

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>ax · ${escapeHtml(sessionId)}</title>
<style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; background: #fafafa; color: #0f172a; }
    .topbar { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #e5e7eb; padding: 12px 24px; }
    .topbar h1 { margin: 0 0 2px; font-size: 13px; font-family: ui-monospace, "SF Mono", monospace; font-weight: 500; color: #475569; }
    .topbar .meta { color: #64748b; font-size: 11px; }
    .legend { padding: 6px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; display: flex; gap: 4px; flex-wrap: wrap; }
    .legend-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; border-left: 3px solid var(--bar); }
    .legend-pill em { font-style: normal; opacity: 0.7; font-weight: 400; }

    .stream { padding: 8px 0; }
    .turn { display: grid; grid-template-columns: 56px 1fr; column-gap: 12px; padding: 6px 24px; border-left: 3px solid var(--bar); transition: background 0.1s; }
    .turn:hover { background: #f1f5f9; }
    .turn .meta { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 11px; color: #64748b; flex-wrap: wrap; font-family: ui-monospace, "SF Mono", monospace; }
    .turn .seq { color: #94a3b8; min-width: 48px; }
    .turn .role-badge { padding: 1px 8px; border-radius: 3px; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .turn .jsonl-role { color: #94a3b8; font-size: 10px; }
    .turn .ts { color: #94a3b8; }
    .turn .size { color: #94a3b8; }
    .turn .chips { display: inline-flex; gap: 3px; flex-wrap: wrap; margin-left: auto; }
    .chip { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 10px; font-weight: 500; font-family: ui-monospace, "SF Mono", monospace; }
    .turn .body { grid-column: 1 / -1; margin-top: 2px; padding: 4px 0 6px; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 ui-monospace, "SF Mono", monospace; max-height: 400px; overflow: auto; }
    .turn .body:empty { display: none; }
    .span { padding: 0 1px; border-radius: 2px; transition: box-shadow 0.1s; }
    .span:hover { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25); }

    .turn[data-collapsed="true"] .body { display: none; }
    /* Compact mode toggle: hide huge tool_result/skill blobs by default unless clicked */
    .turn .body { cursor: pointer; }
</style>
</head><body>
    <div class="topbar">
        <h1>${escapeHtml(sessionId)}</h1>
        <div class="meta">${turns.length} turns · ${totalChars.toLocaleString()} chars · generated ${escapeHtml(new Date().toISOString())}</div>
    </div>
    <div class="legend">${legend}</div>
    <div class="stream">
        ${turns.map(renderTurn).join("")}
    </div>
    <script>
        // Click a turn body to collapse/expand its overflow scroll.
        document.querySelectorAll('.turn .body').forEach(b => {
            b.addEventListener('click', e => {
                const sel = window.getSelection();
                if (sel && sel.toString().length > 0) return;  // don't toggle while user is selecting text
                b.style.maxHeight = b.style.maxHeight === 'none' ? '400px' : 'none';
            });
        });
    </script>
</body></html>`;
}

const arg = process.argv[2];
if (!arg) {
    console.error("usage: bun scripts/prototypes/ax-session-inspect.ts <session-id|--latest> [out.html]");
    process.exit(1);
}
const sessionId = arg === "--latest" ? await findLatestSessionInCwd() : arg;
const jsonlPath = await findJsonl(sessionId);
const turns = await readMessages(jsonlPath);
const outPath = resolve(process.argv[3] ?? `dogfood-output/ax-session-inspect-${sessionId.slice(0, 8)}.html`);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, renderHtml(sessionId, turns), "utf8");
console.log(`session: ${sessionId}`);
console.log(`source:  ${jsonlPath}`);
console.log(`turns:   ${turns.length}`);
console.log(`wrote:   ${outPath}`);
