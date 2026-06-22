/**
 * NavLink builders - "HATEOAS for LLMs" assembly layer.
 *
 * Pure functions of query payloads (no DB, no Effect) consumed by BOTH the
 * MCP tools and the CLI handlers. Query functions in `dashboard/` stay pure
 * data (they also serve the SPA); turning results into agent affordances is
 * a presentation-protocol concern that lives here.
 *
 * Two-tier policy (ported from quera's unified-search):
 *   - per-hit `next`: exactly one drill-in link.
 *   - top-level `next`: cross-cutting follow-ups, priority-ordered. The
 *     flagship link is the harness resume command for a session result.
 *   - errors-as-teaching: empty results return links that name the broader
 *     query to try next instead of a bare empty array.
 *
 * Every link carries both transports when possible: `call` (MCP tool payload,
 * copy verbatim) and `cmd` (literal shell command, run as-is).
 */
import type { NavLink } from "@ax/lib/shared/nav-link";
import { sortNavLinks } from "@ax/lib/shared/nav-link";
import { buildResumeAction } from "@ax/lib/shared/resume-command";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type {
    RecallResponse,
    RecallHit,
    SessionViewPayload,
} from "@ax/lib/shared/dashboard-types";
import type { WithNext } from "@ax/lib/shared/nav-link";
import type { SessionRow } from "../dashboard/sessions-query.ts";
import type { RecallSource } from "../dashboard/recall.ts";
import type { SkillsWeightedResult } from "../dashboard/skills-weighted.ts";
import type {
    FetchSkillsByRoleResult,
    FetchRolesForSkillResult,
    FetchAllRolesResult,
} from "../dashboard/role-queries.ts";
import type { CostModelsResult, CostSplitResult } from "../queries/cost-analytics.ts";
import type { DispatchesResult, CandidatesResult } from "../queries/dispatch-analytics.ts";

// ---------------------------------------------------------------------------
// Protocol hint - appended to tool/CLI descriptions
// ---------------------------------------------------------------------------

export const NEXT_PROTOCOL_HINT =
    "Results include a `next` array of ready-to-run follow-up actions: copy `call` payloads verbatim into the named tool, or run `cmd` strings as-is (e.g. the exact harness resume command for a session). Empty results return `next` suggestions for broader queries.";

// ---------------------------------------------------------------------------
// Shared link constructors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Studio deeplinks
// ---------------------------------------------------------------------------

/**
 * Where a Studio deeplink points. Resolved by the caller (CLI handler / MCP
 * tool) via `resolveStudioTarget` so these builders stay pure - the dashboard
 * module owns pidfile/port discovery.
 */
export interface StudioDeeplink {
    /** `http://localhost:<port>` - no trailing slash. */
    readonly baseUrl: string;
    /** A managed ax daemon appears to be running. Tunes the link copy. */
    readonly live: boolean;
}

/**
 * The Studio session route - single source of the deeplink shape so agents
 * never have to read frontend route code or guess the URL (issue #563). Bare
 * session id (the `session:⟨…⟩` wrapper is stripped) keeps the URL clean.
 */
export const studioSessionUrl = (baseUrl: string, sessionId: string): string =>
    `${baseUrl.replace(/\/+$/, "")}/sessions/${toBareSessionId(sessionId)}`;

/**
 * "Open in Studio" deeplink for a session. Carries the URL as the transport;
 * when no daemon is up the URL still uses the default port (stable route) and
 * the description points the user at `ax serve`. Works for normal and
 * subagent sessions alike - the route renders both.
 */
export const studioSessionLink = (
    sessionId: string,
    studio: StudioDeeplink,
    priority = 7,
): NavLink => ({
    description: studio.live
        ? "Open this session in ax Studio"
        : "Open this session in ax Studio (start the daemon first: ax serve)",
    url: studioSessionUrl(studio.baseUrl, sessionId),
    ui: { priority, group: "navigate" },
});

/** Drill-in link for a session id - dual transport. */
export const sessionShowLink = (
    sessionId: string,
    description = "Drill into this session",
    priority = 8,
): NavLink => {
    const id = toBareSessionId(sessionId);
    return {
        description,
        call: { tool: "session_show", arguments: { sessionId: id } },
        cmd: `ax sessions show ${id}`,
        ui: { priority, group: "read" },
    };
};

