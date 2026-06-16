/**
 * churn-gate-probe: data-volume sanity check for the churn-as-gate-grade
 * experiment (docs/superpowers/plans/2026-06-16-churn-as-gate-grade-experiment.md).
 *
 * Answers: how many `change='changed'` skill_revision events exist, on how many
 * distinct skills, and (roughly) how many of those have invoking sessions both
 * before and after the edit ts. If this is near zero, the experiment is data
 * starved and the retrospective design can't run yet.
 *
 *   bun scripts/prototypes/churn-gate-probe.ts
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";

const probe = Effect.gen(function* () {
    const db = yield* SurrealClient;

    const [revs, invRows] = yield* db.query<[
        Array<{ sid: string; name: string; ts: string }>,
        Array<{ sid: string; ts: string }>,
    ]>(`
        SELECT type::string(skill) AS sid, name, ts FROM skill_revision WHERE change = 'changed' ORDER BY ts;
        SELECT type::string(out) AS sid, ts FROM invoked WHERE session IS NOT NONE;
    `);

    const changedSkills = new Set(revs.map((r) => r.sid));
    console.log(`changed revisions: ${revs.length} on ${changedSkills.size} distinct skills`);
    console.log(`invoked rows (with session): ${invRows.length}`);

    // Bucket invocation timestamps by skill id.
    const invBySkill = new Map<string, number[]>();
    for (const r of invRows) {
        const t = new Date(r.ts).getTime();
        if (Number.isNaN(t)) continue;
        const arr = invBySkill.get(r.sid) ?? [];
        arr.push(t);
        invBySkill.set(r.sid, arr);
    }

    // For each changed revision, count invoking sessions before/after its ts.
    let qualifying = 0;
    const N = 5; // min sessions each side to be usable
    console.log(`\nall ${revs.length} changed revisions (before/after invoking sessions, total ever):`);
    for (const rev of revs) {
        const ts = new Date(rev.ts).getTime();
        const invs = invBySkill.get(rev.sid) ?? [];
        let before = 0;
        let after = 0;
        for (const it of invs) {
            if (it < ts) before++;
            else if (it > ts) after++;
        }
        if (before >= N && after >= N) qualifying++;
        console.log(`  ${rev.name.padEnd(34)} before=${String(before).padStart(5)} after=${String(after).padStart(5)} total=${invs.length}`);
    }
    console.log(`\nrevisions with >=${N} invoking sessions BOTH sides: ${qualifying}`);

    if (qualifying < 5) {
        console.log(`\nVERDICT: data starved (<5 qualifying edits) - retrospective experiment can't run yet.`);
    } else {
        console.log(`\nVERDICT: ${qualifying} usable edits - proceed to the full before/after churn pass.`);
    }
});

if (import.meta.main) {
    await Effect.runPromise(
        probe.pipe(Effect.provide(AppLayer)) as Effect.Effect<void, unknown, never>,
    );
}
