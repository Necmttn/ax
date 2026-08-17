/**
 * `graph-health` is a DEFECT LIST: a healthy graph returns zero rows. That
 * makes it the one view a text assertion cannot honestly cover - "the SQL
 * contains GROUP BY repository, path" stays true right up until the statement
 * stops running at all, and an empty result reads identically whether the
 * scan found nothing or the statement never executed.
 *
 * So this seeds a fixture snapshot with ONE of each defect the six scans look
 * for and asserts each is found. The remaining text assertions pin only the
 * two facts a query result cannot show (the composed statement's shape, and
 * the tables the provider-integrity scan reads - which
 * `ingest/provider-parity.ts` also asserts against this file by name).
 */
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { graphHealthSql, providerEventIntegritySql } from "./graph-health.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("graph health", {
    requireFts: true,
});

const HealthRow = Schema.Struct({
    check: Schema.String,
    subject: Schema.String,
    row_count: Schema.Number,
    ids: Schema.String,
});

const ts = (iso: string) => new Date(iso);
const AT = ts("2026-08-16T00:00:00.000Z");

describe("graph health SQL", () => {
    dtest("every scan finds the defect it looks for", async () => {
        const dir = tempDir("graph-health");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // 1. duplicate_file_identity - two `file` rows, one identity.
                    yield* write.put("file", { id: "file:a", repository: "repo:ax", path: "src/x.ts" });
                    yield* write.put("file", { id: "file:b", repository: "repo:ax", path: "src/x.ts" });

                    // 2. repository_sibling - two repos sharing an identity key.
                    yield* write.put("repository", {
                        id: "repo:ax",
                        name: "ax",
                        remote_url: "git@github.com:Necmttn/ax.git",
                        initial_commit: "abc123",
                    });
                    yield* write.put("repository", {
                        id: "repo:ax-clone",
                        name: "ax-clone",
                        remote_url: "git@github.com:Necmttn/ax.git",
                        initial_commit: "abc123",
                    });

                    // 3. missing_produced_scope - a `produced` edge with no checkout.
                    yield* write.put("produced", {
                        id: "produced:scopeless",
                        in_id: "session:1",
                        out_id: "commit:1",
                        repository: "repo:ax",
                        ts: AT,
                    });

                    // 4. legacy_skill_collision - two names that collapse onto one
                    //    legacy record key once `:` is encoded as `__`.
                    yield* write.put("skill", {
                        id: "skill:one",
                        name: "plugin:tdd",
                        scope: "user",
                        dir_path: "/skills/one",
                        content_hash: "h1",
                    });
                    yield* write.put("skill", {
                        id: "skill:two",
                        name: "plugin__tdd",
                        scope: "user",
                        dir_path: "/skills/two",
                        content_hash: "h2",
                    });

                    // 5. duplicate_relation_edges - two `invoked` edges, same key.
                    yield* write.put("invoked", {
                        id: "invoked:1",
                        in_id: "turn:1",
                        out_id: "skill:one",
                        args: "{}",
                        ts: AT,
                    });
                    yield* write.put("invoked", {
                        id: "invoked:2",
                        in_id: "turn:1",
                        out_id: "skill:one",
                        args: "{}",
                        ts: AT,
                    });

                    // 6. provider_event_integrity - a provider nothing links to.
                    yield* write.put("agent_provider", {
                        id: "agent_provider:orphan",
                        name: "orphan",
                        display_name: "Orphan",
                    });
                }),
            ),
        );

        const rows = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* read.rows(HealthRow, graphHealthSql(10), []);
            }).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath))) as Effect.Effect<
                ReadonlyArray<typeof HealthRow.Type>
            >,
        );

        const byCheck = (name: string) => rows.filter((r) => r.check === name);

        expect(byCheck("duplicate_file_identity")).toHaveLength(1);
        expect(byCheck("duplicate_file_identity")[0]).toMatchObject({
            subject: "repo:ax :: src/x.ts",
            row_count: 2,
        });
        // `ids` is JSON-in-VARCHAR, not a native LIST - the bun:ffi client
        // cannot decode a LIST column, so callers parse it.
        expect(JSON.parse(byCheck("duplicate_file_identity")[0]!.ids).sort()).toEqual(["file:a", "file:b"]);

        expect(byCheck("repository_sibling")).toHaveLength(1);
        expect(byCheck("repository_sibling")[0]!.row_count).toBe(2);

        expect(byCheck("missing_produced_scope")).toHaveLength(1);
        expect(byCheck("missing_produced_scope")[0]!.subject).toBe("session:1 -> commit:1");

        expect(byCheck("legacy_skill_collision")).toHaveLength(1);
        expect(byCheck("legacy_skill_collision")[0]!.subject).toBe("plugin__tdd");

        const relations = byCheck("duplicate_relation_edges");
        expect(relations).toHaveLength(1);
        expect(relations[0]!.subject.startsWith("invoked: ")).toBe(true);
        expect(relations[0]!.row_count).toBe(2);

        const provider = byCheck("provider_event_integrity");
        expect(provider.map((r) => r.subject)).toContain("providers_without_sessions: orphan");
    });

    dtest("a clean graph is an EMPTY result, not a zero-count report card", async () => {
        const dir = tempDir("graph-health-clean");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("file", { id: "file:only", repository: "repo:ax", path: "src/x.ts" });
                    yield* write.put("repository", { id: "repo:ax", name: "ax" });
                }),
            ),
        );
        const rows = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* read.rows(HealthRow, graphHealthSql(10), []);
            }).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath))) as Effect.Effect<
                ReadonlyArray<typeof HealthRow.Type>
            >,
        );
        expect(rows).toEqual([]);
    });

    test("the six scans compose into ONE statement with no inner terminators", () => {
        const sql = graphHealthSql(10);
        // A stray `;` inside a UNION arm would end the statement early and the
        // rest would parse as a second, unrun statement.
        expect(sql.slice(0, -1)).not.toContain(";");
        expect(sql.endsWith(";")).toBe(true);
        for (
            const check of [
                "duplicate_file_identity",
                "repository_sibling",
                "missing_produced_scope",
                "legacy_skill_collision",
                "duplicate_relation_edges",
                "provider_event_integrity",
            ]
        ) {
            expect(sql).toContain(`'${check}' AS check`);
        }
    });

    test("providerEventIntegritySql reads the three provider-native tables", () => {
        // `ingest/provider-parity.ts` asserts these same two strings against
        // this file by path - keep them literal.
        const sql = providerEventIntegritySql(10);
        expect(sql).toContain("FROM agent_event");
        expect(sql).toContain("FROM agent_session");
        expect(sql).toContain("FROM agent_provider");
    });
});
