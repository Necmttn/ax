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
import { isRecord, stringArray } from "./normalized/toolkit.ts";

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

/** The per-event context every harness shares; provider extractors extend it
 *  with harness-specific fields (tokensBefore, boundaryRef, summary, ...). */
export interface CompactionCtxBase {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly seq: number;
    readonly ts: Date;
    readonly agentEventKey?: string | null;
}

/** The harness-interpreted slice of a CompactionWrite - everything that is
 *  NOT mechanically derived from {@link CompactionCtxBase}. */
interface CompactionWriteParts {
    readonly trigger: CompactionTrigger | null;
    readonly strategy: CompactionStrategy;
    readonly summary?: string | null;
    readonly tokensBefore?: number | null;
    readonly boundaryRef?: string | null;
    readonly keptCount?: number | null;
    readonly readFiles?: readonly string[] | null;
    readonly modifiedFiles?: readonly string[] | null;
    readonly raw?: unknown;
}

/**
 * The ONE shared CompactionWrite build path (Parser Toolkit): record key,
 * session/event linkage, and null-defaults are derived here; each provider
 * extractor below only interprets its raw event into {@link CompactionWriteParts}.
 * All provider compactions are explicit signals today, hence the fixed
 * `sourceConfidence`.
 */
const makeCompactionWrite = (
    harness: string,
    ctx: CompactionCtxBase,
    parts: CompactionWriteParts,
): CompactionWrite => ({
    compactionKey: compactionRecordKey(harness, ctx.providerSessionId, ctx.seq),
    sessionId: ctx.sessionId,
    agentEventKey: ctx.agentEventKey ?? null,
    harness,
    ts: ctx.ts,
    trigger: parts.trigger,
    strategy: parts.strategy,
    sourceConfidence: "explicit",
    summary: parts.summary ?? null,
    tokensBefore: parts.tokensBefore ?? null,
    boundaryRef: parts.boundaryRef ?? null,
    keptCount: parts.keptCount ?? null,
    readFiles: parts.readFiles ?? null,
    modifiedFiles: parts.modifiedFiles ?? null,
    raw: parts.raw ?? null,
});

export type PiCompactionCtx = CompactionCtxBase;

export const extractPiCompaction = (
    entry: Record<string, unknown>,
    ctx: PiCompactionCtx,
    // Pi forks (omp) share this extractor; the harness label keeps their
    // compaction rows + record keys provider-distinct (#636).
    harness: string = "pi",
): CompactionWrite | null => {
    if (entry.type !== "compaction") return null;
    const details = isRecord(entry.details) ? entry.details : null;
    return makeCompactionWrite(harness, ctx, {
        trigger: entry.fromHook === true ? "hook" : "auto",
        strategy: "summarize",
        summary: typeof entry.summary === "string" ? entry.summary : null,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
        boundaryRef:
            typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : null,
        readFiles: details ? stringArray(details.readFiles) : null,
        modifiedFiles: details ? stringArray(details.modifiedFiles) : null,
        raw: { fromHook: entry.fromHook === true },
    });
};

export interface CodexCompactionCtx extends CompactionCtxBase {
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
    return makeCompactionWrite("codex", ctx, {
        trigger: message.length > 0 ? "manual" : "auto",
        strategy: "history_replacement",
        summary: message.length > 0 ? message : null,
        tokensBefore: ctx.tokensBefore ?? null,
        boundaryRef: ctx.boundaryRef ?? null,
        keptCount: replacement.length,
        raw: { replacement_count: replacement.length },
    });
};

export interface ClaudeCompactionCtx extends CompactionCtxBase {
    readonly summary: string | null;
    readonly boundaryRef?: string | null;
}

export const extractClaudeCompaction = (
    ctx: ClaudeCompactionCtx,
): CompactionWrite =>
    makeCompactionWrite("claude", ctx, {
        trigger: "auto",
        strategy: "summarize",
        summary: ctx.summary,
        boundaryRef: ctx.boundaryRef ?? null,
    });

export interface CursorCompactionCtx extends CompactionCtxBase {
    readonly boundaryRef?: string | null;
    readonly summarizedComposers: readonly string[];
}

export const extractCursorCompaction = (
    ctx: CursorCompactionCtx,
): CompactionWrite =>
    makeCompactionWrite("cursor", ctx, {
        trigger: "auto",
        strategy: "encrypted",
        boundaryRef: ctx.boundaryRef ?? null,
        raw: { summarized_composers: ctx.summarizedComposers },
    });
