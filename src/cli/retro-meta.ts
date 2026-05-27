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

import { Effect } from "effect";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { prettyPrint } from "../lib/json.ts";
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
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
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

        const [retrosRes, skillsRes, openPropsRes, expsRes, expStatusRes] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT id, session, source, tried, worked, failed, next,
                        type::string(created_at) AS created_at
                 FROM retro
                 WHERE created_at > time::now() - ${sinceDays}d
                 ORDER BY created_at DESC LIMIT ${limitRetros};`,
            ),
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT name, scope, description FROM skill ORDER BY name;`,
            ),
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT dedupe_sig, form, title, frequency, confidence
                 FROM proposal
                 WHERE status = 'open'
                 ORDER BY frequency DESC LIMIT 20;`,
            ),
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT id, proposal.title AS title, artifact_path, locked_verdict, created_at
                 FROM experiment
                 WHERE locked_verdict IS NONE
                 ORDER BY created_at DESC LIMIT 20;`,
            ),
            db.query<[Array<Record<string, unknown>>]>(
                `SELECT
                    id,
                    proposal.dedupe_sig AS proposal_dedupe_sig,
                    proposal.title AS proposal_title,
                    proposal.form AS proposal_form,
                    artifact_path,
                    created_at,
                    type::string(created_at) AS created_at_iso,
                    duration::days(time::now() - created_at) AS days_since_accepted,
                    (SELECT count() FROM opportunity WHERE in = $parent.id GROUP ALL)[0].count ?? 0 AS opportunities_count,
                    (SELECT count() FROM opportunity WHERE in = $parent.id AND was_addressed = true GROUP ALL)[0].count ?? 0 AS addressed_count,
                    (SELECT kind, suggested, type::string(observed_at) AS observed_at
                     FROM checkpoint
                     WHERE experiment = $parent.id
                     ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint,
                    locked_verdict
                 FROM experiment
                 ORDER BY created_at DESC;`,
            ),
        ], { concurrency: 5 });

        const rawRetros = retrosRes?.[0] ?? [];
        const retros: RetroMetaRow[] = rawRetros.map((r) => ({
            id: idToString(r.id),
            session: idToString(r.session),
            source: String(r.source ?? ""),
            tried: String(r.tried ?? ""),
            worked: r.worked == null ? null : String(r.worked),
            failed: r.failed == null ? null : String(r.failed),
            next: r.next == null ? null : String(r.next),
            created_at: String(r.created_at ?? ""),
        }));

        const skills: SkillRow[] = (skillsRes?.[0] ?? []).map((s) => ({
            name: String(s.name ?? ""),
            scope: String(s.scope ?? ""),
            description: String(s.description ?? ""),
        }));

        const openProposals: OpenProposalRow[] = (openPropsRes?.[0] ?? []).map((p) => ({
            dedupe_sig: String(p.dedupe_sig ?? ""),
            form: String(p.form ?? ""),
            title: String(p.title ?? ""),
            frequency: Number(p.frequency ?? 0),
            confidence: String(p.confidence ?? "low"),
        }));

        const acceptedExperiments: AcceptedExperimentRow[] = (expsRes?.[0] ?? []).map((e) => ({
            id: idToString(e.id),
            title: String(e.title ?? ""),
            artifact_path: e.artifact_path == null ? null : String(e.artifact_path),
            locked_verdict: e.locked_verdict == null ? null : String(e.locked_verdict),
        }));

        const experimentStatus: ExperimentStatusRow[] = (expStatusRes?.[0] ?? []).map((e) => {
            const opps = Number(e.opportunities_count ?? 0);
            const addressed = Number(e.addressed_count ?? 0);
            const ratio = opps > 0 ? addressed / opps : 0;
            const createdAtIso = e.created_at_iso == null ? null : String(e.created_at_iso);
            const days = coerceDaysSinceAccepted(e.days_since_accepted, createdAtIso);
            const cp = e.latest_checkpoint;
            let latest: ExperimentStatusCheckpoint | null = null;
            if (cp && typeof cp === "object") {
                const c = cp as Record<string, unknown>;
                latest = {
                    kind: String(c.kind ?? ""),
                    suggested: c.suggested == null ? null : String(c.suggested),
                    observed_at: String(c.observed_at ?? ""),
                };
            }
            return {
                experiment_id: idToString(e.id),
                proposal_dedupe_sig: String(e.proposal_dedupe_sig ?? ""),
                proposal_title: String(e.proposal_title ?? ""),
                proposal_form: String(e.proposal_form ?? ""),
                artifact_path: e.artifact_path == null ? null : String(e.artifact_path),
                days_since_accepted: days,
                opportunities_count: opps,
                addressed_count: addressed,
                address_ratio: ratio,
                latest_checkpoint: latest,
                locked_verdict: e.locked_verdict == null ? null : String(e.locked_verdict),
            };
        });

        const userMd = `${homedir()}/.claude/CLAUDE.md`;
        const projectMd = `${process.cwd()}/CLAUDE.md`;
        const claudeMdUser = existsSync(userMd) ? userMd : null;
        const claudeMdProject = existsSync(projectMd) ? projectMd : null;

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
            : JSON.stringify(snapshot);
        console.log(out);
    });
