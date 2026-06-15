/**
 * P3.7: Role read renderers - pure table + JSON output.
 *
 * No I/O, no Effect. Given typed result objects, returns strings.
 *
 * Migrated to renderTable (table.ts) for auto-width column-building.
 * Output is byte-identical to the previous hand-rolled pad/join version.
 */

import type {
    FetchSkillsByRoleResult,
    FetchRolesForSkillResult,
    FetchAllRolesResult,
    SkillByRoleRow,
    RoleForSkillRow,
    RoleRow,
} from "../dashboard/role-queries.ts";
import type { SessionSkillRoleGroup } from "@ax/lib/shared/dashboard-types";
import { renderTable } from "./table.js";
import type { Column } from "./table.js";

export type { SessionSkillRoleGroup as ByRoleGroup } from "@ax/lib/shared/dashboard-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtFloat(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtCount(n: number): string {
    return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// ax skills by-role <role>
// ---------------------------------------------------------------------------

export function renderSkillsByRoleTable(
    result: FetchSkillsByRoleResult,
    role: string,
): string {
    if (!result.found) {
        return `axctl skills by-role: no skills classified as "${role}"`;
    }

    const { rows } = result;

    type RenderedRow = {
        rank: string;
        skill: string;
        invocations: string;
        source: string;
        confidence: string;
    };

    const rendered: RenderedRow[] = rows.map((r: SkillByRoleRow, i: number) => ({
        rank: String(i + 1),
        skill: r.skill_name,
        invocations: fmtCount(r.invocations),
        source: r.source,
        confidence: fmtFloat(r.confidence),
    }));

    const cols: Column<RenderedRow>[] = [
        { header: "rank", get: (r) => r.rank, align: "right" },
        { header: "skill", get: (r) => r.skill, min: 28 },
        { header: "invocations", get: (r) => r.invocations, align: "right" },
        { header: "source", get: (r) => r.source, min: 12 },
        { header: "confidence", get: (r) => r.confidence, align: "right" },
    ];

    const table = renderTable({ columns: cols, rows: rendered });
    return [
        table,
        "",
        `(${rows.length} skill${rows.length === 1 ? "" : "s"} for role "${role}")`,
    ].join("\n");
}

export function renderSkillsByRoleJson(
    result: FetchSkillsByRoleResult,
    role: string,
): string {
    return JSON.stringify(
        {
            role,
            found: result.found,
            rows: result.rows.map((r: SkillByRoleRow) => ({
                skill_id: r.skill_id,
                skill_name: r.skill_name,
                invocations: r.invocations,
                source: r.source,
                confidence: r.confidence,
                rationale: r.rationale,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax skills roles <skill>
// ---------------------------------------------------------------------------

export function renderRolesForSkillTable(
    result: FetchRolesForSkillResult,
    skill: string,
): string {
    if (!result.skillExists) {
        // Caller is expected to exit(2); this string is for stderr.
        return `axctl skills roles: unknown skill "${skill}"`;
    }

    const { rows } = result;

    if (rows.length === 0) {
        return `axctl skills roles: no roles assigned to "${skill}"`;
    }

    type RenderedRow = {
        role: string;
        source: string;
        confidence: string;
        rationale: string;
    };

    const rendered: RenderedRow[] = rows.map((r: RoleForSkillRow) => ({
        role: r.role_name,
        source: r.source,
        confidence: fmtFloat(r.confidence),
        // Raw rationale — renderTable handles truncation via overflow:'ellipsis' + max:50
        rationale: r.rationale ?? "",
    }));

    const cols: Column<RenderedRow>[] = [
        { header: "role", get: (r) => r.role, min: 20 },
        { header: "source", get: (r) => r.source, min: 12 },
        { header: "confidence", get: (r) => r.confidence, align: "right" },
        {
            header: "rationale",
            get: (r) => r.rationale,
            min: 30,
            max: 50,
            overflow: "ellipsis",
        },
    ];

    const table = renderTable({ columns: cols, rows: rendered });
    return [
        table,
        "",
        `(${rows.length} role${rows.length === 1 ? "" : "s"} for skill "${skill}")`,
    ].join("\n");
}

export function renderRolesForSkillJson(
    result: FetchRolesForSkillResult,
    skill: string,
): string {
    return JSON.stringify(
        {
            skill,
            skill_exists: result.skillExists,
            rows: result.rows.map((r: RoleForSkillRow) => ({
                role_name: r.role_name,
                role_weight: r.role_weight,
                source: r.source,
                confidence: r.confidence,
                edge_weight_override: r.edge_weight_override,
                rationale: r.rationale,
                since: r.since,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax roles
// ---------------------------------------------------------------------------

export function renderAllRolesTable(result: FetchAllRolesResult): string {
    const { rows } = result;

    if (rows.length === 0) {
        return "(no roles found)";
    }

    type RenderedRow = {
        role: string;
        weight: string;
        skill_count: string;
    };

    const rendered: RenderedRow[] = rows.map((r: RoleRow) => ({
        role: r.name,
        weight: fmtFloat(r.weight),
        skill_count: fmtCount(r.skill_count),
    }));

    const cols: Column<RenderedRow>[] = [
        { header: "role", get: (r) => r.role, min: 20 },
        { header: "weight", get: (r) => r.weight, align: "right" },
        { header: "skills", get: (r) => r.skill_count, align: "right", min: 6 },
    ];

    const table = renderTable({ columns: cols, rows: rendered });
    return [
        table,
        "",
        `(${rows.length} role${rows.length === 1 ? "" : "s"})`,
    ].join("\n");
}

export function renderAllRolesJson(result: FetchAllRolesResult): string {
    return JSON.stringify(
        {
            rows: result.rows.map((r: RoleRow) => ({
                name: r.name,
                weight: r.weight,
                skill_count: r.skill_count,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax sessions show --by-role helpers
// ---------------------------------------------------------------------------

/**
 * Render the by-role section for a session show.
 * Groups are ordered: named roles first (by total count DESC), then (unclassified).
 */
export function renderByRoleSection(groups: ReadonlyArray<SessionSkillRoleGroup>): string {
    const lines: string[] = [];
    lines.push("## By role");

    if (groups.length === 0) {
        lines.push("(no skill invocations in this session)");
        return lines.join("\n");
    }

    for (const g of groups) {
        const label = g.role ?? "(unclassified)";
        lines.push("");
        lines.push(`### ${label}`);
        if (g.skills.length === 0) {
            lines.push("  (none)");
        } else {
            const maxSkillLen = Math.max(...g.skills.map((s) => s.skill.length), 8);
            for (const s of g.skills) {
                lines.push(`  ${s.skill.padEnd(maxSkillLen)}  ×${s.count}`);
            }
        }
    }

    return lines.join("\n");
}
