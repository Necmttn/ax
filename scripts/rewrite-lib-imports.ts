/**
 * One-shot codemod for the @ax/lib extraction (monorepo Task 4).
 *
 * Rewrites import specifiers across the axctl source tree:
 *   - `(../)+lib/X` | `./lib/X`  -> `@ax/lib/X`   (drops .ts; skips lib/pwd)
 *   - `./query.ts` (inside src/queries) | `(../)+queries/query.ts`
 *       -> `@ax/lib/shared/query`
 * And inside the lib package itself:
 *   - graph-query{,.test}: `(../)+queries/query.ts` -> `./query.ts`
 *
 * pwd.ts stayed in axctl (it depends on ingest), so `lib/pwd` is deliberately
 * NOT rewritten here - the two index.ts references are fixed by hand.
 *
 * Run once: `bun scripts/rewrite-lib-imports.ts`. Idempotent.
 */
import { Glob } from "bun";

const SPEC = /(["'])((?:\.\.?\/)+)lib\/([^"']+?)(?:\.ts)?\1/g;
const QUERY_REL = /(["'])\.\/query\.ts\1/g;
const QUERY_UP = /(["'])(?:\.\.\/)+queries\/query(?:\.ts)?\1/g;

let changed = 0;

async function rewriteAxctl(file: string) {
  let txt = await Bun.file(file).text();
  const before = txt;
  // lib/X -> @ax/lib/X (skip lib/pwd*)
  txt = txt.replace(SPEC, (m, q, _dots, path) => {
    if (path === "pwd" || path.startsWith("pwd.") || path.startsWith("pwd/")) return m;
    return `${q}@ax/lib/${path}${q}`;
  });
  // queries/query: relative ./query.ts only within src/queries, plus any ../queries/query
  if (file.startsWith("src/queries/")) txt = txt.replace(QUERY_REL, '$1@ax/lib/shared/query$1');
  txt = txt.replace(QUERY_UP, '$1@ax/lib/shared/query$1');
  if (txt !== before) { await Bun.write(file, txt); changed++; console.log("  axctl", file); }
}

async function rewriteLibInternal(file: string) {
  let txt = await Bun.file(file).text();
  const before = txt;
  // graph-query lived next to query after the move -> sibling import
  txt = txt.replace(/(["'])(?:\.\.\/)+queries\/query(?:\.ts)?\1/g, '$1./query.ts$1');
  if (txt !== before) { await Bun.write(file, txt); changed++; console.log("  lib  ", file); }
}

for await (const f of new Glob("src/**/*.{ts,tsx}").scan(".")) await rewriteAxctl(f);
for await (const f of new Glob("packages/lib/src/**/*.{ts,tsx}").scan(".")) await rewriteLibInternal(f);

console.log(`\nrewrote ${changed} files`);
