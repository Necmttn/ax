/**
 * SessionId - the wire format for session ids in dashboard HTTP responses and
 * SPA state. A bare string with no SurrealDB record-id decoration.
 *
 * Examples of valid wire forms:
 *   "019e2531-b552-7b53-a029-c780adbb6560"   (claude UUID v7)
 *   "claude-subagent-a1f6ef32d7aefc7b9"      (synthetic subagent id)
 *
 * The Storage Backend (SurrealDB) wraps these in record-id syntax: backticks
 * (`` session:`uuid` ``) or angle-brackets (`session:⟨uuid⟩`). That decoration
 * is a Storage detail and MUST NOT cross the HTTP seam - the dashboard SPA
 * never sees a `session:` prefix, backtick, or ⟨⟩ wrapper.
 *
 * Server callers: run every SurrealDB-derived session id through
 * `toBareSessionId(...)` before serialising into a DTO. Use `toSessionRid(...)`
 * when interpolating a SessionId back into SurrealQL (e.g. `SELECT ... FROM
 * ${toSessionRid(id)}`).
 *
 * SPA callers: receive `SessionId` values via DTOs; use `shortSessionId(...)`
 * when truncating for compact display. Never strip or re-decorate the value -
 * any record-id artefact reaching the SPA is a server bug.
 *
 * This module supersedes the inline `bareId`/`shortId` helpers that lived in
 * the SPA routes and the `toSessionRid`/`safeLiteral`/`escaped + RE.test`
 * patterns scattered across the dashboard server modules.
 */

import { SessionId as BareSessionId } from "../brands.ts";

/** Wire alias, NOT yet the brand: dashboard DTOs (`shared/dashboard-types.ts`)
 *  are populated straight from DB rows, so flipping this alias to the branded
 *  type would force `.make` calls through every mapper. The brand is adopted
 *  producer-first: `toBareSessionId` returns the branded form (assignable to
 *  this alias), and params tighten once all producers brand - see
 *  `@ax/lib/brands` for the expansion path. */
export type SessionId = string;

/** Pure alphanumeric + underscore is the only charset SurrealDB accepts for
 *  unquoted record ids. Everything else (UUIDs with hyphens, slugs with `-`)
 *  needs backtick wrapping when interpolated into SurrealQL. */
const UNQUOTED_RID_RE = /^[A-Za-z0-9_]+$/;

/** Strip SurrealDB record-id decoration to recover the bare wire form.
 *  Handles `` session:`uuid` ``, `session:⟨uuid⟩`, `session:uuid`, and bare
 *  `uuid`. Idempotent: bare ids pass through unchanged. Whitespace is trimmed.
 *  Server-side use - call before emitting any session id over HTTP. */
export const toBareSessionId = (input: string): BareSessionId => {
    let s = input.trim();
    if (s.startsWith("session:")) s = s.slice("session:".length);
    // Strip a single layer of backtick or ⟨⟩ wrappers. SurrealDB never nests,
    // but the leading/trailing pair can be either char depending on the
    // surface (raw record id strings vs <string> casts).
    s = s.replace(/^[`⟨]+/, "").replace(/[`⟩]+$/, "");
    return BareSessionId.make(s);
};

/** Wrap a bare SessionId in SurrealDB record-id syntax so it can be embedded
 *  in a SurrealQL query. Returns `session:uuid` when the id is unquoted-safe
 *  (pure alphanumeric + underscore) and `` session:`uuid` `` otherwise. Strips
 *  any embedded backticks defensively before wrapping.
 *  Server-side use only - the SPA should never construct these. */
export const toSessionRid = (id: SessionId): string => {
    const escaped = id.replace(/`/g, "");
    return UNQUOTED_RID_RE.test(escaped) ? `session:${escaped}` : `session:\`${escaped}\``;
};

/** Compact 12-char prefix of a bare SessionId for table cells / header chips.
 *  Caller is responsible for appending an ellipsis if desired. Operates on
 *  bare ids only; passing a record-id-shaped string would include the
 *  prefix/wrapper in the truncation, which is a SPA bug to flag at the seam. */
export const shortSessionId = (id: SessionId): string => id.slice(0, 12);
