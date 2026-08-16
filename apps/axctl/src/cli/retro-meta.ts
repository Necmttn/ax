/**
 * `ax retro meta` - read-only investigation snapshot for an EXTERNAL AI agent
 * (Claude Code / Codex with high thinking). This command does NOT spawn any
 * subagent. It collates:
 *
 *  - recent `retro` rows (raw structured reflections)
 *  - aggregated patterns: tool-failure clusters, correction pressure,
 *    friction-kind counts (reuses parsers from derive-retro-proposals.ts)
 *  - current state: installed skills, open proposals, accepted-but-unlocked
 *    experiments, locations of guidance files (CLAUDE.md user + project)
 *  - a fixed list of `investigation_prompts` the agent should walk through
 *
 * Output defaults to JSON (the target reader is a machine). The companion
 * `ax retro plan` command lets the agent register an improvement back into
 * the graph after the user approves.
 *
 * Sibling of `retro emit` / `retro list` / `retro reflect`.
 */

import { Effect, FileSystem } from "effect";
import { encodeJson } from "@ax/lib/decode";
import { homedir } from "node:os";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettyPrint } from "@ax/lib/json";
import { recordRef } from "@ax/lib/shared/surql";
import { listStoredProposals } from "../improve/judgment-proposals.ts";
import { listStoredRetros } from "../queries/judgment-retros.ts";
import {
    parseRetroCorrections,
    parseRetroFailed,
    parseRetroFrictionKinds,
} from "../ingest/derive-retro-proposals.ts";

export interface RetroMetaRow {
    readonly id: string;
    readonly session: string;
    readonly source: string;
    readonly tried: string;
    readonly worked: string | null;
    readonly failed: string | null;
    readonly next: string | null;
    readonly created_at: string;
}

export interface ToolFailureAgg {
    readonly tool: string;
    readonly total_count: number;
    readonly session_count: number;
}

export interface CorrectionsAgg {
    readonly total: number;
    readonly max_per_session: number;
    readonly session_count: number;
}

export interface FrictionKindAgg {
    readonly kind: string;
    readonly count: number;
    readonly session_count: number;
}

export interface SkillRow {
    readonly name: string;
    readonly scope: string;
    readonly description: string;
}

export interface OpenProposalRow {
    readonly dedupe_sig: string;
    readonly form: string;
    readonly title: string;
    readonly frequency: number;
    readonly confidence: string;
}

export interface AcceptedExperimentRow {
    readonly id: string;
    readonly title: string;
    readonly artifact_path: string | null;
    readonly locked_verdict: string | null;
}

export interface ExperimentStatusCheckpoint {
    readonly kind: string;
    readonly suggested: string | null;
    readonly observed_at: string;
}

export interface ExperimentStatusRow {
    readonly experiment_id: string;
    readonly proposal_dedupe_sig: string;
    readonly proposal_title: string;
    readonly proposal_form: string;
    readonly artifact_path: string | null;
    readonly days_since_accepted: number;
    readonly opportunities_count: number;
    readonly addressed_count: number;
    readonly address_ratio: number;
    readonly latest_checkpoint: ExperimentStatusCheckpoint | null;
    readonly locked_verdict: string | null;
}

export interface MetaSnapshot {
    readonly generated_at: string;
    readonly since_days: number;
    readonly retros: readonly RetroMetaRow[];
    readonly patterns: {
        readonly tool_failures: readonly ToolFailureAgg[];
        readonly corrections: CorrectionsAgg;
        readonly friction_kinds: readonly FrictionKindAgg[];
    };
    readonly current_state: {
        readonly skills: readonly SkillRow[];
        readonly open_proposals: readonly OpenProposalRow[];
        readonly accepted_experiments: readonly AcceptedExperimentRow[];
        readonly claude_md_user: string | null;
        readonly claude_md_project: string | null;
    };
    readonly experiment_status: readonly ExperimentStatusRow[];
    readonly investigation_prompts: readonly string[];
}

/**
 * Canonical investigation prompts the external agent should walk through.
 * Static (deterministic across runs) so the agent's behavior is predictable
 * and we can grow this list in one place over time.
 */
