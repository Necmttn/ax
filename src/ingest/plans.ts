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
    readonly input: ClaudeTodoWriteInput;
};

type NormalizeCodexUpdatePlanInput = {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: CodexUpdatePlanInput;
};

function normalizeStatus(status: string | null | undefined): PlanStatus {
    if (status === "in_progress" || status === "completed" || status === "abandoned") {
        return status;
    }
    return "pending";
}

function nonEmptyString(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalizeClaudeTodoWrite({
    sessionId,
    ts,
    input,
}: NormalizeClaudeTodoWriteInput): NormalizedPlanSnapshot {
    const items: NormalizedPlanItem[] = [];

    for (const todo of input.todos ?? []) {
        const content = nonEmptyString(todo.content);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: nonEmptyString(todo.activeForm),
            status: normalizeStatus(todo.status),
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

    for (const planItem of input.plan ?? []) {
        const content = nonEmptyString(planItem.step);
        if (!content) continue;

        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: null,
            status: normalizeStatus(planItem.status),
        });
    }

    return {
        sessionId,
        source: "codex_update_plan",
        ts,
        explanation: nonEmptyString(input.explanation),
        items,
    };
}
