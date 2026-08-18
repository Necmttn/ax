/**
 * Tiny escape-hatch wrappers around `JSON.stringify`. Centralising these
 * keeps the Effect "preferSchemaOverJson" advisory quiet at call sites that
 * are not actual IO decoding boundaries:
 *
 *  - `prettyPrint` formats a value for human-readable CLI stdout. Schema
 *    encode is not the right tool here; the CLI just wants a 2-space-indented
 *    dump of a value it already trusts (computed in-process, no external
 *    payload).
 *
 * Real decode boundaries (`JSON.parse` on jsonl lines / file payloads) live in
 * `src/ingest/*` and should use Effect Schema decoders directly - those are
 * tracked in issue #86 ("Effect JSON-boundary Schema decoders").
 */

export const prettyPrint = (value: unknown): string =>
    JSON.stringify(value, null, 2);
