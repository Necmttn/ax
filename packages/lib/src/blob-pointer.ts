/**
 * How a row points at a blob on disk: `"<bucket>:/<path>"`.
 *
 * A plain string format with no engine in it - `session.raw_file` held one under
 * SurrealDB and holds the same one in the DuckDB cache. It lived in `db.ts`
 * beside the Surreal client purely because that is where the bucket helpers
 * were, which meant every reader of the format imported the client (and the
 * `surrealdb` SDK with it) to compare two strings.
 *
 * Every caller imports it from HERE. `db.ts` briefly re-exported it to spare
 * them an import line, which is a compatibility shim by any other name and the
 * migration forbids those - so the callers moved instead, and when the client is
 * deleted in wave 3 the format needs no rescue.
 */
export const filePointer = (bucket: string, path: string): string => `${bucket}:/${path}`;
