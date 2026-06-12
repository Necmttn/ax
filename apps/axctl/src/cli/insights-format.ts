import type { InsightView } from "../queries/insights.ts";
import { prettyPrint } from "@ax/lib/json";
import { textOf, truncateText } from "./render.ts";

type InsightRow = Record<string, unknown>;

const numberOf = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const compactDate = (value: unknown): string => {
    const text = textOf(value);
    return text.length >= 19 ? text.slice(0, 19).replace("T", " ") : text;
};

const truncate = (value: unknown, max = 180): string => truncateText(value, max);

const firstExampleText = (row: InsightRow): string => {
    const examples = row.examples;
    if (!Array.isArray(examples) || examples.length === 0) return "";
    const [first] = examples;
    if (!first || typeof first !== "object") return "";
    return truncate((first as InsightRow).text);
};

function formatSignalRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No message signals found.";
    return rows.map((row, index) => {
        const turns = numberOf(row.turns);
        const sessions = numberOf(row.sessions);
        const confidence = numberOf(row.avg_confidence);
        const countParts = [
            turns === null ? null : `turns=${turns}`,
            sessions === null ? null : `sessions=${sessions}`,
            confidence === null ? null : `confidence=${confidence.toFixed(2)}`,
            row.last_seen ? `last=${compactDate(row.last_seen)}` : null,
        ].filter(Boolean).join(" ");
        const title = `${index + 1}. ${textOf(row.kind)}/${textOf(row.label)} ${countParts}`.trim();
        const canonical = truncate(row.canonical_text, 140);
        const example = firstExampleText(row);
        return [
            title,
            canonical ? `   ${canonical}` : null,
            example ? `   example: ${example}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatReactionRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No user reactions found.";
    return rows.map((row, index) => {
        const userSeq = textOf(row.user_seq);
        const assistantSeq = textOf(row.assistant_seq);
        return [
            `${index + 1}. ${textOf(row.polarity)} / ${textOf(row.signal || row.act)}  ${compactDate(row.ts)}`,
            `   user #${userSeq}: ${truncate(row.user_text)}`,
            row.assistant_text ? `   assistant #${assistantSeq}: ${truncate(row.assistant_text)}` : null,
            row.session ? `   ${textOf(row.session)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

const firstThemeExample = (row: InsightRow): InsightRow | null => {
    const examples = row.examples;
    if (!Array.isArray(examples) || examples.length === 0) return null;
    const [first] = examples;
    return first && typeof first === "object" ? first as InsightRow : null;
};

const objectOf = (value: unknown): InsightRow | null =>
    value && typeof value === "object" && !Array.isArray(value) ? value as InsightRow : null;

const arrayOfObjects = (value: unknown): readonly InsightRow[] =>
    Array.isArray(value) ? value.filter((item): item is InsightRow => !!item && typeof item === "object" && !Array.isArray(item)) : [];

function formatReactionThemeRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No recurring reaction themes found.";
    return rows.map((row, index) => {
        const parts = [
            `reactions=${textOf(row.reactions)}`,
            `sessions=${textOf(row.sessions)}`,
            `revise=${textOf(row.revise)}`,
            `accept=${textOf(row.accept)}`,
            `reject=${textOf(row.reject)}`,
            row.last_seen ? `last=${compactDate(row.last_seen)}` : null,
        ].filter(Boolean).join(" ");
        const example = firstThemeExample(row);
        return [
            `${index + 1}. ${textOf(row.kind)}/${textOf(row.label)} ${parts}`,
            row.canonical_text ? `   ${truncate(row.canonical_text, 140)}` : null,
            example?.user_text ? `   user: ${truncate(example.user_text)}` : null,
            example?.assistant_text ? `   assistant: ${truncate(example.assistant_text)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatReactionEventRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No context-aware reaction events found.";
    return rows.map((row, index) => [
        `${index + 1}. ${textOf(row.reaction_type)} / ${textOf(row.target)} / ${textOf(row.durability)}  ${compactDate(row.ts)}`,
        `   user: ${truncate(row.user_text)}`,
        row.assistant_text ? `   assistant: ${truncate(row.assistant_text)}` : null,
        row.context_json ? `   context: ${truncate(row.context_json, 220)}` : null,
    ].filter(Boolean).join("\n")).join("\n\n");
}

function formatReactionEventThemeRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No context-aware reaction event themes found.";
    return rows.map((row, index) => {
        const confidence = numberOf(row.avg_confidence);
        const parts = [
            `events=${textOf(row.events)}`,
            `sessions=${textOf(row.sessions)}`,
            confidence === null ? null : `confidence=${confidence.toFixed(2)}`,
            row.last_seen ? `last=${compactDate(row.last_seen)}` : null,
        ].filter(Boolean).join(" ");
        const example = firstThemeExample(row);
        return [
            `${index + 1}. ${textOf(row.reaction_type)} / ${textOf(row.target)} / ${textOf(row.durability)} ${parts}`,
            example?.user_text ? `   user: ${truncate(example.user_text)}` : null,
            example?.assistant_text ? `   assistant: ${truncate(example.assistant_text)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatClassifierResultRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No classifier results found.";
    return rows.map((row, index) => [
        `${index + 1}. ${textOf(row.classifier_key)} / ${textOf(row.label)} / ${textOf(row.target)}  ${compactDate(row.ts)}`,
        `   subject: ${textOf(row.subject_type)} ${textOf(row.subject_id)} confidence=${textOf(row.confidence)}`,
        row.evidence_json ? `   evidence: ${truncate(row.evidence_json, 220)}` : null,
    ].filter(Boolean).join("\n")).join("\n\n");
}

function formatClassifierFactRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No classifier facts found.";
    return rows.map((row, index) => {
        const previous = objectOf(row.previous_assistant);
        const failures = arrayOfObjects(row.recent_tool_failures);
        const failure = failures[0];
        const confidence = numberOf(row.confidence);
        const parts = [
            `${textOf(row.classifier_key)} / ${textOf(row.label)} / ${textOf(row.target)}`,
            textOf(row.durability),
            confidence === null ? null : `confidence=${confidence.toFixed(2)}`,
            row.ts ? compactDate(row.ts) : null,
        ].filter(Boolean).join("  ");
        return [
            `${index + 1}. ${parts}`,
            row.user_text ? `   user #${textOf(row.user_seq)}: ${truncate(row.user_text)}` : null,
            previous?.text ? `   previous assistant #${textOf(previous.seq)}: ${truncate(previous.text)}` : null,
            failure ? `   recent failure: ${truncate(failure.command_norm || failure.name || failure.error_text || failure.output_excerpt)}` : null,
            failures.length > 1 ? `   recent failures: ${failures.length}` : null,
            row.signals ? `   signals: ${truncate(row.signals, 160)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatCorrectionContextRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No correction contexts found.";
    return rows.map((row, index) => {
        const previous = objectOf(row.previous_assistant);
        const failures = arrayOfObjects(row.recent_tool_failures);
        return [
            `${index + 1}. ${textOf(row.target)} / ${textOf(row.durability)}  ${compactDate(row.ts)}`,
            row.user_text ? `   correction #${textOf(row.user_seq)}: ${truncate(row.user_text)}` : null,
            previous?.text ? `   caused by assistant #${textOf(previous.seq)}: ${truncate(previous.text)}` : null,
            failures.length > 0 ? `   failed tools: ${failures.map((failure) => truncate(failure.command_norm || failure.error_text || failure.output_excerpt || failure.name, 80)).join("; ")}` : null,
            row.evidence_json ? `   evidence: ${truncate(row.evidence_json, 180)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatClassifierOutcomeRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No classifier outcomes found.";
    return rows.map((row, index) => {
        const tools = arrayOfObjects(row.later_tool_calls);
        const outcomes = arrayOfObjects(row.later_command_outcomes);
        const laterUsers = arrayOfObjects(row.later_user_turns);
        const firstTool = tools[0];
        const firstOutcome = outcomes[0];
        const firstUser = laterUsers[0];
        return [
            `${index + 1}. ${textOf(row.classifier_key)} / ${textOf(row.label)} / ${textOf(row.target)}  ${compactDate(row.ts)}`,
            row.user_text ? `   fact #${textOf(row.user_seq)}: ${truncate(row.user_text)}` : null,
            firstTool ? `   next tool: ${truncate(firstTool.command_norm || firstTool.name || firstTool.error_text || firstTool.output_excerpt)}${firstTool.has_error === true ? " [error]" : ""}` : null,
            tools.length > 1 ? `   later tools: ${tools.length}` : null,
            firstOutcome ? `   outcome: ${textOf(firstOutcome.kind)} / ${textOf(firstOutcome.status)} ${truncate(firstOutcome.command_norm || firstOutcome.text, 120)}` : null,
            outcomes.length > 1 ? `   later outcomes: ${outcomes.length}` : null,
            firstUser ? `   later user #${textOf(firstUser.seq)}: ${truncate(firstUser.text)}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

function formatClassifierThemeRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No classifier themes found.";
    return rows.map((row, index) => {
        const confidence = numberOf(row.avg_confidence);
        const parts = [
            `results=${textOf(row.results)}`,
            `sessions=${textOf(row.sessions)}`,
            confidence === null ? null : `confidence=${confidence.toFixed(2)}`,
            row.last_seen ? `last=${compactDate(row.last_seen)}` : null,
        ].filter(Boolean).join(" ");
        return `${index + 1}. ${textOf(row.classifier_key)} / ${textOf(row.label)} / ${textOf(row.target)} / ${textOf(row.durability)} ${parts}`;
    }).join("\n\n");
}

function formatHarnessCandidateRows(rows: readonly InsightRow[]): string {
    if (rows.length === 0) return "No harness candidates found.";
    return rows.map((row, index) => {
        const examples = arrayOfObjects(row.examples);
        const directEvidence = arrayOfObjects(row.evidence);
        const example = examples[0];
        const exampleEvidence = example ? arrayOfObjects(example.evidence) : [];
        const evidenceCount = directEvidence.length + exampleEvidence.length;
        const confidence = numberOf(row.avg_confidence);
        const parts = [
            `facts=${textOf(row.facts)}`,
            `sessions=${textOf(row.sessions)}`,
            confidence === null ? null : `confidence=${confidence.toFixed(2)}`,
            row.last_seen ? `last=${compactDate(row.last_seen)}` : null,
        ].filter(Boolean).join(" ");
        const signature = Array.isArray(row.dedupe_signature)
            ? row.dedupe_signature.map(textOf).join("/")
            : [row.classifier_key, row.label, row.target, row.durability].map(textOf).join("/");
        return [
            `${index + 1}. ${textOf(row.proposed_layer)} -> ${textOf(row.proposed_action)}  ${parts}`,
            row.candidate_id ? `   id: ${Array.isArray(row.candidate_id) ? row.candidate_id.map(textOf).join("/") : textOf(row.candidate_id)}` : null,
            `   signature: ${signature}`,
            example?.user_text ? `   example #${textOf(example.user_seq)}: ${truncate(example.user_text)}` : null,
            evidenceCount > 0 ? `   evidence refs: ${evidenceCount}` : null,
        ].filter(Boolean).join("\n");
    }).join("\n\n");
}

export function formatInsightRows(view: InsightView, rows: readonly InsightRow[], opts: { readonly json?: boolean } = {}): string {
    if (opts.json) return prettyPrint(rows);
    switch (view) {
        case "feedback-language":
        case "message-signals":
            return formatSignalRows(rows);
        case "reactions":
            return formatReactionRows(rows);
        case "reaction-themes":
            return formatReactionThemeRows(rows);
        case "reaction-events":
            return formatReactionEventRows(rows);
        case "reaction-event-themes":
            return formatReactionEventThemeRows(rows);
        case "classifier-results":
            return formatClassifierResultRows(rows);
        case "classifier-facts":
            return formatClassifierFactRows(rows);
        case "correction-contexts":
            return formatCorrectionContextRows(rows);
        case "classifier-outcomes":
            return formatClassifierOutcomeRows(rows);
        case "harness-candidates":
            return formatHarnessCandidateRows(rows);
        case "classifier-themes":
            return formatClassifierThemeRows(rows);
        default:
            return prettyPrint(rows);
    }
}
