/**
 * `relateSkillRoles` against a REAL SQLite judgment sidecar.
 *
 * Frontmatter role tags are durable judgment, so they land in the sidecar rather
 * than the rebuildable DuckDB cache. Asserting on SQL text could not tell a
 * working write from one that merely looked right - the two interesting
 * failure modes here are behavioural, not textual:
 *   - the sweep must remove ONLY this writer's `source = 'frontmatter'` rows, so
 *     a user's `ax skills tag` on the same skill-role pair survives re-ingest;
 *   - a re-ingest must NOT reset a role's user-tuned `weight`.
 * Both are checked by reading the rows back out of a real database.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { Judgment, JudgmentLayer, NumberColumn, TextColumn } from "@ax/lib/sqlite";
import { roleRowId } from "@ax/lib/stable-id";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { relateSkillRoles } from "./skill-role.ts";

const SKILL_ID = "skill:test-skill";

const TagRow = Schema.Struct({
    in_id: TextColumn,
    out_id: TextColumn,
    source: TextColumn,
    confidence: NumberColumn,
});
const RoleRow = Schema.Struct({ id: TextColumn, name: TextColumn, weight: NumberColumn });

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-skill-role-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Run `body` against a fresh sidecar in this test's temp dir. */
const overSidecar = <A, E>(
    body: Effect.Effect<A, E, Judgment>,
): Promise<A> =>
    Effect.runPromise(
        body.pipe(
            Effect.scoped,
            Effect.provide(JudgmentLayer({
                sidecarPath: join(dir, "judgment.sqlite"),
                schemaSql: SIDECAR_SCHEMA_SQL,
            })),
            Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
        ) as Effect.Effect<A, E>,
    );

const tags = Effect.gen(function* () {
    const judgment = yield* Judgment;
    return yield* judgment.rows(
        TagRow,
        "SELECT in_id, out_id, source, confidence FROM plays_role ORDER BY out_id, source",
    );
});

const roles = Effect.gen(function* () {
    const judgment = yield* Judgment;
    return yield* judgment.rows(RoleRow, "SELECT id, name, weight FROM role ORDER BY name");
});

describe("relateSkillRoles", () => {
    test("writes one role row and one frontmatter edge per named role", async () => {
        const { result, edges, roleRows } = await overSidecar(Effect.gen(function* () {
            const result = yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing", "execution"] });
            return { result, edges: yield* tags, roleRows: yield* roles };
        }));

        expect(result).toEqual({ rolesUpserted: 2, edgesWritten: 2, rolesSkipped: 0 });
        expect(roleRows.map((r) => r.name)).toEqual(["execution", "framing"]);
        // The DDL's DEFAULT seeds the weight on the create path.
        expect(roleRows.every((r) => r.weight === 1)).toBe(true);
        expect(edges).toHaveLength(2);
        expect(edges.every((e) => e.in_id === SKILL_ID && e.source === "frontmatter")).toBe(true);
        expect(new Set(edges.map((e) => e.out_id)))
            .toEqual(new Set([roleRowId("framing"), roleRowId("execution")]));
    });

    test("normalizes and de-duplicates role names", async () => {
        const { result, edges } = await overSidecar(Effect.gen(function* () {
            const result = yield* relateSkillRoles({
                skillId: SKILL_ID,
                roles: ["framing", "Framing", " framing "],
            });
            return { result, edges: yield* tags };
        }));

        expect(result.rolesUpserted).toBe(1);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.out_id).toBe(roleRowId("framing"));
    });

    test("skips an invalid role name rather than failing the stage", async () => {
        const { result, edges } = await overSidecar(Effect.gen(function* () {
            const result = yield* relateSkillRoles({
                skillId: SKILL_ID,
                roles: ["framing", "role`with`backtick", "bad;DROP TABLE role", "execution"],
            });
            return { result, edges: yield* tags };
        }));

        expect(result.rolesSkipped).toBe(2);
        expect(result.edgesWritten).toBe(2);
        expect(edges).toHaveLength(2);
    });

    test("re-running is idempotent - two runs leave one edge per role", async () => {
        const edges = await overSidecar(Effect.gen(function* () {
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing"] });
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing"] });
            return yield* tags;
        }));

        expect(edges).toHaveLength(1);
    });

    test("role SHRINKAGE drops the edge the frontmatter no longer names", async () => {
        const edges = await overSidecar(Effect.gen(function* () {
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing", "execution"] });
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing"] });
            return yield* tags;
        }));

        expect(edges).toHaveLength(1);
        expect(edges[0]!.out_id).toBe(roleRowId("framing"));
    });

    test("empty roles sweeps every frontmatter edge and writes none", async () => {
        const { result, edges } = await overSidecar(Effect.gen(function* () {
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing", "execution"] });
            const result = yield* relateSkillRoles({ skillId: SKILL_ID, roles: [] });
            return { result, edges: yield* tags };
        }));

        expect(result).toEqual({ rolesUpserted: 0, edgesWritten: 0, rolesSkipped: 0 });
        expect(edges).toHaveLength(0);
    });

    test("the sweep leaves a USER tag on the same skill-role pair alone", async () => {
        // `source` is part of the natural key precisely so the two writers can
        // coexist. A sweep that dropped the user's row would silently erase a
        // decision the user made through `ax skills tag`.
        const edges = await overSidecar(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* judgment.put("plays_role", {
                id: "user-tag",
                in_id: SKILL_ID,
                out_id: roleRowId("framing"),
                source: "user",
                confidence: 0.9,
                weight: null,
                rationale: "chosen by hand",
            });
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing"] });
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: [] });
            return yield* tags;
        }));

        expect(edges).toHaveLength(1);
        expect(edges[0]!.source).toBe("user");
    });

    test("re-ingest does not reset a role's tuned weight", async () => {
        const roleRows = await overSidecar(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* judgment.put("role", { id: roleRowId("framing"), name: "framing", weight: 3.5 });
            yield* relateSkillRoles({ skillId: SKILL_ID, roles: ["framing"] });
            return yield* roles;
        }));

        expect(roleRows).toHaveLength(1);
        expect(roleRows[0]!.weight).toBe(3.5);
    });
});
