import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import {
    SESSION_AGENT_DELEGATIONS_SQL,
    SESSION_CHILDREN_SQL,
    SESSION_OVERVIEW_SQL,
    SESSION_PARENT_SQL,
    SESSION_TOOL_CALLS_SQL,
    SESSION_TOP_SKILLS_SQL,
} from "../queries/session-detail.ts";
import type {
    SessionAgentDelegation,
    SessionDetailPayload,
    SessionLink,
    SessionOverview,
    SessionToolCall,
    SessionTopSkill,
} from "../lib/shared/dashboard-types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const numericField = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

const recordIdString = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "toString" in v) {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
};

const truncate = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/**
 * Classify a Claude Agent dispatch by its description so the workflow page
 * can render P/E/R/M consistently for inline subagents too.
 */
function classifyAgentDescription(desc: string | null): SessionAgentDelegation["phase"] {
    if (!desc) return "other";
    const lower = desc.toLowerCase();
    if (/(plan|brainstorm|research|design|spec|architecture)/.test(lower)) return "plan";
    if (/(review|audit|verify|check|qa|simplify|diagnose)/.test(lower)) return "review";
    if (/(merge|ship|release|deploy)/.test(lower)) return "merge";
    if (/(implement|build|fix|edit|write|migrate|refactor|integrate|wire|add|execute)/.test(lower)) return "execute";
    return "other";
}

const parseOverview = (raw: unknown): SessionOverview | null => {
    if (!isRecord(raw)) return null;
    const id = recordIdString(raw.id);
    if (!id) return null;
    return {
        id,
        project: stringField(raw, "project"),
        cwd: stringField(raw, "cwd"),
        model: stringField(raw, "model"),
        source: stringField(raw, "source") ?? "claude",
        started_at: dateField(raw, "started_at"),
        ended_at: dateField(raw, "ended_at"),
    };
};

const parseSkill = (raw: unknown): SessionTopSkill | null => {
    if (!isRecord(raw)) return null;
    const skill = stringField(raw, "skill");
    if (!skill) return null;
    return {
        skill,
        count: numericField(raw, "count"),
        last_used: dateField(raw, "last_used"),
    };
};

const parseToolCall = (raw: unknown): SessionToolCall | null => {
    if (!isRecord(raw)) return null;
    const label = stringField(raw, "label");
    if (!label) return null;
    return {
        label,
        count: numericField(raw, "count"),
        failures: numericField(raw, "failures"),
        last_used: dateField(raw, "last_used"),
    };
};

const parseLink = (raw: unknown, sessionKey: "child" | "parent"): SessionLink | null => {
    if (!isRecord(raw)) return null;
    const sid = recordIdString(raw[sessionKey]);
    if (!sid) return null;
    return {
        session_id: sid,
        project: stringField(raw, "project"),
        started_at: dateField(raw, "started_at"),
        nickname: stringField(raw, "nickname"),
        tool: stringField(raw, "tool"),
        ts: dateField(raw, "ts"),
    };
};

const parseAgentDelegation = (raw: unknown): SessionAgentDelegation | null => {
    if (!isRecord(raw)) return null;
    const id = recordIdString(raw.id);
    const ts = dateField(raw, "ts");
    if (!id || !ts) return null;
    const rawInput = stringField(raw, "input_json");
    let subagent_type: string | null = null;
    let description: string | null = null;
    let prompt: string | null = null;
    if (rawInput) {
        const parsed = decodeJsonOrNull(rawInput);
        if (isRecord(parsed)) {
            subagent_type = stringField(parsed, "subagent_type");
            description = stringField(parsed, "description");
            const p = stringField(parsed, "prompt");
            if (p) prompt = truncate(p, 280);
        }
    }
    const outputRaw = stringField(raw, "output_excerpt");
    return {
        id,
        ts,
        subagent_type,
        description,
        prompt_excerpt: prompt,
        output_excerpt: outputRaw ? truncate(outputRaw, 280) : null,
        phase: classifyAgentDescription(description ?? subagent_type),
    };
};

// Accepts both real UUIDs ("019e0ad4-c977-...") and our synthetic prefixed
// ids ("claude-subagent-a41ef01d6ca8d521c"). Restrict the charset to the
// set SurrealDB uses for unquoted record ids so we don't accidentally
// interpolate something that needs escaping.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export const fetchSessionDetail = (
    sessionId: string,
): Effect.Effect<SessionDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Parse and validate so we can safely inline the record id. SurrealDB
        // binding via { sessionId: new RecordId(...) } silently produced empty
        // results, so we go direct - but only after UUID validation.
        const uuid = sessionId
            .replace(/^session:⟨/, "")
            .replace(/⟩$/, "")
            .replace(/^session:/, "");
        if (!SESSION_ID_RE.test(uuid)) {
            return {
                overview: null,
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
            };
        }
        const recordRef = `session:⟨${uuid}⟩`;
        const subst = (sql: string): string => sql.replace(/\$sessionId/g, recordRef);

        const [overviewRows, skillRows, toolRows, childRows, parentRows, agentRows] =
            yield* Effect.all([
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_OVERVIEW_SQL)),
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_TOP_SKILLS_SQL)),
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_TOOL_CALLS_SQL)),
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_CHILDREN_SQL)),
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_PARENT_SQL)),
                db.query<[Array<Record<string, unknown>>]>(subst(SESSION_AGENT_DELEGATIONS_SQL)),
            ]);

        const overview = parseOverview(overviewRows?.[0]?.[0]);
        const top_skills = (skillRows?.[0] ?? [])
            .map(parseSkill)
            .filter((s): s is SessionTopSkill => s !== null);
        const tool_calls = (toolRows?.[0] ?? [])
            .map(parseToolCall)
            .filter((t): t is SessionToolCall => t !== null);
        const children = (childRows?.[0] ?? [])
            .map((r) => parseLink(r, "child"))
            .filter((l): l is SessionLink => l !== null);
        const parent = parseLink(parentRows?.[0]?.[0], "parent");
        const agent_delegations = (agentRows?.[0] ?? [])
            .map(parseAgentDelegation)
            .filter((d): d is SessionAgentDelegation => d !== null);

        return {
            overview,
            top_skills,
            tool_calls,
            children,
            parent,
            agent_delegations,
        };
    });
