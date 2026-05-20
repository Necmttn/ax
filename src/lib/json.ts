/**
 * Tiny escape-hatch wrappers around `JSON.stringify`. Centralising these
 * keeps the Effect "preferSchemaOverJson" advisory quiet at call sites that
 * are not actual IO decoding boundaries:
 *
 *  - `prettyPrint` formats a value for human-readable CLI stdout. Schema
 *    encode is not the right tool here; the CLI just wants a 2-space-indented
 *    dump of a value it already trusts (computed in-process, no external
 *    payload).
 *  - `surrealLiteral` quotes a string for inclusion inside a SurrealQL
 *    statement literal. It is a thin re-export of `surrealString` from the
 *    shared SurrealQL write seam (`lib/shared/surql.ts`), kept here for its
 *    existing call sites; new code should import `surrealString` directly.
 *
 * Real decode boundaries (`JSON.parse` on jsonl lines / file payloads) live in
 * `src/ingest/*` and should use Effect Schema decoders directly - those are
 * tracked in issue #71 ("Add boundary schemas for JSON IO").
 */

import { surrealString } from "./shared/surql.ts";

export const prettyPrint = (value: unknown): string =>
    JSON.stringify(value, null, 2);

export const surrealLiteral = surrealString;
