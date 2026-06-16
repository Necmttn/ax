/**
 * E2E migration test for issue #472: `proposal.origin` NONE-coercion crash.
 *
 * Reproduces the production failure against a live SurrealDB, then proves the
 * shipped fix heals it. Unlike the parse-level assertions in
 * `packages/schema/src/schema.test.ts` (which only pin the DDL text), this
 * exercises the actual runtime coercion path that crashed ingest.
 *
 * Isolation (critical): the WHOLE scenario runs in a SINGLE `SurrealClient`
 * acquisition inside one Effect, so the `use()` that selects a throwaway db
 * (`ax/<unique>`) holds for every statement. `Effect.ensuring` switches the
 * connection back to `main` and drops the throwaway db even on failure or
 * interrupt. ax/main is NEVER written, so a mid-test crash cannot strand the
 * user's real db in the broken #472 schema state.
 *
 * (Each `Effect.runPromise(provide(AppLayer))` gets its own connection, so the
 *  `use()` MUST live in the same run as the work - a per-call `use()` would not
 *  persist, and writes would leak to main. Hence the single-run shape.)
 *
 * Story:
 *   1. In the throwaway db, define `proposal` permissively (option<string>
 *      origin) and seed an old NONE row + an explicit origin='agent' row.
 *   2. Reproduce the bug in two independently-checked steps:
 *        a. tightening to a bare `TYPE string` (no VALUE) SUCCEEDS, then
 *        b. a bare `UPDATE proposal SET ...` that omits `origin` FAILS,
 *           re-coercing the stored NONE (the exact ingest crash).
 *   3. Apply the shipped fix (OVERWRITE + IS-NONE VALUE clause + repair UPDATE).
 *   4. NONE row repaired to 'mined'; a bare update succeeds; origin='agent'
 *      preserved; an explicit NULL write still fails coercion.
 *
 * Gated on `AX_E2E_DB=1` (needs a live SurrealDB at 127.0.0.1:8521 / AX_DB_URL).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";

// The canonical shipped definitions (kept in sync with packages/schema/src/schema.surql,
// which the parse-level tests pin verbatim).
const CANONICAL_FIELD =
    "DEFINE FIELD OVERWRITE origin ON proposal TYPE string DEFAULT 'mined' VALUE IF $value IS NONE THEN 'mined' ELSE $value END;";
const REPAIR_UPDATE = "UPDATE proposal SET origin = 'mined' WHERE origin = NONE;";

// Minimal proposal table for the throwaway db: just the fields this scenario writes.
const SEED_SCHEMA = `
    DEFINE TABLE proposal SCHEMAFULL;
    DEFINE FIELD form       ON proposal TYPE string;
    DEFINE FIELD title      ON proposal TYPE string;
    DEFINE FIELD hypothesis ON proposal TYPE string;
    DEFINE FIELD dedupe_sig ON proposal TYPE string;
    DEFINE FIELD confidence ON proposal TYPE string;
    DEFINE FIELD origin     ON proposal TYPE option<string>;
`;
const STRICT_NO_VALUE = "DEFINE FIELD OVERWRITE origin ON proposal TYPE string DEFAULT 'mined';";

const NONE_ID = "proposal:none_row";
const AGENT_ID = "proposal:agent_row";
const TMP_DB = `mig472_${Date.now().toString(36)}`;

const run = <A, E>(eff: Effect.Effect<A, E, SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(AppLayer)) as Effect.Effect<A, E, never>);

interface Results {
    readonly reproErr: string | null;
    readonly noneOrigin: string | null;
    readonly agentOrigin: string | null;
    readonly nullErr: string | null;
}

describe("proposal.origin NONE-coercion migration (#472)", () => {
    let dbReachable = false;

    beforeAll(async () => {
        if (!E2E_ENABLED) return;
        try {
            await run(Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query("RETURN 1;");
            }));
            dbReachable = true;
        } catch (err) {
            console.warn(
                `(origin-migration E2E) SurrealDB unreachable - skipping. ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });

    test("repairs NONE rows, preserves agent, keeps NULL writes failing", async () => {
        if (!E2E_ENABLED || !dbReachable) {
            console.log("(skipped - set AX_E2E_DB=1 with a live SurrealDB to run)");
            expect(true).toBe(true);
            return;
        }

        const results = await run(Effect.gen(function* () {
            const db = yield* SurrealClient;

            // Success -> null; DbError -> its message. Lets us assert that an
            // intermediate query failed without aborting the scenario.
            const captureErr = (sql: string) =>
                db.query(sql).pipe(
                    Effect.as<string | null>(null),
                    Effect.catch((e) => Effect.succeed(e instanceof DbError ? e.message : String(e))),
                );

            const scenario = Effect.gen(function* () {
                // Select the throwaway db; every statement below targets it.
                yield* Effect.promise(() => db.raw.use({ namespace: "ax", database: TMP_DB }));

                // 1. Permissive table + an old NONE row + an agent row.
                yield* db.query(`
                    ${SEED_SCHEMA}
                    UPSERT ${NONE_ID} CONTENT { form:'skill', title:'t', hypothesis:'h', dedupe_sig:'none', confidence:'low' };
                    UPSERT ${AGENT_ID} CONTENT { form:'skill', title:'t', hypothesis:'h', dedupe_sig:'agent', confidence:'low', origin:'agent' };
                `);

                // 2a. Tightening to a bare TYPE string must succeed on its own
                //     (so 2b's failure is proven to be the UPDATE, not this DDL).
                yield* db.query(STRICT_NO_VALUE);
                // 2b. The bug: a bare UPDATE omitting `origin` re-coerces the NONE.
                const reproErr = yield* captureErr(`UPDATE ${NONE_ID} SET hypothesis = 'h2';`);

                // 3. Apply the shipped fix.
                yield* db.query(`${CANONICAL_FIELD} ${REPAIR_UPDATE}`);

                // 4a. NONE row repaired + bare update now succeeds.
                yield* db.query(`UPDATE ${NONE_ID} SET hypothesis = 'h3';`);
                const noneRows = yield* db.query<[string[]]>(`SELECT VALUE origin FROM ${NONE_ID};`);
                // 4b. agent preserved through a bare update.
                yield* db.query(`UPDATE ${AGENT_ID} SET hypothesis = 'h3';`);
                const agentRows = yield* db.query<[string[]]>(`SELECT VALUE origin FROM ${AGENT_ID};`);
                // 4c. explicit NULL still fails coercion.
                const nullErr = yield* captureErr(`UPDATE ${NONE_ID} SET origin = NULL;`);

                return {
                    reproErr,
                    noneOrigin: noneRows?.[0]?.[0] ?? null,
                    agentOrigin: agentRows?.[0]?.[0] ?? null,
                    nullErr,
                } satisfies Results;
            });

            // Fail-closed cleanup on the SAME connection: back to main, drop temp.
            // ax/main was never written, so this is the only state to undo.
            const cleanup = Effect.gen(function* () {
                yield* Effect.promise(() => db.raw.use({ namespace: "ax", database: "main" }));
                yield* db.query(`REMOVE DATABASE ${TMP_DB};`).pipe(Effect.ignore);
            });
            return yield* scenario.pipe(Effect.ensuring(cleanup));
        }));

        // 2b: the bare update reproduced the coercion crash.
        expect(results.reproErr).not.toBeNull();
        expect(results.reproErr).toContain("origin");
        expect(results.reproErr).toContain("NONE");
        // 4a/4b: repaired to 'mined'; agent preserved.
        expect(results.noneOrigin).toBe("mined");
        expect(results.agentOrigin).toBe("agent");
        // 4c: explicit NULL still rejected.
        expect(results.nullErr).not.toBeNull();
        expect(results.nullErr).toContain("NULL");
    });
});
