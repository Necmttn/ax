/**
 * record-select: the ONE reliable shape for bulk fetch-by-record-id, and the
 * single home of the SurrealDB id-IN-list quirk documentation.
 *
 * INVARIANT (verified live against SurrealDB 3.1.0 on 127.0.0.1:8521,
 * 2026-06-10, scratch script run against real rows of every table below):
 *
 *   - `SELECT ... FROM [table:`k1`, table:`k2`]` (record-list selection)
 *     resolved every existing record on EVERY table tested: session, turn,
 *     skill, file, commit, tool_call, pull_request. Missing records are
 *     silently skipped (1 real + 1 missing → 1 row; all missing → 0 rows,
 *     no error). The historical claim that `FROM [...]` returns
 *     `DatabaseEmpty` (old transcripts.ts comment) does NOT reproduce on
 *     3.1.0 - it was either version- or context-specific and is gone.
 *
 *   - `SELECT ... FROM <table> WHERE id IN [refs]` is UNRELIABLE: with the
 *     exact same refs it matched 0 rows on skill, file, commit, tool_call and
 *     pull_request, while matching correctly on session and turn. `WHERE id
 *     INSIDE [...]` fails the same way; single-equality `WHERE id = <ref>`
 *     works everywhere. The failing/working split does not follow key quoting
 *     (backticked-uuid session keys AND digit-leading plain turn keys both
 *     work), so do not assume any table is safe - just never bulk-filter on
 *     `id IN`.
 *
 *   - NON-id field IN-lists (`WHERE out IN [...]`, `WHERE session IN [...]`,
 *     `WHERE sha IN [...]`) are NOT affected and remain the right shape for
 *     indexed edge/field scans.
 *
 * Callers: build the FROM-source with {@link recordListSource} (bare keys) or
 * {@link refListSource} (pre-formatted record literals, e.g. `type::string(id)`
 * round-trips), or take the whole statement from {@link selectByIds}.
 */

import { recordLiteral } from "../ids.ts";

/**
 * A record-list FROM source from bare record keys:
 * `` [table:`k1`, table:`k2`] ``.
 *
 * @throws {Error} when any key is empty or contains a backtick/newline/null
 *   byte (see `recordLiteral`). Filter/normalize keys before calling.
 */
export const recordListSource = (table: string, keys: readonly string[]): string =>
    `[${keys.map((k) => recordLiteral(table, k)).join(", ")}]`;

/**
 * A record-list FROM source from refs that are ALREADY valid record literals
 * (e.g. strings produced by `type::string(id)` / `<string>id`, which come back
 * as `` table:`key` `` or `table:⟨key⟩`). No escaping is applied - never pass
 * user input through this form.
 */
export const refListSource = (refs: readonly string[]): string =>
    `[${refs.join(", ")}]`;

/**
 * The full bulk fetch-by-id statement: `SELECT <fields> FROM [refs];`.
 * Missing records are skipped; an all-missing list yields zero rows.
 */
export const selectByIds = (fields: string, table: string, keys: readonly string[]): string =>
    `SELECT ${fields} FROM ${recordListSource(table, keys)};`;
