import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionInt,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";

export type CompactionStrategy = "summarize" | "history_replacement" | "encrypted";
export type CompactionTrigger = "auto" | "manual" | "hook";
export type CompactionConfidence = "explicit" | "derived";

export interface CompactionWrite {
    readonly compactionKey: string;
    readonly sessionId: string;
    readonly agentEventKey?: string | null;
    readonly harness: string;
    readonly ts: Date;
    readonly trigger?: CompactionTrigger | null;
    readonly strategy: CompactionStrategy;
    readonly sourceConfidence: CompactionConfidence;
    readonly summary?: string | null;
    readonly tokensBefore?: number | null;
    readonly boundaryRef?: string | null;
    readonly keptCount?: number | null;
    readonly readFiles?: readonly string[] | null;
    readonly modifiedFiles?: readonly string[] | null;
    readonly raw?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringArray = (v: unknown): readonly string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

export const compactionRecordKey = (
    harness: string,
    providerSessionId: string,
    seq: number,
): string => `${harness}_${providerSessionId}_cmp_${seq}`.replace(/[^A-Za-z0-9_]/g, "_");

export const buildCompactionStatements = (
    writes: readonly CompactionWrite[],
): string[] =>
    writes.map(
        (c) =>
            `UPSERT ${recordRef("compaction", c.compactionKey)} CONTENT ${surrealObject([
                ["session", recordRef("session", c.sessionId)],
                ["agent_event", surrealOptionRecord("agent_event", c.agentEventKey ?? null)],
                ["harness", surrealString(c.harness)],
                ["ts", surrealDate(c.ts)],
                ["trigger", surrealOptionString(c.trigger ?? null)],
                ["strategy", surrealString(c.strategy)],
                ["source_confidence", surrealString(c.sourceConfidence)],
                ["summary", surrealOptionString(c.summary ?? null)],
                ["tokens_before", surrealOptionInt(c.tokensBefore ?? null)],
                ["boundary_ref", surrealOptionString(c.boundaryRef ?? null)],
                ["kept_count", surrealOptionInt(c.keptCount ?? null)],
                ["read_files", surrealJsonTextOption(c.readFiles ?? null)],
                ["modified_files", surrealJsonTextOption(c.modifiedFiles ?? null)],
                ["raw", surrealJsonTextOption(c.raw ?? null)],
            ])};`,
    );

export interface PiCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
}

export const extractPiCompaction = (
    entry: Record<string, unknown>,
    ctx: PiCompactionCtx,
): CompactionWrite | null => {
    if (entry.type !== "compaction") return null;
    const details = isRecord(entry.details) ? entry.details : null;
    return {
        compactionKey: compactionRecordKey("pi", ctx.providerSessionId, ctx.seq),
        sessionId: ctx.sessionId,
        agentEventKey: ctx.agentEventKey ?? null,
        harness: "pi",
        ts: ctx.ts,
        trigger: entry.fromHook === true ? "hook" : "auto",
        strategy: "summarize",
        sourceConfidence: "explicit",
        summary: typeof entry.summary === "string" ? entry.summary : null,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
        boundaryRef:
            typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : null,
        keptCount: null,
        readFiles: details ? stringArray(details.readFiles) : null,
        modifiedFiles: details ? stringArray(details.modifiedFiles) : null,
        raw: { fromHook: entry.fromHook === true },
    };
};

export interface CodexCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly tokensBefore?: number | null;
    readonly boundaryRef?: string | null;
}

export const extractCodexCompaction = (
    payload: Record<string, unknown>,
    ctx: CodexCompactionCtx,
): CompactionWrite | null => {
    const replacement = Array.isArray(payload.replacement_history)
        ? payload.replacement_history
        : [];
    const message = typeof payload.message === "string" ? payload.message : "";
    return {
        compactionKey: compactionRecordKey("codex", ctx.providerSessionId, ctx.seq),
        sessionId: ctx.sessionId,
        agentEventKey: ctx.agentEventKey ?? null,
        harness: "codex",
        ts: ctx.ts,
        trigger: message.length > 0 ? "manual" : "auto",
        strategy: "history_replacement",
        sourceConfidence: "explicit",
        summary: message.length > 0 ? message : null,
        tokensBefore: ctx.tokensBefore ?? null,
        boundaryRef: ctx.boundaryRef ?? null,
        keptCount: replacement.length,
        readFiles: null,
        modifiedFiles: null,
        raw: { replacement_count: replacement.length },
    };
};

export interface ClaudeCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly summary: string | null;
    readonly boundaryRef?: string | null;
}

export const extractClaudeCompaction = (
    ctx: ClaudeCompactionCtx,
): CompactionWrite => ({
    compactionKey: compactionRecordKey("claude", ctx.providerSessionId, ctx.seq),
    sessionId: ctx.sessionId,
    agentEventKey: ctx.agentEventKey ?? null,
    harness: "claude",
    ts: ctx.ts,
    trigger: "auto",
    strategy: "summarize",
    sourceConfidence: "explicit",
    summary: ctx.summary,
    tokensBefore: null,
    boundaryRef: ctx.boundaryRef ?? null,
    keptCount: null,
    readFiles: null,
    modifiedFiles: null,
    raw: null,
});

export interface CursorCompactionCtx {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
    readonly boundaryRef?: string | null;
    readonly summarizedComposers: readonly string[];
}

export const extractCursorCompaction = (
    ctx: CursorCompactionCtx,
): CompactionWrite => ({
    compactionKey: compactionRecordKey("cursor", ctx.providerSessionId, ctx.seq),
    sessionId: ctx.sessionId,
    agentEventKey: ctx.agentEventKey ?? null,
    harness: "cursor",
    ts: ctx.ts,
    trigger: "auto",
    strategy: "encrypted",
    sourceConfidence: "explicit",
    summary: null,
    tokensBefore: null,
    boundaryRef: ctx.boundaryRef ?? null,
    keptCount: null,
    readFiles: null,
    modifiedFiles: null,
    raw: { summarized_composers: ctx.summarizedComposers },
});