export const INVESTIGATION_PROMPTS: readonly string[] = [
    "Start with `experiment_status`. Lock stale verdicts (>30d, low ratio) before drafting any new proposals. The retrospective loop is incomplete if old experiments stay in limbo while new ones pile on.",
    "Look at retros[].failed for patterns NOT yet captured as proposals. What recurring shape do you see that the heuristic missed?",
    "Cross-reference top tool_failures against current_state.skills. Is there a guidance gap that explains the recurrence?",
    "Read claude_md_user. Are the corrections in patterns.corrections symptomatic of a missing rule?",
    "For each open_proposal, decide: accept-with-agent now, reject as not worth packaging, or leave open for more evidence?",
    "Are there improvement opportunities that don't fit any existing proposal? Draft a plan and register via `ax retro plan`.",
    "Review `experiment_status` first. For each accepted experiment with `locked_verdict=null`: does the data support the suggested verdict? If addressed_ratio < 0.1 after t+30, consider locking as `ignored` via `ax improve verdict --set=ignored <dedupe_sig>`. Do NOT propose new improvements that overlap with experiments still pending verdict - wait for them to lock or escalate.",
];

/**
 * SurrealDB may return `duration::days(...)` as a plain int OR as a duration
 * object/string like `"32d"`/`{ secs: 2764800 }` depending on driver version.
 * Coerce to a non-negative integer day count; fall back to ISO diff against
 * created_at when nothing else parses.
 */
export const coerceDaysSinceAccepted = (
    raw: unknown,
    createdAtIso: string | null | undefined,
    nowMs: number = Date.now(),
): number => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.max(0, Math.floor(raw));
    }
    if (typeof raw === "string") {
        const m = /^(\d+)\s*d\b/.exec(raw);
        if (m && m[1]) return Math.max(0, parseInt(m[1], 10));
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    }
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.secs === "number") {
            return Math.max(0, Math.floor(obj.secs / 86_400));
        }
        if (typeof obj.seconds === "number") {
            return Math.max(0, Math.floor(obj.seconds / 86_400));
        }
        if (typeof obj.days === "number") {
            return Math.max(0, Math.floor(obj.days));
        }
    }
    if (createdAtIso) {
        const t = Date.parse(createdAtIso);
        if (Number.isFinite(t)) {
            return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
        }
    }
    return 0;
};

const idToString = (raw: unknown): string => {
    if (raw === null || raw === undefined) return "";
    if (typeof raw === "string") return raw;
    if (typeof raw === "object" && raw !== null && "tb" in raw && "id" in raw) {
        const r = raw as { tb: unknown; id: unknown };
        return `${String(r.tb ?? "")}:${String(r.id ?? "")}`;
    }
    return String(raw);
};

const flagValue = (args: string[], name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit?.split("=").slice(1).join("=");
};

/**
 * Aggregate parsed tool failures across retros. Sorted by descending
 * total_count.
 */
export const aggregateToolFailures = (
    retros: readonly RetroMetaRow[],
): ToolFailureAgg[] => {
    const byTool = new Map<string, { tool: string; total: number; sessions: Set<string> }>();
    for (const r of retros) {
        const mentions = parseRetroFailed(r.failed);
        for (const m of mentions) {
            const key = m.tool.toLowerCase();
            let bucket = byTool.get(key);
            if (!bucket) {
                bucket = { tool: m.tool, total: 0, sessions: new Set() };
                byTool.set(key, bucket);
            }
            bucket.total += m.count;
            if (r.session) bucket.sessions.add(r.session);
        }
    }
    return [...byTool.values()]
        .map((b) => ({
            tool: b.tool,
            total_count: b.total,
            session_count: b.sessions.size,
        }))
        .sort((a, b) => b.total_count - a.total_count);
};

/**
 * Aggregate the leading "<N> user correction(s)" counts across the retro set.
 * Returns max_per_session (the biggest single-session count) so the agent can
 * tell "one bad session" apart from "consistent drift".
 */
export const aggregateCorrections = (
    retros: readonly RetroMetaRow[],
): CorrectionsAgg => {
    let total = 0;
    let max = 0;
    const sessions = new Set<string>();
    for (const r of retros) {
        const n = parseRetroCorrections(r.failed);
        if (n <= 0) continue;
        total += n;
        if (n > max) max = n;
        if (r.session) sessions.add(r.session);
    }
    return { total, max_per_session: max, session_count: sessions.size };
};

