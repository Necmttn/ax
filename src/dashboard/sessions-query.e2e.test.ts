/**
 * Live-DB regression test for the repository scope filter (R1).
 *
 * The class of bug R1 fixed - binding `String(repositoryRecordId)` against a
 * `record<repository>`-typed field silently returns 0 rows - is invisible to
 * mock-level tests (mocks assert SQL shape, not equality semantics). This
 * E2E seeds a repository + session row, calls `listSessionsHere`, and asserts
 * the row comes back. Catches a regression that the unit tests cannot.
 *
 * Gated on `AX_E2E_DB=1`. Without that env var the suite skips trivially.
 * Requires a live SurrealDB at ws://127.0.0.1:8521 (or AX_DB_URL override).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { listSessionsHere } from "./sessions-query.ts";
import { AppLayer } from "../lib/layers.ts";
import { SurrealClient } from "../lib/db.ts";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";

const REPO_KEY = "e2e_scope_test";
const SESSION_KEY = "e2e_scope_test_session_1";

const seed = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Future-dated start_at so a default 14-day window catches it from
        // whenever the test is run; CI clock-skew safe.
        const ts = new Date().toISOString();
        yield* db.query(`
            UPSERT repository:\`${REPO_KEY}\` MERGE {
                name: 'e2e-scope-test',
                remote_url: 'https://example.invalid/e2e/scope-test',
                initial_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            };
            UPSERT session:\`${SESSION_KEY}\` MERGE {
                project: '-e2e-scope-test',
                source: 'claude',
                started_at: d'${ts}',
                ended_at: d'${ts}',
                repository: repository:\`${REPO_KEY}\`
            };
        `);
    });

const cleanup = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* db.query(
            `DELETE session:\`${SESSION_KEY}\`; DELETE repository:\`${REPO_KEY}\`;`,
        );
    });

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(AppLayer)) as Effect.Effect<A, unknown, never>);

describe(E2E_ENABLED ? "sessions-query (live DB)" : "sessions-query (live DB - skipped, set AX_E2E_DB=1)", () => {
    if (!E2E_ENABLED) {
        test.skip("guard", () => undefined);
        return;
    }

    beforeAll(async () => {
        await run(seed());
    });

    afterAll(async () => {
        await run(cleanup());
    });

    test("listSessionsHere returns the seeded session via record-literal match (R1 regression)", async () => {
        const rows = await run(listSessionsHere({ repositoryKey: REPO_KEY, days: 7 }));
        // Must include the seeded session. Other sessions linked to this repo
        // could exist in dev DBs; assert presence, not exact length.
        const ids = rows.map((r) => String(r.id));
        const hit = ids.some((id) => id.includes(SESSION_KEY));
        expect(hit).toBe(true);
    });

    test("listSessionsHere returns empty for a repositoryKey with no sessions", async () => {
        const rows = await run(
            listSessionsHere({
                repositoryKey: "e2e_nonexistent_repo_key_zzz",
                days: 7,
            }),
        );
        expect(rows).toEqual([]);
    });
});