/** Roles-of-skill link - dual transport. */
export const skillRolesLink = (
    skill: string,
    description = "List the roles this skill plays",
    priority = 6,
): NavLink => ({
    description,
    call: { tool: "skills_roles", arguments: { skill } },
    cmd: `ax skills roles ${skill}`,
    ui: { priority, group: "read" },
});

/**
 * Resume link for a session, or null when the source has no verified resume
 * path (subagent → handled by caller via parent link; pi/opencode/cursor →
 * deliberately omitted).
 */
export const sessionResumeLink = (input: {
    readonly sessionId: string;
    readonly source: string;
    readonly cwd?: string | null;
    readonly priority?: number;
}): NavLink | null => {
    const action = buildResumeAction({
        sessionId: input.sessionId,
        source: input.source,
        cwd: input.cwd ?? null,
    });
    if (action.kind !== "resume" || action.command === null) return null;
    const caveat = action.note ? ` (${action.note})` : "";
    return {
        description: `Resume this session in its harness (${input.source})${caveat}`,
        cmd: action.command,
        ui: { priority: input.priority ?? 10, group: "resume" },
    };
};

/** sessions_around link centred on a timestamp - dual transport. */
const sessionsAroundLink = (
    ts: string,
    days: number,
    description: string,
    priority = 5,
): NavLink => {
    const date = ts.slice(0, 10); // YYYY-MM-DD
    return {
        description,
        call: { tool: "sessions_around", arguments: { date, days } },
        cmd: `ax sessions around ${date} --days=${days}`,
        ui: { priority, group: "search" },
    };
};

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

const ALL_SOURCES: ReadonlyArray<RecallSource> = ["turn", "commit", "skill"];

export interface RecallNextOptions {
    readonly requestedSources: ReadonlyArray<RecallSource>;
    /** When set, each turn hit gains an "open in Studio" deeplink. */
    readonly studio?: StudioDeeplink;
}

export interface RecallWithNext {
    readonly hits: ReadonlyArray<WithNext<RecallHit>>;
    readonly next: ReadonlyArray<NavLink>;
}

/**
 * Decorate a RecallResponse: per-hit drill-ins + top-level cross-cutting
 * links (resume for the most recent resumable sessions, browse-the-day,
 * broaden-sources when results are thin or absent).
 */
