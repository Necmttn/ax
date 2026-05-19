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

async function findJsonl(sessionId: string): Promise<string> {
    const projectsDir = join(homedir(), ".claude", "projects");
    const subdirs = await readdir(projectsDir);
    for (const sub of subdirs) {
        const candidate = join(projectsDir, sub, `${sessionId}.jsonl`);
        try {
            await stat(candidate);
            return candidate;
        } catch { /* not here */ }
    }
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

/** Read the JSONL, dissect every user/assistant message, return a wire-format
 *  payload. Side-effect free aside from file reads. */
export const fetchSessionInspect = (sessionId: string): Effect.Effect<SessionInspectPayload, Error> =>
    Effect.tryPromise({
        try: async () => {
            const jsonlPath = await findJsonl(sessionId);
            const raw = await readFile(jsonlPath, "utf8");

            const turns: InspectTurnDto[] = [];
            const totals: Partial<Record<InspectSpanKind, number>> = {};
            let totalChars = 0;
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
                    ts: entry.timestamp ?? null,
                    char_count: text.length,
                    spans: spans.map(toSpanDto),
                });
            }

            return {
                session_id: sessionId,
                source_path: jsonlPath,
                total_chars: totalChars,
                turns,
                totals_by_kind: totals,
            };
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });
