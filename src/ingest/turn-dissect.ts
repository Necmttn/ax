/**
 * Dissect a single turn's text into typed spans.
 *
 * Claude Code (and Codex) frequently bake auto-injected context into what
 * looks like a single user message: a slash command wrapper, a skill autoload,
 * system reminders, hook injections, the user's actual prompt, sometimes a
 * pasted file. The intent classifier in `intent-kind.ts` reduces the whole
 * turn to one label; this dissector keeps the structure so an inspector view
 * can show which parts came from where.
 */

export type TurnSpanKind =
    | "user_input"
    | "assistant_text"
    | "tool_use"
    | "skill_context"
    | "system_context"
    | "wrapper_instruction"
    | "hook_injection"
    | "tool_result"
    | "subagent_notification"
    | "subagent_task"
    | "pasted_reference";

export interface TurnSpan {
    readonly kind: TurnSpanKind;
    readonly text: string;
    readonly label?: string;
    readonly startOffset?: number;
    readonly endOffset?: number;
}

interface ClosedTag {
    readonly pattern: RegExp;
    readonly kind: TurnSpanKind;
    readonly label?: string | ((match: RegExpMatchArray) => string);
}

const CLOSED_TAGS: readonly ClosedTag[] = [
    { pattern: /<command-name>[\s\S]*?<\/command-name>/g, kind: "wrapper_instruction", label: "command-name" },
    { pattern: /<command-message>[\s\S]*?<\/command-message>/g, kind: "wrapper_instruction", label: "command-message" },
    { pattern: /<command-args>[\s\S]*?<\/command-args>/g, kind: "wrapper_instruction", label: "command-args" },
    { pattern: /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, kind: "tool_result", label: "local-command-stdout" },
    { pattern: /<tool_use(?:\s+name="([^"]*)")?>[\s\S]*?<\/tool_use>/g, kind: "tool_use", label: (m) => m[1] ?? "tool_use" },
    { pattern: /<task>[\s\S]*?<\/task>/g, kind: "wrapper_instruction", label: "task" },
    { pattern: /<task-notification>[\s\S]*?<\/task-notification>/g, kind: "subagent_notification", label: "task-notification" },
    { pattern: /<system-reminder>[\s\S]*?<\/system-reminder>/g, kind: "system_context", label: "system-reminder" },
    { pattern: /<ax_file_memory>[\s\S]*?<\/ax_file_memory>/g, kind: "hook_injection", label: "ax_file_memory" },
    { pattern: /<ax_file_context>[\s\S]*?<\/ax_file_context>/g, kind: "hook_injection", label: "ax_file_context" },
    { pattern: /<subagent_notification>[\s\S]*?<\/subagent_notification>/g, kind: "subagent_notification", label: "subagent_notification" },
    { pattern: /<env>[\s\S]*?<\/env>/g, kind: "system_context", label: "env" },
    { pattern: /<environment_context>[\s\S]*?<\/environment_context>/g, kind: "system_context", label: "environment_context" },
    { pattern: /<permissions instructions>[\s\S]*?<\/permissions instructions>/g, kind: "system_context", label: "permissions" },
    { pattern: /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g, kind: "system_context", label: "collaboration_mode" },
    // Codex developer-message preamble blocks. Each wraps a chunk of harness-
    // injected instructions; treat as system context so the dissector view
    // doesn't bleed them into "user input".
    { pattern: /<apps_instructions>[\s\S]*?<\/apps_instructions>/g, kind: "system_context", label: "apps_instructions" },
    { pattern: /<skills_instructions>[\s\S]*?<\/skills_instructions>/g, kind: "system_context", label: "skills_instructions" },
    { pattern: /<plugins_instructions>[\s\S]*?<\/plugins_instructions>/g, kind: "system_context", label: "plugins_instructions" },
    { pattern: /<user_instructions>[\s\S]*?<\/user_instructions>/g, kind: "system_context", label: "user_instructions" },
    { pattern: /<project_doc>[\s\S]*?<\/project_doc>/g, kind: "system_context", label: "project_doc" },
];

interface PrefixMarker {
    readonly pattern: RegExp;
    readonly kind: TurnSpanKind;
    readonly label: (match: string) => string;
}