/**
 * Aggregate friction-kind tokens. `count` is the number of distinct retros
 * mentioning the kind (the retro emitter writes one such string per session).
 */
export const aggregateFrictionKinds = (
    retros: readonly RetroMetaRow[],
): FrictionKindAgg[] => {
    const byKind = new Map<string, { count: number; sessions: Set<string> }>();
    for (const r of retros) {
        const kinds = parseRetroFrictionKinds(r.failed);
        for (const k of kinds) {
            let bucket = byKind.get(k);
            if (!bucket) {
                bucket = { count: 0, sessions: new Set() };
                byKind.set(k, bucket);
            }
            bucket.count += 1;
            if (r.session) bucket.sessions.add(r.session);
        }
    }
    return [...byKind.entries()]
        .map(([kind, b]) => ({
            kind,
            count: b.count,
            session_count: b.sessions.size,
        }))
        .sort((a, b) => b.count - a.count);
};

/**
 * Pure assembler so tests can drive it without DB/fs. The Effect entrypoint
 * below pulls inputs and forwards them through this.
 */
/**
 * Order experiment_status: pending verdicts first (locked_verdict is null),
 * then locked. Within each group, oldest accepted first (highest
 * days_since_accepted) - the agent should triage stale entries before new
 * ones.
 */
export const orderExperimentStatus = (
    rows: readonly ExperimentStatusRow[],
): ExperimentStatusRow[] =>
    [...rows].sort((a, b) => {
        const aPending = a.locked_verdict === null ? 0 : 1;
        const bPending = b.locked_verdict === null ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;
        return b.days_since_accepted - a.days_since_accepted;
    });

export const buildMetaSnapshot = (input: {
    readonly sinceDays: number;
    readonly retros: readonly RetroMetaRow[];
    readonly skills: readonly SkillRow[];
    readonly openProposals: readonly OpenProposalRow[];
    readonly acceptedExperiments: readonly AcceptedExperimentRow[];
    readonly experimentStatus: readonly ExperimentStatusRow[];
    readonly claudeMdUser: string | null;
    readonly claudeMdProject: string | null;
    readonly nowIso?: string;
}): MetaSnapshot => ({
    generated_at: input.nowIso ?? new Date().toISOString(),
    since_days: input.sinceDays,
    retros: input.retros,
    patterns: {
        tool_failures: aggregateToolFailures(input.retros),
        corrections: aggregateCorrections(input.retros),
        friction_kinds: aggregateFrictionKinds(input.retros),
    },
    current_state: {
        skills: input.skills,
        open_proposals: input.openProposals,
        accepted_experiments: input.acceptedExperiments,
        claude_md_user: input.claudeMdUser,
        claude_md_project: input.claudeMdProject,
    },
    experiment_status: orderExperimentStatus(input.experimentStatus),
    investigation_prompts: INVESTIGATION_PROMPTS,
});

