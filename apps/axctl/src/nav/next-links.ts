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

// ---------------------------------------------------------------------------
// Protocol hint - appended to tool/CLI descriptions
// ---------------------------------------------------------------------------

export const NEXT_PROTOCOL_HINT =
    "Results include a `next` array of ready-to-run follow-up actions: copy `call` payloads verbatim into the named tool, or run `cmd` strings as-is (e.g. the exact harness resume command for a session). Empty results return `next` suggestions for broader queries.";

// ---------------------------------------------------------------------------
// Shared link constructors
// ---------------------------------------------------------------------------

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
        next: [sessionShowLink(h.session_id, "Read the session this turn belongs to")],
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
        next: [sessionShowLink(row.id)],
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
