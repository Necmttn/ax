/**
 * How a row points at a blob on disk: `"<bucket>:/<path>"`.
 *
 * A plain string format with no engine in it - `session.raw_file` holds one
 * of these regardless of which store wrote it. It lives here, not beside any
 * DB client, so comparing two pointer strings never requires importing a
 * database SDK.
 */
export const filePointer = (bucket: string, path: string): string => `${bucket}:/${path}`;

/**
 * Does this string have the shape {@link filePointer} produces?
 *
 * Deliberately structural and not a bucket allowlist: GC uses it to answer "is
 * this reference set made of pointers at all", and a pointer into a bucket GC
 * does not scan is still evidence the producer is writing pointers. An absolute
 * filesystem path (`/Users/...`) fails it, which is the case that matters -
 * that is what a parser writes when it stores the source path instead.
 */
export const isBlobPointer = (value: string): boolean => /^[A-Za-z0-9_-]+:\/[^/]/.test(value);
