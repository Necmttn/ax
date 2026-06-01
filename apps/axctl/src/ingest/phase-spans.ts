export type PhaseName =
    | "planning"
    | "context_gathering"
    | "implementation"
    | "verification"
    | "finalization";

export interface PhaseToolCall {
    readonly name?: string | null;
    readonly commandText?: string | null;
    readonly commandNorm?: string | null;
    readonly inputJson?: unknown;
    readonly outputExcerpt?: string | null;
    readonly errorText?: string | null;
}

export interface PhaseTurn {
    readonly seq: number;
    readonly role: string;
    readonly ts: Date | string | null;
    readonly text?: string | null;
    readonly textExcerpt?: string | null;
    readonly text_excerpt?: string | null;
    readonly toolCalls?: readonly (PhaseToolCall | string)[] | null;
    readonly toolCallCount?: number | null;
}

export interface PhaseSpan {
    readonly phase: PhaseName;
    readonly startSeq: number;
    readonly endSeq: number;
    readonly startTs: Date | null;
    readonly endTs: Date | null;
    readonly durationMs: number;
    readonly userTurns: number;
    readonly assistantTurns: number;
    readonly toolCalls: number;
}

export interface InteractionRhythm {
    readonly totalDurationMs: number;
    readonly userTurns: number;
    readonly assistantTurns: number;
    readonly longestHandsFreeMs: number;
    readonly corrections: number;
}

interface OrderedTurn {
    readonly turn: PhaseTurn;
    readonly index: number;
    readonly ts: Date | null;
}

export function derivePhaseSpans(turns: readonly PhaseTurn[]): PhaseSpan[] {
    const ordered = orderedTurns(turns);
    const spans: MutablePhaseSpan[] = [];

    for (const item of ordered) {
        const phase = classifyPhase(item.turn);
        const current = spans.at(-1);

        if (!current || current.phase !== phase) {
            if (current) closeSpanAt(current, item.ts);
            spans.push(newSpan(phase, item));
            continue;
        }

        addTurn(current, item);
    }

    return spans.map((span) => ({ ...span }));
}

export function summarizeInteractionRhythm(turns: readonly PhaseTurn[]): InteractionRhythm {
    const ordered = orderedTurns(turns);
    const firstTs = ordered[0]?.ts ?? null;
    const lastTs = ordered.at(-1)?.ts ?? null;
    let userTurns = 0;
    let assistantTurns = 0;
    let corrections = 0;

    for (const item of ordered) {
        const role = item.turn.role.toLowerCase();
        if (role === "user") {
            userTurns += 1;
            if (isCorrectionText(turnText(item.turn))) corrections += 1;
        } else if (role === "assistant") {
            assistantTurns += 1;
        }
    }

    let longestHandsFreeMs = 0;
    for (const durationMs of handsFreeDurations(ordered)) {
        longestHandsFreeMs = Math.max(longestHandsFreeMs, durationMs);
    }

    return {
        totalDurationMs: durationBetween(firstTs, lastTs),
        userTurns,
        assistantTurns,
        longestHandsFreeMs,
        corrections,
    };
}

interface MutablePhaseSpan {
    phase: PhaseName;
    startSeq: number;
    endSeq: number;
    startTs: Date | null;
    endTs: Date | null;
    durationMs: number;
    userTurns: number;
    assistantTurns: number;
    toolCalls: number;
}

function newSpan(phase: PhaseName, item: OrderedTurn): MutablePhaseSpan {
    const span: MutablePhaseSpan = {
        phase,
        startSeq: item.turn.seq,
        endSeq: item.turn.seq,
        startTs: item.ts,
        endTs: item.ts,
        durationMs: 0,
        userTurns: 0,
        assistantTurns: 0,
        toolCalls: 0,
    };
    addTurnCounts(span, item.turn);
    return span;
}

function addTurn(span: MutablePhaseSpan, item: OrderedTurn): void {
    span.endSeq = item.turn.seq;
    span.endTs = item.ts;
    span.durationMs = durationBetween(span.startTs, span.endTs);
    addTurnCounts(span, item.turn);
}

