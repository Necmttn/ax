import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchAllRoles, fetchRolesForSkill, fetchSkillsByRole, normalizeSkillsByRoleParams } from "./role-queries.ts";
import { publishDashboardFixture, runDashboardRead } from "./testing/duckdb.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("role queries");

describe("role queries", () => {
    dtest("joins skills, roles, and invocation counts in DuckDB", async () => {
        const ts = new Date("2026-08-15T00:00:00Z");
        const fixture = await publishDashboardFixture(tempDir("ax-roles-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s1", source: "claude" });
            yield* db.put("turn", { id: "t1", session: "s1", seq: 1, ts, role: "user", has_tool_use: false, has_error: false });
            yield* db.putMany("skill", [
                { id: "sk1", name: "debug", scope: "user", dir_path: "/debug", content_hash: "h1" },
                { id: "sk2", name: "review", scope: "user", dir_path: "/review", content_hash: "h2" },
            ]);
            yield* db.putMany("role", [{ id: "r1", name: "diagnosis", weight: 2 }, { id: "r2", name: "review", weight: 1 }]);
            yield* db.putMany("plays_role", [
                { id: "pr1", in_id: "sk1", out_id: "r1", source: "manual", confidence: 0.9, rationale: "fit", since: ts },
                { id: "pr2", in_id: "sk2", out_id: "r1", source: "manual", confidence: 0.8, rationale: null, since: ts },
            ]);
            yield* db.put("invoked", { id: "i1", in_id: "t1", out_id: "sk1", session: "s1", ts, turn_has_error: false, was_corrected: false });
        }));
        const skills = await runDashboardRead(fixture, fetchSkillsByRole({ role: "diagnosis", limit: 10 }));
        expect(skills.rows.map((row) => [row.skill_name, row.invocations])).toEqual([["debug", 1], ["review", 0]]);
        const roles = await runDashboardRead(fixture, fetchRolesForSkill({ skill: "debug" }));
        expect(roles).toMatchObject({ skillExists: true, rows: [{ role_name: "diagnosis", role_weight: 2, since: ts.toISOString() }] });
        const all = await runDashboardRead(fixture, fetchAllRoles());
        expect(all.rows.map((row) => [row.name, row.skill_count])).toEqual([["diagnosis", 2], ["review", 0]]);
        expect(normalizeSkillsByRoleParams({ role: "x" }).limit).toBe(50);
    });
});
