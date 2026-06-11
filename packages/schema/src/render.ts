/**
 * Render-time substitutions for schema.surql.
 *
 * SurrealQL cannot interpolate env vars, so `DEFINE BUCKET ... BACKEND
 * "file:<abs path>"` is written with a literal path in schema.surql. That
 * literal is whatever the committing machine used - shipping it verbatim
 * pointed fresh installs at the package author's home directory, which the
 * daemon's `SURREAL_BUCKET_FOLDER_ALLOWLIST` (always the installing user's
 * data dir) then denied, rolling back the whole schema import transaction
 * (issue #251). Every apply path must rewrite the bucket paths to the
 * resolved local buckets dir first.
 */

const BUCKET_BACKEND_RE = /(DEFINE BUCKET IF NOT EXISTS (\w+)\s+BACKEND\s+")file:[^"]*"/g;

/**
 * Rewrite every `DEFINE BUCKET ... BACKEND "file:..."` in `schema` so the
 * bucket lives at `<bucketsDir>/<bucket name>`. All other content is
 * untouched. `bucketsDir` must be an absolute path without a trailing slash.
 */
export const renderBucketBackends = (schema: string, bucketsDir: string): string =>
    schema.replace(
        BUCKET_BACKEND_RE,
        (_m, prefix: string, name: string) => `${prefix}file:${bucketsDir}/${name}"`,
    );

/**
 * Bucket names the schema defines, in declaration order. The single source of
 * truth for "which buckets must exist" - doctor checks etc. derive from this
 * instead of hand-maintaining a list that drifts when schema.surql changes.
 */
export const bucketNames = (schema: string): string[] =>
    [...schema.matchAll(/DEFINE BUCKET IF NOT EXISTS (\w+)/g)].map((m) => m[1] as string);
