import type { DerivedSignal } from "./signals.ts";
import { surrealJson, surrealString } from "../lib/shared/surql.ts";

export interface GuidanceDraft {
    readonly key: string;
    readonly versionKey: string;
    readonly slug: string;
    readonly title: string;
    readonly text: string;
    readonly status: "proposed";
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
        status: "proposed",
        scope: "project",
        risk: "low",
        evidenceIds: signal.evidenceIds,
        metrics: signal.metrics,
        createdAt: signal.ts,
    };
}

export function buildGuidanceWriteStatements(guidance: GuidanceDraft): string[] {
    const artifactStatements = guidance.evidenceIds.map((evidenceId) =>
        `UPSERT artifact:\`${hashKey(evidenceId)}\` MERGE { kind: "signal_evidence", uri: ${surrealString(evidenceId)}, title: ${surrealString(evidenceId)}, raw: ${surrealJson({ evidenceId })}, created_at: time::now() };`,
    );
    const derivedFromStatements = guidance.evidenceIds.map((evidenceId) => {
        const edgeKey = hashKey(`${guidance.versionKey}|${evidenceId}`);
        return `RELATE guidance_version:\`${guidance.versionKey}\`->derived_from:\`${edgeKey}\`->artifact:\`${hashKey(evidenceId)}\` SET kind = "signal_evidence", labels = ${surrealJson({ evidenceId })};`;
    });
    return [
        `UPSERT guidance:\`${guidance.key}\` MERGE { slug: ${surrealString(guidance.slug)}, title: ${surrealString(guidance.title)}, status: "proposed", updated_at: time::now() };`,
        `UPSERT guidance_version:\`${guidance.versionKey}\` CONTENT { guidance: guidance:\`${guidance.key}\`, version: "v1", text: ${surrealString(guidance.text)}, status: ${surrealString(guidance.status)}, scope: ${surrealString(guidance.scope)}, risk: ${surrealString(guidance.risk)}, evidence: ${surrealJson(guidance.evidenceIds)}, metrics_before: ${surrealJson(guidance.metrics)}, metrics_after: NONE, raw: ${surrealJson(guidance)}, created_at: d${surrealString(guidance.createdAt)} };`,
        ...artifactStatements,
        ...derivedFromStatements,
    ];
}
