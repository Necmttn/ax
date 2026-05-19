/**
 * Build a SessionInspectPayload by reading the JSONL transcript file for the
 * given session id and dissecting each message's text into typed spans.
 *
 * Used by `/api/sessions/:id/inspect` and reused by
 * `scripts/prototypes/ax-session-inspect.ts`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { dissectTurn, type TurnSpan } from "../ingest/turn-dissect.ts";
import type {
    InspectSpanDto,
    InspectSpanKind,
    InspectTurnDto,
    SessionInspectPayload,
} from "../lib/shared/dashboard-types.ts";

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

type Harness = "claude" | "codex";

interface FoundTranscript {
    readonly path: string;
    readonly harness: Harness;
}

async function findClaudeJsonl(sessionId: string): Promise<FoundTranscript | null> {
    const projectsDir = join(homedir(), ".claude", "projects");
    let subdirs: string[];
    try { subdirs = await readdir(projectsDir); } catch { return null; }
    for (const sub of subdirs) {
        const candidate = join(projectsDir, sub, `${sessionId}.jsonl`);
        try {
            await stat(candidate);
            return { path: candidate, harness: "claude" };
        } catch { /* not here */ }
    }
    return null;
}

/** Codex transcripts live under ~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{sessionId}.jsonl */
async function findCodexJsonl(sessionId: string): Promise<FoundTranscript | null> {
    const root = join(homedir(), ".codex", "sessions");
    try {
        for (const year of await readdir(root)) {
            const yearDir = join(root, year);
            for (const month of await readdir(yearDir).catch(() => [])) {
                const monthDir = join(yearDir, month);
                for (const day of await readdir(monthDir).catch(() => [])) {
                    const dayDir = join(monthDir, day);
                    for (const file of await readdir(dayDir).catch(() => [])) {
                        if (file.endsWith(`-${sessionId}.jsonl`)) {
                            return { path: join(dayDir, file), harness: "codex" };
                        }
                    }
                }
            }
        }
    } catch { /* root missing */ }
    return null;
}

async function findTranscript(sessionId: string): Promise<FoundTranscript> {
    const claude = await findClaudeJsonl(sessionId);
    if (claude) return claude;
    const codex = await findCodexJsonl(sessionId);
    if (codex) return codex;
    throw new Error(`session transcript not found: ${sessionId}.jsonl`);
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

function dominantKind(spans: readonly TurnSpan[], fallback: InspectSpanKind): InspectSpanKind {
    if (spans.length === 0) return fallback;
    const sizes = new Map<InspectSpanKind, number>();
    for (const s of spans) sizes.set(s.kind, (sizes.get(s.kind) ?? 0) + s.text.length);
    let best: InspectSpanKind = fallback;
    let bestSize = -1;
    for (const [k, sz] of sizes) {
        if (sz > bestSize) { best = k; bestSize = sz; }
    }
    return best;
}

const toSpanDto = (s: TurnSpan): InspectSpanDto =>
    s.label !== undefined ? { kind: s.kind, text: s.text, label: s.label } : { kind: s.kind, text: s.text };

interface CanonicalTurn {
    readonly role: string;       // 'user' | 'assistant' | 'developer' | etc.
    readonly text: string;
    readonly ts: string | null;
}

function parseClaudeLine(line: string): CanonicalTurn | null {
    let entry: JsonlMessage;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry.type !== "user" && entry.type !== "assistant") return null;
    const content = entry.message?.content;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.map(blockToText).join("") : "";
    if (!text) return null;
    return {
        role: entry.message?.role ?? entry.type,
        text,
        ts: entry.timestamp ?? null,
    };
}

/** Codex JSONL line shape - payload.type drives semantics. */
interface CodexLine {
    timestamp?: string;
    type?: string;
    payload?: {
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        name?: string;
        arguments?: string;
        output?: unknown;
        call_id?: string;
    };
}

function parseCodexLine(line: string): CanonicalTurn | null {
    let entry: CodexLine;
    try { entry = JSON.parse(line); } catch { return null; }
    const p = entry.payload;
    if (!p) return null;
    if (p.type === "message") {
        if (p.role !== "user" && p.role !== "assistant" && p.role !== "developer") return null;
        const text = Array.isArray(p.content)
            ? p.content.map((b) => (b.type === "input_text" || b.type === "output_text") ? (b.text ?? "") : "").join("")
            : "";
        if (!text) return null;
        return { role: p.role, text, ts: entry.timestamp ?? null };
    }
    if (p.type === "function_call") {
        const name = p.name ?? "function";
        const args = p.arguments ?? "{}";
        const clipped = args.length > 400 ? `${args.slice(0, 400)}...` : args;
        return {
            role: "assistant",
            text: `<tool_use name="${name.replace(/"/g, "")}">${clipped}</tool_use>`,
            ts: entry.timestamp ?? null,
        };
    }
    if (p.type === "function_call_output") {
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? {});
        return {
            role: "user",
            text: `<local-command-stdout>${out}</local-command-stdout>`,
            ts: entry.timestamp ?? null,
        };
    }
    return null;
}

/** Read the JSONL, dissect every user/assistant message, return a wire-format
 *  payload. Side-effect free aside from file reads. */
export const fetchSessionInspect = (sessionId: string): Effect.Effect<SessionInspectPayload, Error> =>
    Effect.tryPromise({
        try: async () => {
            const found = await findTranscript(sessionId);
            const raw = await readFile(found.path, "utf8");
            const parseLine = found.harness === "codex" ? parseCodexLine : parseClaudeLine;

            const turns: InspectTurnDto[] = [];
            const totals: Partial<Record<InspectSpanKind, number>> = {};
            let totalChars = 0;
            let seq = 0;

            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                const canonical = parseLine(line);
                if (!canonical) continue;
                const { role, text, ts } = canonical;
                const fallbackKind: InspectSpanKind = role === "assistant" ? "assistant_text" : "user_input";
                const spans = dissectTurn(text, { defaultKind: fallbackKind });
                const semantic = dominantKind(spans, fallbackKind);

                for (const s of spans) {
                    totals[s.kind] = (totals[s.kind] ?? 0) + s.text.length;
                }
                totalChars += text.length;

                turns.push({
                    seq: seq++,
                    role,
                    semantic_role: semantic,
                    ts,
                    char_count: text.length,
                    spans: spans.map(toSpanDto),
                });
            }

            return {
                session_id: sessionId,
                source_path: found.path,
                total_chars: totalChars,
                turns,
                totals_by_kind: totals,
            };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
