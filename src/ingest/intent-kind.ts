import { CORRECTION_MAX_LENGTH, isCorrectionPhrase } from "../lib/shared/correction-phrase.ts";

export type TurnIntentKind =
    | "assistant"
    | "control"
    | "correction"
    | "dogfood_prompt"
    | "organic_task"
    | "pasted_reference"
    | "preference"
    | "skill_context"
    | "subagent_notification"
    | "subagent_task"
    | "system_context"
    | "tool_call"
    | "tool_result"
    | "wrapper_instruction";

export interface TurnIntentInput {
    readonly role: string;
    readonly messageKind: string | null;
    readonly source?: string | null;
    readonly text: string | null;
}

export function classifyTurnIntent(input: TurnIntentInput): TurnIntentKind {
    const messageKind = input.messageKind ?? "";
    if (messageKind === "tool_result") return "tool_result";
    if (messageKind === "control") return "control";
    if (messageKind === "tool_call") return "tool_call";
    if (input.role === "assistant" || messageKind === "assistant") return "assistant";

    const text = input.text?.trim() ?? "";
    const lower = text.toLowerCase();
    if (text.includes("<command-name>") || text.includes("<command-message>")) return "control";

    if (messageKind === "system_or_developer" || messageKind === "context") {
        if (
            text.startsWith("Base directory for this skill:") ||
            text.startsWith("Base directory for this plugin:") ||
            text.includes("<skill>") ||
            text.includes("SKILL.md")
        ) {
            return "skill_context";
        }
        return "system_context";
    }

    if (input.source === "claude-subagent" || lower.startsWith("implementer subagent")) return "subagent_task";
    if (text.startsWith("<subagent_notification>")) return "subagent_notification";
    if (
        text.startsWith("<task>") ||
        text.startsWith("<task-notification>") ||
        text.startsWith("# /") ||
        text.startsWith("## Your task") ||
        text.startsWith("# Observability") ||
        text.startsWith("This session is being continued")
    ) {
        return "wrapper_instruction";
    }
    if (
        /^review\b|^diagnostic review\b|^code reuse review\b|^code quality review\b|^\*\*read-only\*\*|^find existing patterns\b|you are a qa engineer|worktree:|commit range:/i.test(text)
    ) {
        return "wrapper_instruction";
    }
    if (/dogfood|qa wrapper|subagent notifications|skill dumps/i.test(text)) return "dogfood_prompt";
    if (/^---|the video showcases|competitor|here'?s another|copy below|full git diff/i.test(text)) return "pasted_reference";

    // Correction: must be short user pushback. Long bodies are almost never
    // corrections - they're slash-command templates, FAQ pastes, or design
    // docs that happen to contain keywords like "wait" or "actually."
    if (text.length < CORRECTION_MAX_LENGTH && isCorrectionPhrase(text)) {
        return "correction";
    }

    if (/\b(i wanna|i want|we would like|can we|please|let'?s|okay if|i prefer)\b/i.test(text)) return "preference";
    return "organic_task";
}