const PREFIX_MARKERS: readonly PrefixMarker[] = [
    {
        pattern: /^Base directory for this skill:\s*(\S.*)$/m,
        kind: "skill_context",
        // Label is JUST the skill identifier; the renderer prepends the kind name.
        label: (m) => m.split(":").slice(1).join(":").trim().split("/").pop() ?? "?",
    },
    {
        pattern: /^Base directory for this plugin:\s*(\S.*)$/m,
        kind: "skill_context",
        label: (m) => `plugin/${m.split(":").slice(1).join(":").trim().split("/").pop() ?? "?"}`,
    },
    {
        pattern: /^# AGENTS\.md instructions for /m,
        kind: "system_context",
        label: () => "AGENTS.md",
    },
    {
        pattern: /^Contents of \S+CLAUDE\.md\b/m,
        kind: "system_context",
        label: () => "CLAUDE.md autoload",
    },
];

interface Interval {
    start: number;
    end: number;
    kind: TurnSpanKind;
    label?: string | undefined;
}

export interface DissectOptions {
    /** Kind to assign to text that doesn't match any pattern. Pass
     *  "assistant_text" for assistant-role turns so plain prose doesn't get
     *  mis-tagged as user input. Defaults to "user_input". */
    readonly defaultKind?: TurnSpanKind;
}

export function dissectTurn(text: string, opts: DissectOptions = {}): readonly TurnSpan[] {
    if (!text) return [];
    const defaultKind: TurnSpanKind = opts.defaultKind ?? "user_input";

    const intervals: Interval[] = [];

    for (const { pattern, kind, label } of CLOSED_TAGS) {
        const re = new RegExp(pattern.source, pattern.flags);
        for (const m of text.matchAll(re)) {
            const start = m.index ?? -1;
            if (start < 0) continue;
            const resolvedLabel = typeof label === "function" ? label(m) : label;
            intervals.push({ start, end: start + m[0].length, kind, label: resolvedLabel });
        }
    }

    // Prefix-anchored markers extend until the next interval start (any kind)
    // or end of text. Compute end after we know all closed-tag starts.
    const prefixSeeds: Array<{ start: number; kind: TurnSpanKind; label: string }> = [];
    for (const { pattern, kind, label } of PREFIX_MARKERS) {
        const re = new RegExp(pattern.source, `${pattern.flags.includes("g") ? "" : "g"}${pattern.flags.replace("g", "")}`);
        for (const m of text.matchAll(re)) {
            const start = m.index ?? -1;
            if (start < 0) continue;
            prefixSeeds.push({ start, kind, label: label(m[0]) });
        }
    }

    const allStarts = [...intervals.map((i) => i.start), ...prefixSeeds.map((p) => p.start)].sort((a, b) => a - b);
    for (const seed of prefixSeeds) {
        const nextStart = allStarts.find((s) => s > seed.start);
        intervals.push({
            start: seed.start,
            end: nextStart ?? text.length,
            kind: seed.kind,
            label: seed.label,
        });
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);

    // Drop intervals that overlap an earlier kept interval. Earlier-starting
    // closed tags win over later prefix-anchored spans they sit inside of.
    const kept: Interval[] = [];
    for (const iv of intervals) {
        const last = kept.at(-1);
        if (last && iv.start < last.end) continue;
        kept.push(iv);
    }

    const spans: TurnSpan[] = [];
    let cursor = 0;
    const pushDefault = (raw: string) => {
        if (raw.trim().length === 0) return;
        const startOffset = cursor;
        spans.push({ kind: defaultKind, text: raw, startOffset, endOffset: startOffset + raw.length });
    };

    for (const iv of kept) {
        if (iv.start > cursor) pushDefault(text.slice(cursor, iv.start));
        const span: TurnSpan = iv.label
            ? { kind: iv.kind, text: text.slice(iv.start, iv.end), label: iv.label, startOffset: iv.start, endOffset: iv.end }
            : { kind: iv.kind, text: text.slice(iv.start, iv.end), startOffset: iv.start, endOffset: iv.end };
        spans.push(span);
        cursor = iv.end;
    }
    if (cursor < text.length) pushDefault(text.slice(cursor));

    return spans;
}
