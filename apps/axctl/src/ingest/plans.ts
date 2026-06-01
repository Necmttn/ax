import { decodeJsonOrNull } from "@ax/lib/decode";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import type { PlanSnapshotWrite } from "./evidence-writers.ts";
import type { AgentProviderName } from "./provider-events.ts";

export type PlanStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type PlanSource = "claude_todowrite" | "claude_task" | "codex_update_plan";

export type ProviderPlanSignalStatus = "available" | "unavailable";

export type ProviderPlanSignalAvailability = {
    readonly provider: AgentProviderName;
    readonly status: ProviderPlanSignalStatus;
    readonly planSources: readonly PlanSource[];
    readonly toolNames: readonly string[];
    readonly evidence: string;
};

export type ProviderPlanDetector = {
    readonly provider: AgentProviderName;
    readonly source: PlanSource;
    readonly toolName: string;
    readonly normalize: (input: NormalizeProviderPlanInput) => NormalizedPlanSnapshot;
};

export type NormalizedPlanItem = {
    readonly externalId: string | null;
    readonly seq: number;
    readonly content: string;
    readonly activeForm: string | null;
    readonly status: PlanStatus;
};

export type NormalizedPlanSnapshot = {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: PlanSource;
    readonly ts: string;
    readonly explanation: string | null;
    readonly items: readonly NormalizedPlanItem[];
};

type ClaudeTodoWriteItemInput = {
    readonly content?: string | null;
    readonly activeForm?: string | null;
    readonly status?: string | null;
};

type ClaudeTodoWriteInput = {
    readonly todos?: readonly ClaudeTodoWriteItemInput[];
};

type CodexUpdatePlanItemInput = {
    readonly step?: string | null;
    readonly status?: string | null;
};

type CodexUpdatePlanInput = {
    readonly explanation?: string | null;
    readonly plan?: readonly CodexUpdatePlanItemInput[];
};

type NormalizeClaudeTodoWriteInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

type NormalizeCodexUpdatePlanInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

export type NormalizeProviderPlanInput = {
    readonly provider: AgentProviderName;
    readonly toolName: string;
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
};

export type PlanSnapshotWriteInput = {
    readonly snapshot: NormalizedPlanSnapshot;
    readonly snapshotSeq: number;
    readonly createdAt: string;
    readonly toolCallKey: string;
};

function stableHash(input: string): string {
    return Bun.hash(input).toString(16).padStart(16, "0");
}

function recordKeyPart(input: string, fallback = "_"): string {
    const sanitized = input
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
}

function normalizeStatus(status: string | null | undefined): PlanStatus {
    if (status === "in_progress" || status === "completed" || status === "abandoned") {
        return status;
    }
    return "pending";
}

function parseMaybeJsonObject(input: unknown): Record<string, unknown> {
    if (typeof input === "string") {
        const parsed = decodeJsonOrNull(input);
        return isRecord(parsed) ? parsed : {};
    }
    return isRecord(input) ? input : {};
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function asRecordArray(input: unknown): Record<string, unknown>[] {
    if (!Array.isArray(input)) return [];
    return input.filter(isRecord);
}

function normalizeClaudeTodoWritePayload({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTodoWriteInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input) as ClaudeTodoWriteInput;

    for (const todo of asRecordArray(raw.todos)) {
        const content = nonEmptyString(typeof todo.content === "string" ? todo.content : null);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: nonEmptyString(
                typeof todo.activeForm === "string" ? todo.activeForm : null,
            ),
            status: normalizeStatus(typeof todo.status === "string" ? todo.status : null),
        });
    }

    return {
        provider: "claude",
        sessionId,
        source: "claude_todowrite",
        ts,
        explanation: null,
        items,
    };
}

function normalizeCodexUpdatePlanPayload({
    sessionId,
    ts,
    input,
}: NormalizeCodexUpdatePlanInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];
    const raw = parseMaybeJsonObject(input) as CodexUpdatePlanInput;

    for (const planItem of asRecordArray(raw.plan)) {
        const content = nonEmptyString(typeof planItem.step === "string" ? planItem.step : null);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: null,
            status: normalizeStatus(typeof planItem.status === "string" ? planItem.status : null),
        });
    }

    return {
        provider: "codex",
        sessionId,
        source: "codex_update_plan",
        ts,
        explanation: nonEmptyString(typeof raw.explanation === "string" ? raw.explanation : null),
        items,
    };
}

export const providerPlanDetectors: readonly ProviderPlanDetector[] = [
    {
        provider: "claude",
        source: "claude_todowrite",
        toolName: "TodoWrite",
        normalize: ({ sessionId, ts, input }) =>
            normalizeClaudeTodoWritePayload({ sessionId, ts, input }),
    },
    {
        provider: "codex",
        source: "codex_update_plan",
        toolName: "update_plan",
        normalize: ({ sessionId, ts, input }) =>
            normalizeCodexUpdatePlanPayload({ sessionId, ts, input }),
    },
];