export const buildRecallNext = (
    r: RecallResponse,
    opts: RecallNextOptions,
): RecallWithNext => {
    const hits: Array<WithNext<RecallHit>> = r.hits.map((h) => ({
        ...h,
        next: [
            sessionShowLink(h.session_id, "Read the session this turn belongs to"),
            ...(opts.studio ? [studioSessionLink(h.session_id, opts.studio)] : []),
        ],
    }));

    const top: NavLink[] = [];

    // ① Resume the most recent resumable sessions (hits are ts DESC; dedupe
    //    by session id, cap at 2 distinct sessions).
    const seen = new Set<string>();
    for (const h of r.hits) {
        if (seen.size >= 2) break;
        const id = toBareSessionId(h.session_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const link = sessionResumeLink({
            sessionId: id,
            source: h.source ?? "",
            cwd: h.cwd,
        });
        if (link) top.push(link);
    }

    // ② Browse what else happened around the top hit.
    const topTs = r.hits[0]?.ts;
    if (topTs) {
        top.push(
            sessionsAroundLink(topTs, 1, "See what else happened around the top hit", 5),
        );
    }

    const broaden: NavLink = {
        description: "Broaden the search to all sources (turns, commits, skills)",
        call: { tool: "recall", arguments: { q: r.q, sources: [...ALL_SOURCES] } },
        cmd: `ax recall ${JSON.stringify(r.q)} --sources=turn,commit,skill`,
        ui: { priority: 4, group: "search" },
    };
    const subsetRequested = opts.requestedSources.length < ALL_SOURCES.length;

    if (r.total_count === 0) {
        // Errors-as-teaching: nothing matched - name the broader queries.
        if (subsetRequested) top.push({ ...broaden, ui: { ...broaden.ui, priority: 9 } });
        top.push({
            description:
                "No text match - browse sessions near a known date instead",
            call: { tool: "sessions_around", arguments: { date: "<YYYY-MM-DD>", days: 3 } },
            cmd: "ax sessions around <YYYY-MM-DD> --days=3",
            ui: { priority: 8, group: "search" },
        });
    } else if (subsetRequested && r.total_count < 3) {
        // ④ Thin results from a subset of sources - suggest widening.
        top.push(broaden);
    }

    return { hits, next: sortNavLinks(top) };
};

// ---------------------------------------------------------------------------
// sessions (here / around / near)
// ---------------------------------------------------------------------------

export interface SessionsNextOptions {
    readonly date?: string | undefined;
    readonly days?: number | undefined;
    readonly project?: string | null | undefined;
    /** When set, each session row gains an "open in Studio" deeplink. */
    readonly studio?: StudioDeeplink;
}

export interface SessionsWithNext {
    readonly sessions: ReadonlyArray<WithNext<SessionRow>>;
    readonly next: ReadonlyArray<NavLink>;
}

/**
 * Decorate session rows: per-row drill-in + top-level resume links for the
 * most recent resumable sessions. Empty windows teach widening.
 */
export const buildSessionsNext = (
    rows: ReadonlyArray<SessionRow>,
    opts: SessionsNextOptions = {},
): SessionsWithNext => {
    const sessions: Array<WithNext<SessionRow>> = rows.map((row) => ({
        ...row,
        next: [
            sessionShowLink(row.id),
            ...(opts.studio ? [studioSessionLink(row.id, opts.studio)] : []),
        ],
    }));

    const top: NavLink[] = [];

    // ① Resume links for the most recent resumable sessions (rows arrive
    //    newest-first from the queries; cap at 2).
    let resumes = 0;
    for (const row of rows) {
        if (resumes >= 2) break;
        const link = sessionResumeLink({
            sessionId: row.id,
            source: row.source,
            cwd: row.cwd,
        });
        if (link) {
            top.push(link);
            resumes += 1;
        }
    }

    // ③ Churn rollup over the same scope - cmd-only until an MCP
    //    sessions_churn tool exists.
    if (rows.length > 0) {
        top.push({
            description: "Aggregate verification churn (edit vs repair LOC, failed checks) for this scope",
            cmd: opts.project
                ? `ax sessions churn --project="${opts.project}"`
                : "ax sessions churn",
            ui: { priority: 5, group: "read" },
        });
    }

    // ⑤ Empty window - teach widening / dropping the filter.
    if (rows.length === 0 && opts.date) {
        const widened = (opts.days ?? 3) * 2;
        top.push(
            sessionsAroundLink(
                opts.date,
                widened,
                `No sessions in the window - widen to ±${widened} days`,
                9,
            ),
        );
        if (opts.project) {
            top.push({
                description: "Drop the project filter and search all projects",
                call: {
                    tool: "sessions_around",
                    arguments: { date: opts.date.slice(0, 10), days: opts.days ?? 3 },
                },
                cmd: `ax sessions around ${opts.date.slice(0, 10)} --days=${opts.days ?? 3}`,
                ui: { priority: 8, group: "search" },
            });
        }
    }

    return { sessions, next: sortNavLinks(top) };
};

// ---------------------------------------------------------------------------
// session show
// ---------------------------------------------------------------------------

/**
 * Top-level links for a session detail view: resume (or parent for
 * subagents), expand-subagents when children exist but none are expanded.
 */
export const buildSessionShowNext = (
    p: SessionViewPayload,
    studio?: StudioDeeplink,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    const overview = p.session.overview;
    if (!overview) return top;
    const id = toBareSessionId(overview.id);

    // ① Resume - or ② the parent link when this is a subagent session.
    const resume = sessionResumeLink({
        sessionId: id,
        source: overview.source,
        cwd: overview.cwd,
    });
    if (resume) top.push(resume);

    // ③ Open this focused session in Studio (issue #563) - the user can see
    //    the timeline/graph in the UI. Below resume so the harness command
    //    stays the flagship, above the expand-subagents affordance.
    if (studio) top.push(studioSessionLink(id, studio, 8));

    if (p.session.parent) {
        top.push(
            sessionShowLink(
                p.session.parent.session_id,
                overview.source === "claude-subagent"
                    ? "Subagent sessions are not resumable - open the parent session"
                    : "Open the parent session",
                9,
            ),
        );
    }

    // ⑥ Expand subagents when children exist and nothing is expanded yet.
    if (p.session.children.length > 0 && p.expanded_subagents.length === 0) {
        top.push({
            description: `Expand all ${p.session.children.length} subagent children inline`,
            call: { tool: "session_show", arguments: { sessionId: id, expandAll: true } },
            cmd: `ax sessions show ${id} --all`,
            ui: { priority: 7, group: "read" },
        });
    }

    return sortNavLinks(top);
};

// ---------------------------------------------------------------------------
// skills weighted / by-role / roles
// ---------------------------------------------------------------------------

/** skills_by_role link - dual transport. */
const skillsByRoleLink = (
    role: string,
    description: string,
    priority = 6,
): NavLink => ({
    description,
    call: { tool: "skills_by_role", arguments: { role } },
    cmd: `ax skills by-role ${role}`,
    ui: { priority, group: "read" },
});

/** Top-level links for the weighted skill ranking. */
export const buildSkillsWeightedNext = (
    result: SkillsWeightedResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (result.doctor.unclassified_count > 0) {
        top.push({
            description: `${result.doctor.unclassified_count} skills are unclassified - emit classify briefs to improve the ranking`,
            cmd: "ax skills classify",
            ui: { priority: 9, group: "classify" },
        });
    }
    const topRow = result.rows[0];
    if (topRow) {
        top.push(
            skillRolesLink(
                topRow.skill_name,
                "Inspect the roles behind the top-ranked skill",
                6,
            ),
        );
    }
    return sortNavLinks(top);
};

/** Top-level links for a skills-by-role listing. */
export const buildSkillsByRoleNext = (
    result: FetchSkillsByRoleResult,
    _role: string,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (!result.found || result.rows.length === 0) {
        // Errors-as-teaching: name the tool that lists valid role labels.
        top.push({
            description: "No skills matched this role - list the valid role labels",
            call: { tool: "roles", arguments: {} },
            cmd: "ax roles",
            ui: { priority: 9, group: "search" },
        });
        return top;
    }
    const topSkill = result.rows[0];
    if (topSkill) {
        top.push(
            skillRolesLink(
                topSkill.skill_name,
                "See all roles the top skill plays",
                6,
            ),
        );
    }
    return sortNavLinks(top);
};

/** Top-level links for a roles-of-skill listing. */
export const buildSkillsRolesNext = (
    result: FetchRolesForSkillResult,
    skill: string,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (!result.skillExists) {
        // Errors-as-teaching: find the right skill name via recall.
        top.push({
            description: `Unknown skill "${skill}" - search the skill catalog for the right name`,
            call: { tool: "recall", arguments: { q: skill, sources: ["skill"] } },
            cmd: `ax recall ${JSON.stringify(skill)} --sources=skill`,
            ui: { priority: 9, group: "search" },
        });
        return top;
    }
    const topRole = result.rows[0];
    if (topRole) {
        top.push(
            skillsByRoleLink(
                topRole.role_name,
                "List the other skills that play this skill's top role",
                6,
            ),
        );
    }
    return sortNavLinks(top);
};

/** Top-level links for the role vocabulary listing. */
export const buildRolesNext = (
    result: FetchAllRolesResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    const biggest = [...result.rows].sort((a, b) => b.skill_count - a.skill_count)[0];
    if (biggest) {
        top.push(
            skillsByRoleLink(
                biggest.name,
                `Drill into the largest role (${biggest.skill_count} skills)`,
                6,
            ),
        );
    }
    return sortNavLinks(top);
};

// ---------------------------------------------------------------------------
// improve (recommend / list)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cost models / split
// ---------------------------------------------------------------------------

/** Top-level links for cost models rollup. */
export const buildCostModelsNext = (
    result: CostModelsResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (result.rows.length === 0) {
        top.push({
            description: "No cost data - widen the window",
            cmd: "ax cost models --days=30",
            ui: { priority: 8, group: "search" },
        });
        return top;
    }
    top.push({
        description: "Show top sessions by cost",
        call: { tool: "cost_models", arguments: { days: 14 } },
        cmd: "ax cost sessions",
        ui: { priority: 7, group: "read" },
    });
    top.push({
        description: "Split cost by origin (main vs subagent) × model",
        call: { tool: "cost_split", arguments: {} },
        cmd: "ax cost split",
        ui: { priority: 6, group: "read" },
    });
    return sortNavLinks(top);
};

/** Top-level links for cost split matrix. */
export const buildCostSplitNext = (
    result: CostSplitResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (result.totals.cost_usd === 0) {
        top.push({
            description: "No cost data - widen the window",
            cmd: "ax cost split --days=30",
            ui: { priority: 8, group: "search" },
        });
        return top;
    }
    top.push({
        description: "Per-model rollup with session counts",
        call: { tool: "cost_models", arguments: {} },
        cmd: "ax cost models",
        ui: { priority: 7, group: "read" },
    });
    top.push({
        description: "Top sessions by cost",
        cmd: "ax cost sessions",
        ui: { priority: 6, group: "read" },
    });
    return sortNavLinks(top);
};

// ---------------------------------------------------------------------------
// improve (recommend / list)
// ---------------------------------------------------------------------------

/**
 * Top-level links for proposal shortlists. `sig` is the dedupe signature /
 * short id accepted by improve_show and `ax improve accept`. The accept
 * link is cmd-only: mutating ops are deliberately not exposed over MCP.
 */
export const buildImproveProposalsNext = (
    proposals: ReadonlyArray<{ readonly sig: string; readonly title: string }>,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    const first = proposals[0];
    if (!first) {
        top.push({
            description: "No proposals - widen the filter to all statuses",
            call: { tool: "improve_list", arguments: { status: "all" } },
            cmd: "ax improve list --status=all",
            ui: { priority: 8, group: "search" },
        });
        return top;
    }
    top.push({
        description: `Inspect the evidence trail behind the top proposal ("${first.title.slice(0, 60)}")`,
        call: { tool: "improve_show", arguments: { sigOrId: first.sig } },
        cmd: `ax improve show ${first.sig}`,
        ui: { priority: 7, group: "read" },
    });
    top.push({
        description: "Accept the top proposal (emits a .ax/tasks brief; CLI-only, mutating)",
        cmd: `ax improve accept ${first.sig}`,
        ui: { priority: 5, group: "act" },
    });
    return sortNavLinks(top);
};

// ---------------------------------------------------------------------------
// dispatches / dispatch candidates
// ---------------------------------------------------------------------------

/** Top-level links for dispatch analytics. */
export const buildDispatchesNext = (
    result: DispatchesResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (result.total_dispatches === 0) {
        top.push({
            description: "No dispatches - widen the window",
            cmd: "ax dispatches --days=30",
            ui: { priority: 8, group: "search" },
        });
        return top;
    }
    top.push({
        description: "Show only routing candidates (inherit + expensive + matching class)",
        call: { tool: "dispatches", arguments: { days: 14, candidates: true } },
        cmd: "ax dispatches --candidates",
        ui: { priority: 7, group: "read" },
    });
    top.push({
        description: "Split cost by origin (main vs subagent) × model",
        call: { tool: "cost_split", arguments: {} },
        cmd: "ax cost split",
        ui: { priority: 6, group: "read" },
    });
    return sortNavLinks(top);
};

/** Top-level links for dispatch candidates. */
export const buildCandidatesNext = (
    result: CandidatesResult,
): ReadonlyArray<NavLink> => {
    const top: NavLink[] = [];
    if (result.candidates.length === 0) {
        top.push({
            description: "No candidates - see full dispatch table",
            cmd: "ax dispatches --days=30",
            ui: { priority: 8, group: "search" },
        });
        return top;
    }
    top.push({
        description: "Write routing table to ~/.ax/hooks/routing-table.json",
        cmd: "ax dispatches compile-routing",
        ui: { priority: 7, group: "act" },
    });
    top.push({
        description: "Full dispatch table (all dispatches, not just candidates)",
        cmd: "ax dispatches",
        ui: { priority: 6, group: "read" },
    });
    return sortNavLinks(top);
};
