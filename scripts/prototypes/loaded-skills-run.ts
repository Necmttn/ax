/**
 * One-off: apply the `loaded` table DEFINEs (the running DB predates them),
 * run the loaded-skills derive stage against current data, and report.
 *
 *   bun scripts/prototypes/loaded-skills-run.ts
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { deriveLoadedSkills } from "../../apps/axctl/src/ingest/derive-loaded-skills.ts";

const DEFINES = `
DEFINE TABLE IF NOT EXISTS loaded TYPE RELATION FROM session TO skill;
DEFINE FIELD IF NOT EXISTS ts     ON loaded TYPE datetime;
DEFINE FIELD IF NOT EXISTS agent  ON loaded TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source ON loaded TYPE string DEFAULT 'frontmatter';
DEFINE INDEX IF NOT EXISTS loaded_out ON loaded FIELDS out;
DEFINE INDEX IF NOT EXISTS loaded_in  ON loaded FIELDS in;
`;

const p = Effect.gen(function* () {
    const db = yield* SurrealClient;
    yield* db.query(DEFINES);
    const stats = yield* deriveLoadedSkills();
    console.log(`stage: wrote ${stats.written} loaded edges from ${stats.agents} skill-scoped agents`);

    const [byAgent] = yield* db.query<[Array<Record<string, unknown>>]>(
        `SELECT agent, count() AS n FROM loaded GROUP BY agent ORDER BY n DESC LIMIT 12;`,
    );
    console.log("\nloaded edges by agent:");
    for (const r of byAgent ?? []) console.log(`  ${String(r.agent).padEnd(28)} ${r.n}`);

    const [bySkill] = yield* db.query<[Array<Record<string, unknown>>]>(
        `SELECT out.name AS skill, count() AS n FROM loaded GROUP BY skill ORDER BY n DESC LIMIT 12;`,
    );
    console.log("\ntop loaded skills (previously invisible to usage views):");
    for (const r of bySkill ?? []) console.log(`  ${String(r.skill).padEnd(34)} ${r.n}`);
});

await Effect.runPromise(p.pipe(Effect.provide(AppLayer)) as Effect.Effect<void, unknown, never>);