export const providerPlanSignalAvailability: Readonly<Record<AgentProviderName, ProviderPlanSignalAvailability>> = {
    claude: {
        provider: "claude",
        status: "available",
        planSources: ["claude_todowrite"],
        toolNames: ["TodoWrite"],
        evidence: "Claude transcript tool_use blocks expose TodoWrite todos.",
    },
    codex: {
        provider: "codex",
        status: "available",
        planSources: ["codex_update_plan"],
        toolNames: ["update_plan"],
        evidence: "Codex session JSONL exposes update_plan function call arguments.",
    },
    pi: {
        provider: "pi",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current Pi JSONL fixtures expose message, custom, and generic toolCall blocks; no raw plan snapshot payload equivalent is present.",
    },
    opencode: {
        provider: "opencode",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current OpenCode SQLite fixtures expose sessions/messages/parts only; no tool-call or plan snapshot rows are ingested yet.",
    },
    cursor: {
        provider: "cursor",
        status: "unavailable",
        planSources: [],
        toolNames: [],
        evidence: "Current Cursor state.vscdb fixtures expose composer messages/bubbles only; no raw plan snapshot payload equivalent is present.",
    },
};

export function normalizeProviderPlanSnapshot(
    input: NormalizeProviderPlanInput,
): NormalizedPlanSnapshot | null {
    const detector = providerPlanDetectors.find((candidate) =>
        candidate.provider === input.provider && candidate.toolName === input.toolName
    );
    return detector?.normalize(input) ?? null;
}

export function normalizeClaudeTodoWrite(
    input: NormalizeClaudeTodoWriteInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "claude",
        toolName: "TodoWrite",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Claude TodoWrite plan detector");
    }
    return normalized;
}

export function normalizeCodexUpdatePlan(
    input: NormalizeCodexUpdatePlanInput,
): NormalizedPlanSnapshot {
    const normalized = normalizeProviderPlanSnapshot({
        provider: "codex",
        toolName: "update_plan",
        ...input,
    });
    if (normalized === null) {
        throw new Error("missing Codex update_plan detector");
    }
    return normalized;
}

export function planKey(sessionId: string, provider: AgentProviderName, source: string): string {
    return [
        provider,
        recordKeyPart(sessionId, "session").slice(0, 80),
        recordKeyPart(source, "source"),
        stableHash(`${sessionId}:${source}`).slice(0, 16),
    ].join("__");
}

export function planSnapshotKey(input: {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: string;
    readonly snapshotSeq: number;
    readonly toolCallKey: string;
}): string {
    return [
        planKey(input.sessionId, input.provider, input.source),
        `snapshot_${input.snapshotSeq.toString(10).padStart(6, "0")}`,
        stableHash(input.toolCallKey).slice(0, 12),
    ].join("__");
}

export function planItemKey(input: {
    readonly provider: AgentProviderName;
    readonly sessionId: string;
    readonly source: string;
    readonly seq: number;
}): string {
    return [
        planKey(input.sessionId, input.provider, input.source),
        `item_${input.seq.toString(10).padStart(3, "0")}`,
    ].join("__");
}

export function planStatus(items: readonly { status: PlanStatus }[]): PlanStatus {
    if (items.some((item) => item.status === "in_progress")) return "in_progress";
    if (items.length > 0 && items.every((item) => item.status === "completed")) {
        return "completed";
    }
    if (items.some((item) => item.status === "pending")) return "pending";
    if (items.length > 0 && items.every((item) => item.status === "abandoned")) {
        return "abandoned";
    }
    return "pending";
}

export function toPlanSnapshotWrite({
    snapshot,
    snapshotSeq,
    createdAt,
    toolCallKey,
}: PlanSnapshotWriteInput): PlanSnapshotWrite {
    const items = snapshot.items.map((item) => ({
        key: planItemKey({
            provider: snapshot.provider,
            sessionId: snapshot.sessionId,
            source: snapshot.source,
            seq: item.seq,
        }),
        externalId: item.externalId,
        seq: item.seq,
        content: item.content,
        activeForm: item.activeForm,
        status: item.status,
    }));

    return {
        planKey: planKey(snapshot.sessionId, snapshot.provider, snapshot.source),
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        status: planStatus(snapshot.items),
        createdAt,
        updatedAt: snapshot.ts,
        snapshotKey: planSnapshotKey({
            provider: snapshot.provider,
            sessionId: snapshot.sessionId,
            source: snapshot.source,
            snapshotSeq,
            toolCallKey,
        }),
        toolCallKey,
        itemsJson: snapshot.items,
        explanation: snapshot.explanation,
        ts: snapshot.ts,
        items,
    };
}
