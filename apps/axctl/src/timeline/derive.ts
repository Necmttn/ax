/**
 * Pure timeline derivation - raw typed rows in, SessionTimeline out. No Effect,
 * no SurrealDB, no LLM: every event is a deterministic projection of ingested
 * data, so this whole module is unit-testable with plain fixtures.
 */
import type {
    SessionHighlights,
    SessionTimeline,
    TimelineEvent,
    TimelineEventKind,
} from "./types.ts";
import type {
    AskRow,
    CommitRow,
    CompactionRow,
    CorrectionRow,
    CostRow,
    EditRow,
    HealthRow,
    LastTurnRow,
    OverviewRow,
    PlanRow,
    SkillRow,
    ToolCallRow,
} from "./queries.ts";
import { classifyTool, isRealSkill, type ProviderSource } from "./providers.ts";
import { segmentize } from "./segment.ts";

const TITLE_MAX = 120;
const DETAIL_MAX = 280;
/** Seq distance within which a later success counts as recovering a failure. */
const RECOVERY_WINDOW = 40;

const firstLine = (s: string | null | undefined): string =>
    (s ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;
const tsValue = (ts: string | null): number => {
    if (!ts) return Number.POSITIVE_INFINITY;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** Subagent-dispatch tool names whose bare name says nothing - their event
 *  title should carry the dispatch description instead of just "Agent". */
const DISPATCH_TOOLS = new Set(["Agent", "Task"]);

/**
 * Best-effort label for an Agent/Task dispatch: the `description` (falling
 * back to `subagent_type`) from the call's input. `command_text` is the first
 * 400 chars of `input_json`, so it may be TRUNCATED mid-string - regex-extract
 * instead of JSON.parse.
 */
export const dispatchLabel = (commandText: string | null): string | null => {
    if (!commandText) return null;
    const pick = (key: string): string | null =>
        new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(commandText)?.[1] ?? null;
    const label = pick("description") ?? pick("subagent_type");
    if (!label) return null;
    return label.replace(/\\n/g, " ").replace(/\\"/g, '"').trim() || null;
};

// --- per-kind derivation ---------------------------------------------------

/**
 * Successful tool calls -> tool_call / file_edit events, provider-aware. Errors
 * are skipped (they become `failure` events). Noise (reads/searches) and the
 * fake `<provider>:` skill shadow are dropped. codex/cursor edits (which have no
 * `edited` edge) are recovered here from the command; claude/pi edits that the
 * `edited` edge already covers (in `editedSeqs`) are left to deriveFileEvents
 * so they keep their real path.
 */
export function deriveToolEvents(
    rows: ReadonlyArray<ToolCallRow>,
    source: ProviderSource,
    editedSeqs: ReadonlySet<number>,
): TimelineEvent[] {
    const out: TimelineEvent[] = [];
    for (const t of rows) {
        if (t.has_error || t.ts == null) continue;
        const c = classifyTool(source, { name: t.name, command_norm: t.command_norm, command_text: t.command_text });
        if (c.kind === "noise" || c.kind === "skill") continue;
        const turnRef = t.seq != null ? [{ type: "turn" as const, id: String(t.seq) }] : [];
        if (c.kind === "file_edit") {
            if (t.seq != null && editedSeqs.has(t.seq)) continue; // edge covers it with a real path
            out.push({
                kind: "file_edit",
                ts: t.ts,
                seq: t.seq,
                title: clip(t.command_norm ?? t.name, TITLE_MAX),
                ...(t.command_text ? { detail: clip(t.command_text, DETAIL_MAX) } : {}),
                refs: turnRef,
            });
            continue;
        }
        const dispatch = DISPATCH_TOOLS.has(t.name) ? dispatchLabel(t.command_text) : null;
        out.push({
            kind: "tool_call",
            ts: t.ts,
            seq: t.seq,
            title: clip(dispatch ? `${t.name}: ${dispatch}` : t.command_norm ?? t.name, TITLE_MAX),
            ...(firstLine(t.output_excerpt) ? { detail: clip(firstLine(t.output_excerpt), DETAIL_MAX) } : {}),
            status: "ok",
            refs: [...(t.call_id ? [{ type: "tool" as const, id: t.call_id }] : []), ...turnRef],
        });
    }
    return out;
}

export function deriveFailureEvents(rows: ReadonlyArray<ToolCallRow>): TimelineEvent[] {
    return rows
        .filter((t) => t.has_error && t.ts != null)
        .map((t) => {
            const reason = firstLine(t.error_text) || firstLine(t.output_excerpt) || "error";
            return {
                kind: "failure" as const,
                ts: t.ts as string,
                seq: t.seq,
                title: clip(`${t.name}: ${reason}`, TITLE_MAX),
                ...(t.error_text ? { detail: clip(t.error_text, DETAIL_MAX) } : {}),
                status: "error" as const,
                refs: [
                    ...(t.call_id ? [{ type: "tool" as const, id: t.call_id }] : []),
                    ...(t.seq != null ? [{ type: "turn" as const, id: String(t.seq) }] : []),
                ],
                recovered_by_seq: null as number | null,
            };
        });
}

export function deriveFileEvents(rows: ReadonlyArray<EditRow>): TimelineEvent[] {
    return rows
        .filter((e) => e.path != null && e.ts != null)
        .map((e) => ({
            kind: "file_edit" as const,
            ts: e.ts as string,
            seq: e.seq,
            title: clip(e.path as string, TITLE_MAX),
            ...(e.tool || e.edit_kind ? { detail: [e.tool, e.edit_kind].filter(Boolean).join(" · ") } : {}),
            refs: [
                { type: "file" as const, id: e.path as string },
                ...(e.seq != null ? [{ type: "turn" as const, id: String(e.seq) }] : []),
            ],
        }));
}

export function deriveSkillEvents(
    rows: ReadonlyArray<SkillRow>,
    source: ProviderSource,
): TimelineEvent[] {
    return rows
        .filter((s) => s.name != null && s.ts != null && isRealSkill(source, s.name))
        .map((s) => ({
            kind: "skill_invocation" as const,
            ts: s.ts as string,
            seq: s.seq,
            title: clip(s.name as string, TITLE_MAX),
            refs: [
                { type: "skill" as const, id: s.name as string },
                ...(s.seq != null ? [{ type: "turn" as const, id: String(s.seq) }] : []),
            ],
        }));
}

export function deriveCorrectionEvents(rows: ReadonlyArray<CorrectionRow>): TimelineEvent[] {
    return rows
        .filter((c) => c.ts != null)
        .map((c) => ({
            kind: "correction" as const,
            ts: c.ts as string,
            seq: c.seq,
            title: clip(c.target ? `correction: ${c.target}` : "user correction", TITLE_MAX),
            ...(firstLine(c.user_text) ? { detail: clip(firstLine(c.user_text), DETAIL_MAX) } : {}),
            refs: c.seq != null ? [{ type: "turn" as const, id: String(c.seq) }] : [],
        }));
}

/** A plan_snapshot is the agent's own stated decision - the first/summary item. */
export function deriveDecisionEvents(rows: ReadonlyArray<PlanRow>): TimelineEvent[] {
    return rows
        .filter((p) => p.ts != null)
        .map((p) => {
            let firstItem = "";
            let count = 0;
            if (p.items) {
                try {
                    const items = JSON.parse(p.items) as Array<{ content?: unknown }>;
                    if (Array.isArray(items)) {
                        count = items.length;
                        const c = items.find((i) => typeof i?.content === "string")?.content;
                        if (typeof c === "string") firstItem = c;
                    }
                } catch {
                    /* malformed items - fall through to summary */
                }
            }
            const title = p.summary || firstItem || "plan updated";
            return {
                kind: "decision" as const,
                ts: p.ts as string,
                seq: null,
                title: clip(title, TITLE_MAX),
                ...(count > 0 ? { detail: `${count} step${count === 1 ? "" : "s"}` } : {}),
                refs: [],
            };
        });
}

export function deriveCheckpointEvents(rows: ReadonlyArray<CommitRow>): TimelineEvent[] {
    return rows
        .filter((c) => c.ts != null && c.sha != null)
        .map((c) => ({
            kind: "checkpoint" as const,
            ts: c.ts as string,
            seq: null,
            title: clip(`committed ${(c.sha as string).slice(0, 7)}${c.message ? ` · ${firstLine(c.message)}` : ""}`, TITLE_MAX),
            ...(c.message ? { detail: clip(c.message, DETAIL_MAX) } : {}),
            refs: [{ type: "commit" as const, id: c.sha as string }],
        }));
}

/** Raw closing state. Title/detail are last-assistant text - the seam where an
 *  optional LLM gloss could replace the raw line later. */
export function deriveOutcomeEvent(row: LastTurnRow | null): TimelineEvent[] {
    if (!row || row.ts == null) return [];
    const line = firstLine(row.text_excerpt) || "session ended";
    return [{
        kind: "outcome",
        ts: row.ts,
        seq: row.seq,
        title: clip(line, TITLE_MAX),
        ...(row.text_excerpt ? { detail: clip(row.text_excerpt, DETAIL_MAX) } : {}),
        refs: row.seq != null ? [{ type: "turn", id: String(row.seq) }] : [],
    }];
}

// --- recovery pairing (heuristic, LLM-free) --------------------------------

const sameCommand = (a: ToolCallRow, b: ToolCallRow): boolean =>
    (a.command_norm != null && a.command_norm === b.command_norm) || a.name === b.name;

/**
 * Mutates failure events in place, setting `recovered_by_seq` to the seq of the
 * next success that plausibly fixed it: a later same-command/same-tool success,
 * else the next edit on a file named in the error text, within RECOVERY_WINDOW.
 */
export function pairRecoveries(
    failures: TimelineEvent[],
    toolRows: ReadonlyArray<ToolCallRow>,
    edits: ReadonlyArray<EditRow>,
): TimelineEvent[] {
    const byCallId = new Map(toolRows.map((t) => [t.call_id, t] as const));
    return failures.map((f) => {
        if (f.kind !== "failure" || f.seq == null) return f;
        const failedCall = byCallId.get(f.refs.find((r) => r.type === "tool")?.id ?? null);
        const sf = f.seq;
        let recovered: number | null = null;
        const success = toolRows.find(
            (t) => !t.has_error && t.seq != null && t.seq > sf && t.seq - sf <= RECOVERY_WINDOW &&
                (failedCall ? sameCommand(t, failedCall) : false),
        );
        if (success?.seq != null) recovered = success.seq;
        if (recovered == null) {
            const errText = (failedCall?.error_text ?? "").toLowerCase();
            const fix = edits.find(
                (e) => e.path != null && e.seq != null && e.seq > sf && e.seq - sf <= RECOVERY_WINDOW &&
                    errText.includes(basename(e.path).toLowerCase()),
            );
            if (fix?.seq != null) recovered = fix.seq;
        }
        return { ...f, recovered_by_seq: recovered };
    });
}

// --- assembly --------------------------------------------------------------

const byTs = (a: TimelineEvent, b: TimelineEvent): number => {
    const d = tsValue(a.ts) - tsValue(b.ts);
    if (d !== 0) return d;
    return (a.seq ?? Number.POSITIVE_INFINITY) - (b.seq ?? Number.POSITIVE_INFINITY);
};

const emptyCounts = (): Record<TimelineEventKind, number> => ({
    decision: 0, tool_call: 0, file_edit: 0, skill_invocation: 0,
    failure: 0, correction: 0, checkpoint: 0, outcome: 0,
});

export function deriveHighlights(input: {
    readonly health: HealthRow | null;
    readonly overview: OverviewRow | null;
    readonly cost: CostRow | null;
    readonly filesChanged: number;
    readonly skillsUsed: number;
    readonly events: ReadonlyArray<TimelineEvent>;
}): SessionHighlights {
    const h = input.health;
    const o = input.overview;
    const started = o?.started_at ?? null;
    const ended = o?.ended_at ?? null;
    const duration_ms = started && ended ? new Date(ended).getTime() - new Date(started).getTime() : null;
    const event_counts = emptyCounts();
    for (const e of input.events) event_counts[e.kind] += 1;
    return {
        started_at: started,
        ended_at: ended,
        duration_ms: duration_ms != null && Number.isFinite(duration_ms) ? duration_ms : null,
        model: o?.model ?? null,
        project: o?.project ?? null,
        repository: o?.cwd ?? null,
        turns: h?.turns ?? 0,
        user_turns: h?.user_turns ?? 0,
        assistant_turns: h?.assistant_turns ?? 0,
        tool_calls: h?.tool_calls ?? 0,
        tool_errors: h?.tool_errors ?? 0,
        files_changed: input.filesChanged,
        skills_used: input.skillsUsed,
        corrections: h?.user_corrections ?? 0,
        interruptions: h?.interruptions ?? 0,
        cost_usd: input.cost?.cost_usd ?? null,
        estimated_tokens: input.cost?.estimated_tokens ?? h?.estimated_tokens ?? null,
        event_counts,
    };
}

export interface TimelineInputs {
    readonly sessionId: string;
    readonly source: ProviderSource;
    readonly health: HealthRow | null;
    readonly overview: OverviewRow | null;
    readonly cost: CostRow | null;
    readonly toolCalls: ReadonlyArray<ToolCallRow>;
    readonly edits: ReadonlyArray<EditRow>;
    readonly skills: ReadonlyArray<SkillRow>;
    readonly corrections: ReadonlyArray<CorrectionRow>;
    readonly plans: ReadonlyArray<PlanRow>;
    readonly commits: ReadonlyArray<CommitRow>;
    readonly asks: ReadonlyArray<AskRow>;
    readonly compactions: ReadonlyArray<CompactionRow>;
    readonly lastAssistant: LastTurnRow | null;
}

const dedupePaths = (edits: ReadonlyArray<EditRow>): number =>
    new Set(edits.map((e) => e.path).filter((p): p is string => p != null)).size;

/** Compose all derivations into the final ordered SessionTimeline. Pure. */
export function buildTimeline(input: TimelineInputs): SessionTimeline {
    const editedSeqs = new Set(
        input.edits.map((e) => e.seq).filter((s): s is number => s != null),
    );
    const failures = pairRecoveries(deriveFailureEvents(input.toolCalls), input.toolCalls, input.edits);
    const events = [
        ...deriveToolEvents(input.toolCalls, input.source, editedSeqs),
        ...failures,
        ...deriveFileEvents(input.edits),
        ...deriveSkillEvents(input.skills, input.source),
        ...deriveCorrectionEvents(input.corrections),
        ...deriveDecisionEvents(input.plans),
        ...deriveCheckpointEvents(input.commits),
        ...deriveOutcomeEvent(input.lastAssistant),
    ].sort(byTs);
    const highlights = deriveHighlights({
        health: input.health,
        overview: input.overview,
        cost: input.cost,
        filesChanged: dedupePaths(input.edits),
        skillsUsed: isRealSkill(input.source, "x")
            ? new Set(input.skills.map((s) => s.name).filter(Boolean)).size
            : 0,
        events, // full counts, before L1 capping
    });
    const { segments, events: kept } = segmentize(
        events,
        { asks: input.asks, commits: input.commits, compactions: input.compactions },
        input.overview?.started_at ?? null,
    );
    return { session_id: input.sessionId, highlights, segments, events: kept };
}
