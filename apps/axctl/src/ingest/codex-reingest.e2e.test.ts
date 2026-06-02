/**
 * Live-DB regression test for idempotent codex re-ingest.
 *
 * Reproduces the crash observed running `ax ingest` a second time:
 *
 *   Database index agent_event_session_seq already contains
 *     [agent_session:…, 9], with record agent_event:…__call_…
 *
 * `agent_event` carries a UNIQUE index on (agent_session, seq). Record ids are
 * keyed on the stable provider_event_id, but `seq` can drift across ingests
 * (older/partial ingests or seq-derivation changes). On re-ingest a fresh event
 * gets assigned a `seq` already occupied by a *different* record id, and the
 * per-UPSERT UNIQUE check throws mid-batch.
 *
 * This test seeds the drifted state an older ingest leaves behind, then ingests
 * the codex batch. Before the fix the second/drifted ingest threw the
 * unique-index error; after the fix the per-session clear removes the stale row
 * first so the fresh batch inserts cleanly and converges to the fresh-ingest
 * end state.
 *
 * Gated on AX_E2E_DB=1. Requires a live SurrealDB (ws://127.0.0.1:8521 or
 * AX_DB_URL). Without that env var the suite skips trivially.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    __testBuildCodexBatchStatements,
    __testExtractCodexJsonlLines,
} from "./codex.ts";
import { agentEventRecordKey, agentSessionRecordKey } from "./provider-events.ts";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";
const TEST_TIMEOUT_MS = 30_000;

const SESSION_ID = "e2e_reingest_codex_session";
const PROVIDER = "codex" as const;

const transcriptLines = [
    JSON.stringify({
        type: "session_meta",
        timestamp: "2026-05-09T10:00:00.000Z",
        payload: {
            id: SESSION_ID,
            cwd: "/tmp/e2e-reingest",
            cli_version: "0.1.0",
            model_provider: "openai",
            timestamp: "2026-05-09T10:00:00.000Z",
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-09T10:00:01.000Z",
        payload: { type: "message", role: "user", content: "do a thing" },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-09T10:00:02.000Z",
        payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_e2e_reingest",
            arguments: JSON.stringify({ cmd: "git status --short" }),
        },
    }),
    JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-09T10:00:03.000Z",
        payload: {
            type: "function_call_output",
            call_id: "call_e2e_reingest",
            output: "ok",
        },
    }),
];

const sessionKey = agentSessionRecordKey(PROVIDER, SESSION_ID);

// The function_call event is keyed on the stable call_id and assigned the seq
// of its enclosing response_item (3rd response_item => seq 2).
const callEventKey = agentEventRecordKey({
    provider: PROVIDER,
    providerSessionId: SESSION_ID,
    providerEventId: "call_e2e_reingest",
    seq: 2,
});

const statements = (): string[] => {
    const extract = __testExtractCodexJsonlLines(transcriptLines);
    if (!extract) throw new Error("fixture produced no codex extract");
    return __testBuildCodexBatchStatements(extract, 1200);
};

const ingestOnce = (db: SurrealClientShape) =>
    Effect.forEach(statements(), (stmt) => db.query(stmt), { discard: true });

const cleanup = (db: SurrealClientShape) =>
    db.query(
        `DELETE agent_event_child WHERE agent_session = agent_session:\`${sessionKey}\`;
         DELETE agent_event WHERE agent_session = agent_session:\`${sessionKey}\`;
         DELETE agent_session:\`${sessionKey}\`;
         DELETE session:\`${SESSION_ID}\`;`,
    );

const seedDrift = (db: SurrealClientShape) =>
    db.query(`
        UPSERT agent_event:\`${sessionKey}__drifted_old_record\` CONTENT {
            agent_session: agent_session:\`${sessionKey}\`,
            provider: agent_provider:\`${PROVIDER}\`,
            provider_event_id: "stale_event_from_old_ingest",
            seq: 2,
            ts: d"2026-05-09T10:00:02.000Z",
            type: "function_call"
        };
    `);

const countSessionEvents = (db: SurrealClientShape) =>
    db
        .query<[{ count: number }[]]>(
            `SELECT count() AS count FROM agent_event WHERE agent_session = agent_session:\`${sessionKey}\` GROUP ALL;`,
        )
        .pipe(Effect.map((rows) => rows?.[0]?.[0]?.count ?? 0));

const exists = (db: SurrealClientShape, recordKey: string) =>
    db
        .query<[{ id: unknown }[]]>(`SELECT id FROM agent_event:\`${recordKey}\`;`)
        .pipe(Effect.map((rows) => (rows?.[0]?.length ?? 0) > 0));

const provide = <A>(eff: Effect.Effect<A, unknown, SurrealClient>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(AppLayer)) as Effect.Effect<A, unknown, never>);

describe(
    E2E_ENABLED
        ? "codex re-ingest (live DB)"
        : "codex re-ingest (live DB - skipped, set AX_E2E_DB=1)",
    () => {
        if (!E2E_ENABLED) {
            test.skip("guard", () => undefined);
            return;
        }

        beforeAll(async () => {
            await provide(Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* cleanup(db);
            }));
        });

        afterAll(async () => {
            await provide(Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* cleanup(db);
            }));
        });

        test(
            "plain re-ingest of the same batch is idempotent (no throw)",
            async () => {
                const result = await provide(Effect.gen(function* () {
                    const db = yield* SurrealClient;
                    yield* cleanup(db);
                    yield* ingestOnce(db);
                    const firstCount = yield* countSessionEvents(db);
                    // Identical second ingest: must not throw, count unchanged.
                    yield* ingestOnce(db);
                    const secondCount = yield* countSessionEvents(db);
                    const callPresent = yield* exists(db, callEventKey);
                    return { firstCount, secondCount, callPresent };
                }));
                expect(result.callPresent).toBe(true);
                expect(result.firstCount).toBeGreaterThan(0);
                expect(result.secondCount).toBe(result.firstCount);
            },
            TEST_TIMEOUT_MS,
        );

        test(
            "re-ingest with a drifted (session, seq) row does not throw and converges",
            async () => {
                const result = await provide(Effect.gen(function* () {
                    const db = yield* SurrealClient;
                    // Seed the drifted state an OLDER ingest leaves behind: a
                    // DIFFERENT record id already occupies (agent_session, seq=2)
                    // - the slot the fresh batch's call event will claim.
                    yield* cleanup(db);
                    yield* seedDrift(db);
                    const driftBefore = yield* exists(db, `${sessionKey}__drifted_old_record`);

                    // Before the fix this threw the unique-index error on
                    // (agent_session, seq=2). After the fix the per-session clear
                    // wipes the drift row first, so the batch inserts cleanly.
                    yield* ingestOnce(db);

                    const driftAfter = yield* exists(db, `${sessionKey}__drifted_old_record`);
                    const callPresent = yield* exists(db, callEventKey);
                    const driftedCount = yield* countSessionEvents(db);

                    // Canonical fresh-ingest count from a clean session.
                    yield* cleanup(db);
                    yield* ingestOnce(db);
                    const freshCount = yield* countSessionEvents(db);

                    return { driftBefore, driftAfter, callPresent, driftedCount, freshCount };
                }));
                expect(result.driftBefore).toBe(true);
                // Drift row removed by the per-session clear.
                expect(result.driftAfter).toBe(false);
                expect(result.callPresent).toBe(true);
                // End state equals a fresh ingest.
                expect(result.driftedCount).toBe(result.freshCount);
            },
            TEST_TIMEOUT_MS,
        );
    },
);
