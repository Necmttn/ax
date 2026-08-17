/**
 * How a row points at a blob on disk: `"<bucket>:/<path>"`.
 *
 * A plain string format with no engine in it - `session.raw_file` holds one
 * of these regardless of which store wrote it. It lives here, not beside any
 * DB client, so comparing two pointer strings never requires importing a
 * database SDK.
 */
export const filePointer = (bucket: string, path: string): string => `${bucket}:/${path}`;