function addTurnCounts(span: MutablePhaseSpan, turn: PhaseTurn): void {
    const role = turn.role.toLowerCase();
    if (role === "user") span.userTurns += 1;
    if (role === "assistant") span.assistantTurns += 1;
    span.toolCalls += toolCallCount(turn);
}

function closeSpanAt(span: MutablePhaseSpan, boundaryTs: Date | null): void {
    span.endTs = boundaryTs;
    span.durationMs = durationBetween(span.startTs, span.endTs);
}

function classifyPhase(turn: PhaseTurn): PhaseName {
    const text = phaseText(turn);
    const calls = toolCallCount(turn);

    if (isFinalizationText(turnText(turn))) return "finalization";
    if (/\b(apply_patch|patch|edit|editing|write|multiedit|multi_edit)\b/.test(text)) return "implementation";
    if (isFinalizationText(text)) return "finalization";
    if (/\b(test|tests|typecheck|tsc|lint|build|check)\b/.test(text)) return "verification";
    if (calls > 0 || /\b(rg|sed|grep|find|cat|ls|read)\b/.test(text)) return "context_gathering";

    return "planning";
}

function orderedTurns(turns: readonly PhaseTurn[]): OrderedTurn[] {
    return turns
        .map((turn, index) => ({ turn, index, ts: normalizeTs(turn.ts) }))
        .sort((a, b) => a.turn.seq - b.turn.seq || compareTs(a.ts, b.ts) || a.index - b.index);
}

function compareTs(a: Date | null, b: Date | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.getTime() - b.getTime();
}

function normalizeTs(value: Date | string | null): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value !== "string" || value.length === 0) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function durationBetween(start: Date | null, end: Date | null): number {
    if (!start || !end) return 0;
    return Math.max(0, end.getTime() - start.getTime());
}

function turnText(turn: PhaseTurn): string {
    return turn.text ?? turn.textExcerpt ?? turn.text_excerpt ?? "";
}

function phaseText(turn: PhaseTurn): string {
    return [turnText(turn), ...toolCallActionTexts(turn.toolCalls)].join("\n").toLowerCase();
}

function toolCallActionTexts(calls: readonly (PhaseToolCall | string)[] | null | undefined): string[] {
    if (!calls) return [];
    return calls.map((call) => {
        if (typeof call === "string") return call;
        return [
            call.name,
            call.commandText,
            call.commandNorm,
            stringifyUnknown(call.inputJson),
        ]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n");
    });
}

function stringifyUnknown(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function toolCallCount(turn: PhaseTurn): number {
    if (typeof turn.toolCallCount === "number") return Math.max(0, turn.toolCallCount);
    return turn.toolCalls?.length ?? 0;
}

function handsFreeDurations(turns: readonly OrderedTurn[]): number[] {
    const durations: number[] = [];

    for (let i = 0; i < turns.length; i += 1) {
        const start = turns[i];
        if (start.turn.role.toLowerCase() !== "user" || !start.ts) continue;

        let lastActivityTs: Date | null = null;
        for (let j = i + 1; j < turns.length; j += 1) {
            const item = turns[j];
            if (item.turn.role.toLowerCase() === "user") break;
            if (isAssistantOrToolActivity(item)) lastActivityTs = item.ts;
        }

        if (lastActivityTs) durations.push(durationBetween(start.ts, lastActivityTs));
    }

    return durations;
}

function isAssistantOrToolActivity(item: OrderedTurn): boolean {
    const role = item.turn.role.toLowerCase();
    return role === "assistant" || role === "tool" || role === "tool_call" || toolCallCount(item.turn) > 0;
}

function isCorrectionText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return /^(?:no\s*,|not that\b|i meant\b|actually\b|did you test\b)/.test(normalized);
}

function isFinalizationText(text: string): boolean {
    return /\b(final|done|completed|complete)\b/i.test(text);
}
