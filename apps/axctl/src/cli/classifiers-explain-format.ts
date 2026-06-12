import { prettyPrint } from "@ax/lib/json";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import type { ClassifierExplainPayload, ClassifierExplainResult } from "../dashboard/classifier-explain.ts";
import { textOf, truncateText } from "./render.ts";

const truncate = (value: unknown, max = 220): string => truncateText(value, max);

const formatJsonObject = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return truncate(value);
    return truncate(prettyPrint(value).replace(/\n/g, " "));
};

const signalsOf = (row: ClassifierExplainResult): readonly string[] => {
    if (!row.signals) return [];
    const parsed = safeJsonParse<unknown>(row.signals);
    return Array.isArray(parsed) ? parsed.map(String) : [];
};

const evidenceOf = (row: ClassifierExplainResult): unknown =>
    safeJsonParse<unknown>(row.evidence_json) ?? row.evidence_json;

export function renderClassifierExplainMarkdown(payload: ClassifierExplainPayload): string {
    if (!payload.turn) return "turn not found";
    const lines: string[] = [];
    lines.push(`# classifier explain ${textOf(payload.turn.id)}`);
    lines.push("");
    lines.push(`session   ${textOf(payload.turn.session) || "?"}`);
    lines.push(`seq       ${textOf(payload.turn.seq) || "?"}`);
    lines.push(`role      ${textOf(payload.turn.role) || "?"}`);
    lines.push(`ts        ${textOf(payload.turn.ts) || "?"}`);
    lines.push(`text      ${truncate(payload.turn.text_excerpt ?? payload.turn.text, 280)}`);
    lines.push("");

    if (payload.results.length === 0) {
        lines.push("No classifier results for this turn.");
        return lines.join("\n");
    }

    lines.push(`## Results (${payload.results.length})`);
    for (const result of payload.results) {
        lines.push("");
        lines.push(`### ${result.classifier_key}@${result.classifier_version}`);
        lines.push(`label     ${result.label}`);
        lines.push(`target    ${result.target}`);
        lines.push(`polarity  ${result.polarity}`);
        lines.push(`durable   ${result.durability}`);
        lines.push(`confidence ${Number(result.confidence).toFixed(2)}`);
        const signals = signalsOf(result);
        if (signals.length > 0) lines.push(`signals   ${signals.join(", ")}`);
        lines.push(`evidence  ${formatJsonObject(evidenceOf(result))}`);
    }

    return lines.join("\n");
}

export function renderClassifierExplainJson(payload: ClassifierExplainPayload): string {
    return prettyPrint(payload);
}
