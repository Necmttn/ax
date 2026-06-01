import { recordKeyPart, safeKeyPart } from "@ax/lib/shared/derive-keys";
import type { EventToolCall, EventTurn, EventWindow } from "./core.ts";

export interface ClassifierTurnRow {
    readonly id: unknown;
    readonly session: unknown;
    readonly seq: number;
    readonly role: string;
    readonly message_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly ts: string | Date;
}

export interface ClassifierToolCallRow {
    readonly id: unknown;
    readonly session: unknown;
    readonly seq?: number | null;
    readonly name?: string | null;
    readonly command_norm?: string | null;
    readonly command_text?: string | null;
    readonly output_excerpt?: string | null;
    readonly error_text?: string | null;
    readonly has_error?: boolean | null;
    readonly ts: string | Date;
}

const textOf = (row: ClassifierTurnRow): string =>
    (row.text_excerpt ?? row.text ?? "").trim();

const rowKey = (row: ClassifierTurnRow): string =>
    recordKeyPart(row.id, "turn") ?? safeKeyPart(String(row.id));

const sessionKey = (row: ClassifierTurnRow): string | null =>
    recordKeyPart(row.session, "session");

const toolCallSessionKey = (row: ClassifierToolCallRow): string | null =>
    recordKeyPart(row.session, "session");

const toolCallKey = (row: ClassifierToolCallRow): string =>
    recordKeyPart(row.id, "tool_call") ?? safeKeyPart(String(row.id));

const toTurn = (row: ClassifierTurnRow): EventTurn => ({
    id: rowKey(row),
    key: rowKey(row),
    seq: row.seq,
    role: row.role,
    text: textOf(row),
    ts: row.ts,
});

const isAssistant = (row: ClassifierTurnRow): boolean =>
    row.role === "assistant" || row.message_kind === "assistant";

const isUser = (row: ClassifierTurnRow): boolean =>
    row.role === "user" && row.message_kind !== "system_or_developer";

const isTool = (row: ClassifierTurnRow): boolean =>
    row.role === "tool" || row.role === "tool_result" || row.message_kind === "tool_result";

const isToolFailure = (row: ClassifierTurnRow, text: string): boolean =>
    isTool(row) && /\b(error|failed|failure|exception|traceback|permission denied|not found|dependency|exit code)\b/i.test(text);

const toToolCall = (row: ClassifierTurnRow): EventToolCall => ({
    id: rowKey(row),
    sourceTable: "turn",
    text: textOf(row).slice(0, 1000),
    ts: row.ts,
});

const toolCallText = (row: ClassifierToolCallRow): string =>
    [
        row.command_norm,
        row.command_text,
        row.error_text,
        row.output_excerpt,
        row.name,
    ].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n").slice(0, 1000);

const toCanonicalToolCall = (row: ClassifierToolCallRow): EventToolCall => ({
    id: toolCallKey(row),
    sourceTable: "tool_call",
    ...(row.name === undefined ? {} : { name: row.name }),
    text: toolCallText(row),
    ts: row.ts,
});

const timeValue = (value: string | Date | null | undefined): number => {
    if (!value) return 0;
    const date = value instanceof Date ? value : new Date(value);
    const n = date.getTime();
    return Number.isFinite(n) ? n : 0;
};

const mergeRecentToolCalls = (
    first: readonly EventToolCall[],
    second: readonly EventToolCall[],
    limit: number,
): readonly EventToolCall[] => {
    const byKey = new Map<string, EventToolCall>();
    for (const call of [...first, ...second]) {
        byKey.set(`${call.sourceTable ?? "turn"}:${call.id}`, call);
    }
    return [...byKey.values()]
        .sort((a, b) => timeValue(a.ts) - timeValue(b.ts))
        .slice(-limit);
};

export function buildEventWindows(rows: readonly ClassifierTurnRow[]): EventWindow[] {
    const previousAssistantBySession = new Map<string, EventTurn>();
    const recentToolCallsBySession = new Map<string, EventToolCall[]>();
    const recentToolFailuresBySession = new Map<string, EventToolCall[]>();
    const windows: EventWindow[] = [];

    for (const row of rows) {
        const sid = sessionKey(row) ?? "unknown";
        const text = textOf(row);
        if (isAssistant(row)) {
            previousAssistantBySession.set(sid, toTurn(row));
            continue;
        }
        if (isTool(row)) {
            const toolCall = toToolCall(row);
            const toolCalls = [...(recentToolCallsBySession.get(sid) ?? []), toolCall].slice(-5);
            recentToolCallsBySession.set(sid, toolCalls);
            if (isToolFailure(row, text)) {
                const failures = [...(recentToolFailuresBySession.get(sid) ?? []), toolCall].slice(-3);
                recentToolFailuresBySession.set(sid, failures);
            }
            continue;
        }
        if (!isUser(row)) continue;

        const subjectId = rowKey(row);
        windows.push({
            key: `${safeKeyPart(sid)}__${safeKeyPart(subjectId)}`,
            subjectType: "event_window",
            subjectId,
            sessionId: sessionKey(row),
            userTurn: toTurn(row),
            previousAssistantTurn: previousAssistantBySession.get(sid) ?? null,
            recentToolCalls: recentToolCallsBySession.get(sid) ?? [],
            recentToolFailures: recentToolFailuresBySession.get(sid) ?? [],
            recentFiles: [],
            existingLabels: [],
        });
    }

    return windows;
}

export function enrichEventWindowsWithToolCalls(
    windows: readonly EventWindow[],
    toolCalls: readonly ClassifierToolCallRow[],
): EventWindow[] {
    const bySession = new Map<string, ClassifierToolCallRow[]>();
    for (const row of toolCalls) {
        const sid = toolCallSessionKey(row);
        if (!sid) continue;
        const rows = bySession.get(sid) ?? [];
        rows.push(row);
        bySession.set(sid, rows);
    }
    for (const rows of bySession.values()) {
        rows.sort((a, b) => timeValue(a.ts) - timeValue(b.ts));
    }

    return windows.map((window) => {
        if (!window.sessionId) return window;
        const candidates = bySession.get(window.sessionId) ?? [];
        const beforeWindow = candidates.filter((row) => timeValue(row.ts) <= timeValue(window.userTurn.ts));
        const recentCanonicalCalls = beforeWindow.slice(-5).map(toCanonicalToolCall);
        const recentCanonicalFailures = beforeWindow
            .filter((row) => row.has_error === true)
            .slice(-3)
            .map(toCanonicalToolCall);
        return {
            ...window,
            recentToolCalls: mergeRecentToolCalls(window.recentToolCalls, recentCanonicalCalls, 5),
            recentToolFailures: mergeRecentToolCalls(window.recentToolFailures, recentCanonicalFailures, 3),
        };
    });
}