export const cmdRetroMeta = (
    args: string[],
): Effect.Effect<void, DbError | JudgmentError, SurrealClient | Judgment | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sinceRaw = flagValue(args, "since");
        const sinceDays = sinceRaw !== undefined && /^\d+$/.test(sinceRaw)
            ? Math.max(1, parseInt(sinceRaw, 10))
            : 30;
        const limitRaw = flagValue(args, "limit-retros");
        const limitRetros = limitRaw !== undefined && /^\d+$/.test(limitRaw)
            ? Math.max(1, parseInt(limitRaw, 10))
            : 50;
        // Default to JSON - the target audience is an AI agent. `--no-json`
        // / `--pretty` are not supported; the CLI is always-JSON for now.
        const pretty = args.includes("--pretty");

        const db = yield* SurrealClient;

        const cutoff = new Date(Date.now() - sinceDays * 86_400_000);
        const [storedRetros, skillsRes, proposals] = yield* Effect.all([
            listStoredRetros({ since: cutoff, limit: limitRetros }),
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT name, scope, description FROM skill ORDER BY name;`,
            ),
            listStoredProposals(1_000),
        ], { concurrency: 3 });

        const retros: RetroMetaRow[] = storedRetros.map((r) => ({
            id: `retro:${r.id}`,
            session: `session:${r.session}`,
            source: r.source,
            tried: r.tried,
            worked: r.worked,
            failed: r.failed,
            next: r.next,
            created_at: r.created_at.toISOString(),
        }));

        const skills: SkillRow[] = (skillsRes?.[0] ?? []).map((s) => ({
            name: String(s.name ?? ""),
            scope: String(s.scope ?? ""),
            description: String(s.description ?? ""),
        }));

        const openProposals: OpenProposalRow[] = proposals
            .filter((proposal) => proposal.status === "open")
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 20)
            .map((proposal) => ({
                dedupe_sig: proposal.dedupe_sig,
                form: proposal.form,
                title: proposal.title,
                frequency: proposal.frequency,
                confidence: proposal.confidence,
            }));

        const experiments = proposals.flatMap((proposal) => proposal.experiment
            ? [{ proposal, experiment: proposal.experiment }]
            : []);
        const acceptedExperiments: AcceptedExperimentRow[] = experiments
            .filter(({ experiment }) => experiment.locked_verdict === null)
            .sort((a, b) => b.experiment.created_at.getTime() - a.experiment.created_at.getTime())
            .slice(0, 20)
            .map(({ proposal, experiment }) => ({
                id: `experiment:${experiment.id}`,
                title: proposal.title,
                artifact_path: experiment.artifact_path,
                locked_verdict: experiment.locked_verdict,
            }));

        const refs = experiments.map(({ experiment }) => recordRef("experiment", experiment.id));
        const opportunityRows = refs.length === 0 ? [] : (yield* db.query<[Array<Record<string, unknown>>]>(`
            SELECT type::string(in) AS experiment_id, count() AS opportunities_count,
                   math::sum(IF was_addressed = true THEN 1 ELSE 0 END) AS addressed_count
            FROM opportunity WHERE in IN [${refs.join(", ")}] GROUP BY experiment_id;
        `))?.[0] ?? [];
        const opportunityByExperiment = new Map(opportunityRows.map((row) => [
            idToString(row.experiment_id).replace(/^experiment:/, ""),
            { opportunities: Number(row.opportunities_count ?? 0), addressed: Number(row.addressed_count ?? 0) },
        ] as const));

        const experimentStatus: ExperimentStatusRow[] = experiments.map(({ proposal, experiment }) => {
            const counts = opportunityByExperiment.get(experiment.id);
            const opps = counts?.opportunities ?? 0;
            const addressed = counts?.addressed ?? 0;
            const ratio = opps > 0 ? addressed / opps : 0;
            const days = Math.max(0, Math.floor((Date.now() - experiment.created_at.getTime()) / 86_400_000));
            const checkpoint = experiment.checkpoints.at(-1);
            const latest: ExperimentStatusCheckpoint | null = checkpoint ? {
                kind: checkpoint.kind,
                suggested: checkpoint.suggested,
                observed_at: checkpoint.observed_at.toISOString(),
            } : null;
            return {
                experiment_id: `experiment:${experiment.id}`,
                proposal_dedupe_sig: proposal.dedupe_sig,
                proposal_title: proposal.title,
                proposal_form: proposal.form,
                artifact_path: experiment.artifact_path,
                days_since_accepted: days,
                opportunities_count: opps,
                addressed_count: addressed,
                address_ratio: ratio,
                latest_checkpoint: latest,
                locked_verdict: experiment.locked_verdict,
            };
        });

        const userMd = `${homedir()}/.claude/CLAUDE.md`;
        const projectMd = `${process.cwd()}/CLAUDE.md`;
        const claudeMdUser = (yield* fs.exists(userMd).pipe(orAbsent(false))) ? userMd : null;
        const claudeMdProject = (yield* fs.exists(projectMd).pipe(orAbsent(false))) ? projectMd : null;

        const snapshot = buildMetaSnapshot({
            sinceDays,
            retros,
            skills,
            openProposals,
            acceptedExperiments,
            experimentStatus,
            claudeMdUser,
            claudeMdProject,
        });

        const out = pretty || process.stdout.isTTY
            ? prettyPrint(snapshot)
            : encodeJson(snapshot);
        console.log(out);
    });
