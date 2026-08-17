import type { DerivedSignal } from "./signals.ts";
import { GUIDANCE_STATUS_PROPOSED } from "../improve/lifecycle.ts";

export interface GuidanceDraft {
    readonly key: string;
    readonly versionKey: string;
    readonly slug: string;
    readonly title: string;
    readonly text: string;
    readonly status: typeof GUIDANCE_STATUS_PROPOSED;
    readonly scope: "project" | "repository" | "checkout" | "global";
    readonly risk: "low" | "medium" | "high";
    readonly evidenceIds: readonly string[];
    readonly metrics: Record<string, number>;
    readonly createdAt: string;
}

function hashKey(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

export function guidanceFromSignal(signal: DerivedSignal): GuidanceDraft {
    const slug = `${signal.kind}__${hashKey(signal.subjectId).slice(0, 12)}`;
    const title = signal.kind === "missing_verification"
        ? "Require verification after edits"
        : "Reduce repeated command failures";
    const text = signal.kind === "missing_verification"
        ? "After changing files, run the narrowest relevant verification command before reporting completion."
        : `When ${signal.subjectId} fails repeatedly, inspect the first failure before retrying.`;
    return {
        key: slug,
        versionKey: `${slug}__v1`,
        slug,
        title,
        text,
        status: GUIDANCE_STATUS_PROPOSED,
        scope: "project",
        risk: "low",
        evidenceIds: signal.evidenceIds,
        metrics: signal.metrics,
        createdAt: signal.ts,
    };
}
