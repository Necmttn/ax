/**
 * E2E migration test for issue #472: `proposal.origin` NONE-coercion crash.
 *
 * Reproduces the production failure against a live SurrealDB, then proves the
 * shipped fix heals it. Unlike the parse-level assertions in
 * `packages/schema/src/schema.test.ts` (which only pin the DDL text), this
 * exercises the actual runtime coercion path that crashed ingest.
 *
 * Story:
 *   1. Simulate a pre-fix DB: redefine `origin` permissively (option<string>)
 *      and seed a proposal row whose `origin` is NONE (an "old row" written
 *      before the field existed) plus one with an explicit origin='agent'.
 *   2. Prove the bug: after tightening to the bare `TYPE string` (no VALUE),
 *      a `UPDATE proposal SET ...` that omits `origin` re-coerces the stored
 *      NONE and fails.
 *   3. Apply the shipped fix (OVERWRITE + IS-NONE VALUE clause + repair UPDATE).
 *   4. Assert: NONE row repaired to 'mined'; a bare update now succeeds;
 *      origin='agent' is preserved; an explicit NULL write still fails coercion.
 *
 * Gated on `AX_E2E_DB=1` (needs a live SurrealDB at 127.0.0.1:8521 / AX_DB_URL).
 * The test restores the canonical field definition in afterAll so it never
 * leaves the shared schema in the permissive intermediate state.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { SurrealClient } from "@ax/lib/db";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";

// The canonical shipped definitions (kept in sync with packages/schema/src/schema.surql).
const CANONICAL_FIELD =
    "DEFINE FIELD OVERWRITE origin ON proposal TYPE string DEFAULT 'mined' VALUE IF $value IS NONE THEN 'mined' ELSE $value END;";
const REPAIR_UPDATE = "UPDATE proposal SET origin = 'mined' WHERE origin = NONE;";

const PERMISSIVE_FIELD = "DEFINE FIELD OVERWRITE origin ON proposal TYPE option<string>;";
const STRICT_NO_VALUE = "DEFINE FIELD OVERWRITE origin ON proposal TYPE string DEFAULT 'mined';";

const NONE_ID = "proposal:__mig472_none";
const AGENT_ID = "proposal:__mig472_agent";

const run = <A, E>(eff: Effect.Effect<A, E, SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(AppLayer)) as Effect.Effect<A, E, never>);

const cleanup = () =>
    run(
        Effect.gen(function* () {
            const db = yield* SurrealClient;
            yield* db.query(`DELETE ${NONE_ID}; DELETE ${AGENT_ID};`).pipe(Effect.catch(() => Effect.void));
            // Always leave the field in its canonical shipped state.
            yield* db.query(CANONICAL_FIELD).pipe(Effect.catch(() => Effect.void));
        }),
    ).catch(() => {/* ignore */});

describe("proposal.origin NONE-coercion migration (#472)", () => {
    let dbReachable = false;

    beforeAll(async () => {
        if (!E2E_ENABLED) return;
        try {
            await run(
                Effect.gen(function* () {
                    const db = yield* SurrealClient;
                    yield* db.query("RETURN 1;");
                }),
            );
            dbReachable = true;
        } catch (err) {
            console.warn(
                `(origin-migration E2E) SurrealDB unreachable - skipping. ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });

    afterAll(async () => {
        if (!E2E_ENABLED || !dbReachable) return;
        await cleanup();
    });

    test("repairs NONE rows, preserves agent, keeps NULL writes failing", async () => {
        if (!E2E_ENABLED || !dbReachable) {
            console.log("(skipped - set AX_E2E_DB=1 with a live SurrealDB to run)");
            expect(true).toBe(true);
            return;
        }

        // 1. Pre-fix DB: permissive field + an old NONE row + an agent row.
        await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(`
                    ${PERMISSIVE_FIELD}
                    DELETE ${NONE_ID}; DELETE ${AGENT_ID};
                    UPSERT ${NONE_ID} CONTENT { form:'skill', title:'t', hypothesis:'h', dedupe_sig:'mig472none', confidence:'low' };
                    UPSERT ${AGENT_ID} CONTENT { form:'skill', title:'t', hypothesis:'h', dedupe_sig:'mig472agent', confidence:'low', origin:'agent' };
                `);
            }),
        );

        // 2. Reproduce the bug: tighten to bare TYPE string (no VALUE), then a
        //    bare UPDATE that omits `origin` re-coerces the stored NONE and fails.
        const reproErr = await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(STRICT_NO_VALUE);
                yield* db.query(`UPDATE ${NONE_ID} SET hypothesis = 'h2';`);
            }),
        ).then(() => null).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

        expect(reproErr).not.toBeNull();
        expect(reproErr).toContain("origin");
        expect(reproErr).toContain("NONE");

        // 3. Apply the shipped fix (field redefinition + repair backfill).
        await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(`${CANONICAL_FIELD} ${REPAIR_UPDATE}`);
            }),
        );

        // 4a. The old NONE row is repaired to 'mined' and a bare update succeeds.
        const noneOrigin = await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(`UPDATE ${NONE_ID} SET hypothesis = 'h3';`);
                const r = yield* db.query<[string[]]>(`SELECT VALUE origin FROM ${NONE_ID};`);
                return r?.[0]?.[0] ?? null;
            }),
        );
        expect(noneOrigin).toBe("mined");

        // 4b. An explicit origin='agent' survives a bare update untouched.
        const agentOrigin = await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(`UPDATE ${AGENT_ID} SET hypothesis = 'h3';`);
                const r = yield* db.query<[string[]]>(`SELECT VALUE origin FROM ${AGENT_ID};`);
                return r?.[0]?.[0] ?? null;
            }),
        );
        expect(agentOrigin).toBe("agent");

        // 4c. An explicit NULL write still fails coercion (not silently relabeled).
        const nullErr = await run(
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query(`UPDATE ${NONE_ID} SET origin = NULL;`);
            }),
        ).then(() => null).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        expect(nullErr).not.toBeNull();
        expect(nullErr).toContain("NULL");
    });
});
