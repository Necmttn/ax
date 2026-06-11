/**
 * record-select: the ONE reliable shape for bulk fetch-by-record-id, and the
 * single home of the SurrealDB id-IN-list quirk documentation.
 *
 * INVARIANT (verified live against SurrealDB 3.0.5 AND 3.1.0 in-memory
 * instances, 2026-06-11, plus 3.1.0 on 127.0.0.1:8521 against real rows on
 * 2026-06-10):
 *
 *   - Bare record-list selection `SELECT ... FROM [table:`k1`, table:`k2`]`
 *     works on 3.1.0 but THROWS "Specify a database to use" on 3.0.x even
 *     with the session namespace/database set (issue #251 - it aborted every
 *     Claude/Codex ingest on fresh installs, which pinned SurrealDB 3.0.5).
 *     Parameterized `FROM $ids` fails identically on 3.0.x.
 *
 *   - Materializing the records first - `FROM [refs].map(|$r| $r.*)` -
 *     resolves every existing record on BOTH 3.0.5 and 3.1.0. Missing
 *     records dereference to NONE; the appended `.filter(|$o| $o != NONE)`
 *     drops them explicitly (1 real + 1 missing → 1 row; all missing → 0
 *     rows, no error). Field expressions over the materialized objects -
 *     aliases, `type::string(id)`, `<string>id` casts - behave exactly as
 *     they do over a table source. This is the shape both helpers below emit.
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

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Dereference a record-id list into plain objects so the SELECT source is
 * version-portable (see the 3.0.x invariant above), dropping missing records.
 *
 * `pick` narrows the materialization to a destructured field subset
 * (`$r.{a, b}`) - use it on tables with heavy payload fields (e.g. `turn.text`,
 * `content_block.search_text`) so the server doesn't copy the full record just
 * to project two columns. It must include EVERY field the surrounding
 * statement touches: SELECT expressions (`type::string(id)` needs `id`,
 * `turn.seq` needs `turn`), WHERE, and ORDER BY.
 */
const materialized = (refList: string, pick?: readonly string[]): string => {
    if (pick !== undefined) {
        if (pick.length === 0) throw new Error("record-select: empty pick");
        for (const field of pick) {
            if (!IDENT_RE.test(field)) throw new Error(`record-select: invalid pick field ${JSON.stringify(field)}`);
        }
    }
    const shape = pick === undefined ? "*" : `{${pick.join(", ")}}`;
    return `${refList}.map(|$r| $r.${shape}).filter(|$o| $o != NONE)`;
};

/**
 * A materialized FROM source from bare record keys:
 * `` [table:`k1`, table:`k2`].map(|$r| $r.*).filter(|$o| $o != NONE) ``.
 *
 * @throws {Error} when any key is empty or contains a backtick/newline/null
 *   byte (see `recordLiteral`). Filter/normalize keys before calling.
 */
export const recordListSource = (table: string, keys: readonly string[], pick?: readonly string[]): string =>
    materialized(`[${keys.map((k) => recordLiteral(table, k)).join(", ")}]`, pick);

/**
 * A materialized FROM source from refs that are ALREADY valid record literals
 * (e.g. strings produced by `type::string(id)` / `<string>id`, which come back
 * as `` table:`key` `` or `table:⟨key⟩`). No escaping is applied - never pass
 * user input through this form.
 */
export const refListSource = (refs: readonly string[], pick?: readonly string[]): string =>
    materialized(`[${refs.join(", ")}]`, pick);

/**
 * The full bulk fetch-by-id statement:
 * `SELECT <fields> FROM [refs].map(|$r| $r.*).filter(|$o| $o != NONE);`.
 * Missing records are skipped; an all-missing list yields zero rows.
 */
export const selectByIds = (fields: string, table: string, keys: readonly string[], pick?: readonly string[]): string =>
    `SELECT ${fields} FROM ${recordListSource(table, keys, pick)};`;
