/**
 * skillrev-backfill-probe: can skill_revision be backfilled from git history,
 * and would it overlap invocation data enough to run the churn-as-gate-grade
 * experiment? Read-only investigation.
 *
 * For the top-invoked skills: is the skill's on-disk dir inside a git repo, how
 * many commits touch its SKILL.md, and (for a multi-commit skill) do invocations
 * straddle the commit dates? Prints a verdict.
 *
 *   bun scripts/prototypes/skillrev-backfill-probe.ts
 */
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";

const git = (dir: string, args: string[]): string | null => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
};

const p = Effect.gen(function* () {
    const db = yield* SurrealClient;

    // Top-invoked non-synthetic skills.
    const [rows] = yield* db.query<[Array<Record<string, unknown>>]>(`
        SELECT type::string(out) AS sid, count() AS inv
        FROM invoked GROUP BY sid ORDER BY inv DESC LIMIT 60;
    `);
    const [skills] = yield* db.query<[Array<{ id: string; name: string; dir_path: string | null }>]>(
        `SELECT type::string(id) AS id, name, dir_path FROM skill WHERE dir_path != '(synthetic)';`,
    );
    const byId = new Map(skills.map((s) => [s.id, s]));

    // Bulk-pull invocation timestamps; compute the per-skill usage window in JS
    // (math::min/max(ts) returns "Infinity" on this data - ts aggregation is
    // unreliable, so do it the honest way).
    const [invTs] = yield* db.query<[Array<{ sid: string; ts: string }>]>(
        `SELECT type::string(out) AS sid, type::string(ts) AS ts FROM invoked WHERE ts IS NOT NONE;`,
    );
    const windowBySid = new Map<string, { min: number; max: number }>();
    for (const it of invTs ?? []) {
        const t = new Date(it.ts).getTime();
        if (Number.isNaN(t)) continue;
        const w = windowBySid.get(it.sid);
        if (!w) windowBySid.set(it.sid, { min: t, max: t });
        else { if (t < w.min) w.min = t; if (t > w.max) w.max = t; }
    }

    let gitTracked = 0, multiCommit = 0, straddling = 0, examined = 0;
    let shallow = 0, editsBeforeUseOnly = 0, editsAfterUseOnly = 0;
    const hits: string[] = [];

    for (const r of rows ?? []) {
        const sid = String(r.sid);
        const skill = byId.get(sid);
        if (!skill?.dir_path) continue;
        examined++;
        const dir = skill.dir_path;
        const inRepo = git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
        if (!inRepo) continue;
        gitTracked++;
        if (git(dir, ["rev-parse", "--is-shallow-repository"]) === "true") shallow++;
        // commit dates (unix) touching anything in the skill dir
        const log = git(dir, ["log", "--format=%ct", "--", "."]);
        const commitTs = (log ?? "").split("\n").filter(Boolean).map((s) => Number(s) * 1000);
        const inv = Number(r.inv ?? 0);
        const win = windowBySid.get(sid);
        if (!win) continue;                       // no usable invocation timestamps
        const firstInv = win.min;
        const lastInv = win.max;
        // timing of ALL commits relative to this skill's local usage window
        const before = commitTs.filter((c) => c < firstInv).length;
        const during = commitTs.filter((c) => c > firstInv && c < lastInv).length;
        const after = commitTs.filter((c) => c > lastInv).length;
        if (commitTs.length >= 1 && during === 0 && after === 0) editsBeforeUseOnly++;
        if (commitTs.length >= 1 && during === 0 && before === 0) editsAfterUseOnly++;
        if (commitTs.length < 2) continue;
        multiCommit++;
        if (during > 0) {
            straddling++;
            hits.push(`  ${skill.name.padEnd(30)} inv=${inv} commits=${commitTs.length} during=${during}`);
        }
    }

    console.log(`examined top ${examined} invoked skills`);
    console.log(`  git-tracked dir:        ${gitTracked}  (shallow clones: ${shallow})`);
    console.log(`  >=2 commits on dir:     ${multiCommit}`);
    console.log(`  ALL edits PREDATE local usage (install-then-use): ${editsBeforeUseOnly}`);
    console.log(`  ALL edits AFTER local usage:                      ${editsAfterUseOnly}`);
    console.log(`  edit straddles invocations (TESTABLE): ${straddling}`);
    if (hits.length) {
        console.log("\ntestable candidates:");
        hits.slice(0, 20).forEach((h) => console.log(h));
    }
    console.log(
        straddling >= 5
            ? `\nVERDICT: ${straddling} testable edits - git-backfill of skill_revision is worth building.`
            : `\nVERDICT: only ${straddling} testable edits - git-backfill won't unblock the experiment; the crux needs controlled re-runs (expensive path).`,
    );
});

await Effect.runPromise(p.pipe(Effect.provide(AppLayer)) as Effect.Effect<void, unknown, never>);
