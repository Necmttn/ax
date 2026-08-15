/**
 * How a row points at a blob on disk: `"<bucket>:/<path>"`.
 *
 * A plain string format with no engine in it - `session.raw_file` held one under
 * SurrealDB and holds the same one in the DuckDB cache. It lived in `db.ts`
 * beside the Surreal client purely because that is where the bucket helpers
 * were, which meant every reader of the format imported the client (and the
 * `surrealdb` SDK with it) to compare two strings.
 *
 * `db.ts` re-exports it, so its existing callers are unchanged; when the client
 * is deleted in wave 3 the format survives here rather than needing a home in a
 * hurry.
 */
export const filePointer = (bucket: string, path: string): string => `${bucket}:/${path}`;
