import { Effect, Layer } from "effect";
import { SurrealClient, SurrealClientLive } from "/Users/necmttn/Projects/ax/src/lib/db.ts";
import { AgentctlConfigLive } from "/Users/necmttn/Projects/ax/src/lib/config.ts";

const FID = "file:repository__a648b00f869de2d5__Users_necmttn_Projects_quera_claude_worktrees_knowledge_tab_routing_app_src_routes_authed_orgSlug_knowledge_route_tsx__a59a58237a20d160";

const main = Effect.gen(function* () {
    const db = yield* SurrealClient;

    const t = (label: string, q: string) =>
        Effect.gen(function* () {
            const t0 = performance.now();
            const result = yield* db.query<[unknown[]]>(q);
            const dt = Math.round(performance.now() - t0);
            console.log(`${dt}ms  rows=${(result[0] as unknown[]).length}  ${label}`);
        });

    yield* t("inner aggregation", `
        SELECT in.session AS session, count() AS weight, time::max(ts) AS last_seen
        FROM edited
        WHERE out = ${FID} AND in.session.source != "claude-subagent"
        GROUP BY session;
    `);

    yield* t("full loadPriorFileSessions (LIMIT 5)", `
        SELECT
            <string>session AS session,
            ( (SELECT text_excerpt, seq FROM turn WHERE session = $parent.session AND role = "user" AND message_kind = "task" AND intent_kind IN ["organic_task", "preference", "correction"] AND text_excerpt IS NOT NONE ORDER BY seq ASC LIMIT 1)[0].text_excerpt ?? session.project ?? <string>session ) AS title,
            session.project AS project,
            file.path AS file,
            weight,
            last_seen,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user")) AS user_turns,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "assistant")) AS assistant_turns,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user" AND intent_kind = "correction")) AS corrections,
            ((SELECT interruptions FROM session_health WHERE session = $parent.session LIMIT 1)[0].interruptions ?? 0) AS interruptions,
            ((SELECT math::sum(duration_ms) AS total, session FROM phase_span WHERE session = $parent.session AND user_turns = 0 GROUP BY session)[0].total ?? NONE) AS hands_free_ms,
            array::len((SELECT id FROM produced WHERE in = $parent.session)) AS produced_commits,
            ((SELECT status FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].status ?? NONE) AS delivery_status,
            ((SELECT review_pain FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].review_pain ?? NONE) AS review_pain
        FROM (
            SELECT in.session AS session, out AS file, count() AS weight, time::max(ts) AS last_seen
            FROM edited
            WHERE out IN [${FID}] AND in.session.source != "claude-subagent"
            GROUP BY session, file
        )
        ORDER BY weight DESC, last_seen DESC
        LIMIT 5;
    `);

    yield* t("trimmed: drop title + phase_span + assistant_turns + interruptions", `
        SELECT
            <string>session AS session,
            session.project AS project,
            file.path AS file,
            weight,
            last_seen,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user")) AS user_turns,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user" AND intent_kind = "correction")) AS corrections,
            array::len((SELECT id FROM produced WHERE in = $parent.session)) AS produced_commits,
            ((SELECT status FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].status ?? NONE) AS delivery_status,
            ((SELECT review_pain FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].review_pain ?? NONE) AS review_pain
        FROM (
            SELECT in.session AS session, out AS file, count() AS weight, time::max(ts) AS last_seen
            FROM edited
            WHERE out IN [${FID}] AND in.session.source != "claude-subagent"
            GROUP BY session, file
        )
        ORDER BY weight DESC, last_seen DESC
        LIMIT 5;
    `);

    yield* t("bare: only weight + session + decision-relevant", `
        SELECT
            <string>session AS session,
            weight,
            last_seen,
            array::len((SELECT id FROM turn WHERE session = $parent.session AND role = "user" AND intent_kind = "correction")) AS corrections,
            array::len((SELECT id FROM produced WHERE in = $parent.session)) AS produced_commits,
            ((SELECT status FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].status ?? NONE) AS delivery_status,
            ((SELECT review_pain FROM delivery_outcome WHERE session = $parent.session LIMIT 1)[0].review_pain ?? NONE) AS review_pain
        FROM (
            SELECT in.session AS session, count() AS weight, time::max(ts) AS last_seen
            FROM edited
            WHERE out IN [${FID}] AND in.session.source != "claude-subagent"
            GROUP BY session
        )
        ORDER BY weight DESC, last_seen DESC
        LIMIT 5;
    `);

    yield* t("ultra-bare: just the inner aggregation, no per-row subqueries", `
        SELECT in.session AS session, count() AS weight, time::max(ts) AS last_seen
        FROM edited
        WHERE out = ${FID} AND in.session.source != "claude-subagent"
        GROUP BY session
        ORDER BY weight DESC, last_seen DESC
        LIMIT 5;
    `);
});

const AppLayer = SurrealClientLive.pipe(Layer.provide(AgentctlConfigLive));
await Effect.runPromise(main.pipe(Effect.provide(AppLayer), Effect.scoped));

const main2 = Effect.gen(function* () {
    const db = yield* SurrealClient;
    const t0 = performance.now();
    const [sessions] = yield* db.query<[Array<{session:string, weight:number, last_seen:string}>]>(`
        SELECT <string>in.session AS session, count() AS weight, time::max(ts) AS last_seen
        FROM edited WHERE out = ${FID} AND in.session.source != "claude-subagent"
        GROUP BY session ORDER BY weight DESC, last_seen DESC LIMIT 5;
    `);
    const t1 = performance.now();
    console.log(`${Math.round(t1-t0)}ms  sessions inner = ${sessions.length}`);
    if (sessions.length === 0) return;
    const sids = sessions.map(s => s.session).join(", ");
    const [a, b, c, d] = yield* Effect.all([
        db.query<[Array<{session:string, role:string, intent_kind:string|null}>]>(`SELECT <string>session AS session, role, intent_kind FROM turn WHERE session IN [${sids}] AND role IN ['user','assistant'];`),
        db.query<[Array<{in:string}>]>(`SELECT <string>in AS in FROM produced WHERE in IN [${sids}];`),
        db.query<[Array<{session:string,status:string|null,review_pain:string|null}>]>(`SELECT <string>session AS session, status, review_pain FROM delivery_outcome WHERE session IN [${sids}];`),
        db.query<[Array<{session:string,interruptions:number}>]>(`SELECT <string>session AS session, interruptions FROM session_health WHERE session IN [${sids}];`),
    ]);
    const t2 = performance.now();
    console.log(`${Math.round(t2-t1)}ms  4 batched queries (turns: ${a[0].length}, produced: ${b[0].length}, delivery: ${c[0].length}, health: ${d[0].length})`);
    console.log(`${Math.round(t2-t0)}ms  TOTAL two-stage`);
});

await Effect.runPromise(main2.pipe(Effect.provide(AppLayer), Effect.scoped));
