import { decodeJsonOrNull } from "../lib/decode.ts";
import { nonEmptyString } from "../lib/shared/derive-keys.ts";

export type PlanStatus = "pending" | "in_progress" | "completed" | "abandoned";

export type PlanSource = "claude_todowrite" | "claude_task" | "codex_update_plan";

export type NormalizedPlanItem = {
    readonly externalId: string | null;
    readonly seq: number;
    readonly content: string;
    readonly activeForm: string | null;
    readonly status: PlanStatus;
};

export type NormalizedPlanSnapshot = {
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

export function normalizeClaudeTodoWrite({
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
        sessionId,
        source: "claude_todowrite",
        ts,
        explanation: null,
        items,
    };
}

export function normalizeCodexUpdatePlan({
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
        sessionId,
        source: "codex_update_plan",
        ts,
        explanation: nonEmptyString(typeof raw.explanation === "string" ? raw.explanation : null),
        items,
    };
}
