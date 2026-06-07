/**
 * repair-agent-event-index: reconcile the `agent_event_session_seq` UNIQUE index
 * with the actual `agent_event` rows.
 *
 * Why this exists
 * ---------------
 * `agent_event` carries `DEFINE INDEX agent_event_session_seq ... (agent_session,
 * seq) UNIQUE`. A long-lived DB (observed across a SurrealDB version change and
 * prior partial ingests) can drift into an inconsistent state where the table
 * holds DUPLICATE `(agent_session, seq)` rows the index let in, AND a bare
 * `DELETE agent_event WHERE agent_session = ...` - which the planner routes
 * through that index - silently skips the drifted rows. Their ghost index
 * entries still block a fresh `(agent_session, seq)` INSERT, so the next ingest
 * crashes:
 *
 *   Database index `agent_event_session_seq` already contains
 *     [agent_session:<id>, <seq>], with record `agent_event:<id>__...`
 *
 * The ingest-time fix (see `buildAgentSessionEventClearStatements` in
 * apps/axctl/src/ingest/provider-events.ts) deletes by PRIMARY id so it can't be
 * defeated by index drift, and self-heals a session on its next re-ingest. This
 * script is the GLOBAL one-shot repair for a DB that is already corrupt: it
 * dedupes every affected session by primary id, then rebuilds the index clean.
 *
 * Usage
 * -----
 *   bun scripts/repair-agent-event-index.ts            # apply the repair
 *   bun scripts/repair-agent-event-index.ts --dry-run  # report only, no writes
 *
 * Safe to re-run: a clean DB reports 0 duplicates and rebuilds the index as a
 * no-op. `agent_event` is derived data (transcripts are the source of truth), so
 * a repaired session fully reconstructs on its next ingest.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";

const INDEX_NAME = "agent_event_session_seq";
const DRY_RUN = process.argv.includes("--dry-run");

interface DupGroup {
    readonly agent_session: string;
    readonly seq: number;
    readonly c: number;
}

/** Excess record ids to delete for one session: keep the first row at each seq,
 *  drop the rest. Pure so it can be reasoned about / unit-tested in isolation. */
export const planSessionDedup = (
    rows: ReadonlyArray<{ readonly id: string; readonly seq: number }>,
): string[] => {
    const seen = new Set<number>();
    const drop: string[] = [];
    for (const row of rows) {
        if (seen.has(row.seq)) drop.push(row.id);
        else seen.add(row.seq);
    }
    return drop;
};

const repair = Effect.gen(function* () {
    const db = yield* SurrealClient;

    // 1) Enumerate duplicate (agent_session, seq) groups via a full-table GROUP
    //    BY (index-independent), then collapse to the affected sessions.
    const groups = yield* db
        .query<[DupGroup[]]>(
            `SELECT agent_session, seq, count() AS c FROM agent_event GROUP BY agent_session, seq;`,
        )
        .pipe(Effect.map((r) => (r?.[0] ?? []).filter((g) => g.c > 1)));
    const sessions = [...new Set(groups.map((g) => String(g.agent_session)))];
    const excess = groups.reduce((n, g) => n + (g.c - 1), 0);

    console.log(`[repair] duplicate (agent_session, seq) groups: ${groups.length}`);
    console.log(`[repair] affected sessions: ${sessions.length}`);
    console.log(`[repair] excess rows to remove: ${excess}`);

    if (DRY_RUN) {
        console.log("[repair] --dry-run: no writes performed");
        return;
    }

    if (groups.length === 0) {
        // Still rebuild the index to drop any ghost entries that have no
        // surviving duplicate row to flag them.
        yield* db.query(`REMOVE INDEX IF EXISTS ${INDEX_NAME} ON agent_event;`);
        yield* db.query(
            `DEFINE INDEX ${INDEX_NAME} ON agent_event FIELDS agent_session, seq UNIQUE;`,
        );
        console.log("[repair] no duplicates; index rebuilt clean");
        return;
    }

    // 2) Drop the corrupt index so deletes scan the table and nothing blocks.
    yield* db.query(`REMOVE INDEX IF EXISTS ${INDEX_NAME} ON agent_event;`);
    console.log("[repair] index removed");

    // 3) Dedupe each affected session: delete excess rows by PRIMARY id (never
    //    the corruptible secondary index), batched to stay under parser limits.
    let removed = 0;
    for (const sess of sessions) {
        const sk = sess.replace(/^agent_session:/, "").replace(/^`|`$/g, "");
        const rows = yield* db
            .query<[Array<{ id: string; seq: number }>]>(
                `SELECT id, seq FROM agent_event WHERE agent_session = agent_session:\`${sk}\`;`,
            )
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const drop = planSessionDedup(rows.map((row) => ({ id: String(row.id), seq: row.seq })));
        for (let i = 0; i < drop.length; i += 200) {
            const batch = drop.slice(i, i + 200);
            yield* db.query(batch.map((id) => `DELETE ${id};`).join(""));
        }
        removed += drop.length;
    }
    console.log(`[repair] excess rows removed: ${removed}`);

    // 4) Verify no duplicates survive before re-asserting UNIQUE.
    const after = yield* db
        .query<[DupGroup[]]>(
            `SELECT agent_session, seq, count() AS c FROM agent_event GROUP BY agent_session, seq;`,
        )
        .pipe(Effect.map((r) => (r?.[0] ?? []).filter((g) => g.c > 1)));
    if (after.length > 0) {
        console.error(`[repair] ABORT: ${after.length} duplicate groups remain; index NOT rebuilt`);
        return;
    }

    // 5) Rebuild the UNIQUE index against the now-clean table.
    yield* db.query(
        `DEFINE INDEX ${INDEX_NAME} ON agent_event FIELDS agent_session, seq UNIQUE;`,
    );
    console.log("[repair] index rebuilt UNIQUE - done");
});

// Only run the repair when invoked directly (`bun scripts/repair-...ts`), so
// importing `planSessionDedup` for tests never touches the live DB.
if (import.meta.main) {
    await Effect.runPromise(
        repair.pipe(Effect.provide(AppLayer)) as Effect.Effect<void, unknown, never>,
    );
}
