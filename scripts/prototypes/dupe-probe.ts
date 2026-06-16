import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
const p = Effect.gen(function* () {
  const db = yield* SurrealClient;
  const [rows] = yield* db.query<[Array<Record<string, unknown>>]>(`
    SELECT type::string(id) AS id, name, scope, dir_path, content_hash, bytes FROM skill
    WHERE name IN ['plannotator-review','necmttn:plannotator-review','zoom-out','necmttn:zoom-out'];
  `);
  for (const r of rows) console.log(JSON.stringify(r));
  const [counts] = yield* db.query<[Array<Record<string, unknown>>]>(`
    SELECT count() AS total FROM skill GROUP ALL;
    `);
  console.log("totals:", JSON.stringify(counts));
  // how many bare names also have a namespaced twin (same suffix after ':')
  const [all] = yield* db.query<[Array<{ name: string; dir_path: string | null }>]>(
    `SELECT name, dir_path FROM skill;`,
  );
  const bare = new Set<string>();
  const namespaced = new Map<string, string[]>();
  for (const s of all) {
    if (s.name.includes(":")) {
      const suf = s.name.split(":").slice(1).join(":");
      const arr = namespaced.get(suf) ?? [];
      arr.push(s.name);
      namespaced.set(suf, arr);
    } else bare.add(s.name);
  }
  let twins = 0;
  for (const [suf] of namespaced) if (bare.has(suf)) twins++;
  console.log(`skills total=${all.length} bare=${bare.size} namespaced-suffixes=${namespaced.size} suffixes-with-bare-twin=${twins}`);
});
await Effect.runPromise(p.pipe(Effect.provide(AppLayer)) as Effect.Effect<void, unknown, never>);
