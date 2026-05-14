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
 *    statement literal. The DB driver does not expose a parameterised binding
 *    in every code path we hit, so we rely on `JSON.stringify`'s deterministic
 *    string escape (it is a subset of valid SurrealQL string syntax).
 *
 * Real decode boundaries (`JSON.parse` on jsonl lines / file payloads) live in
 * `src/ingest/*` and should use Effect Schema decoders directly - those are
 * tracked in issue #71 ("Add boundary schemas for JSON IO").
 */

export const prettyPrint = (value: unknown): string =>
    JSON.stringify(value, null, 2);

export const surrealLiteral = (value: string): string => JSON.stringify(value);
