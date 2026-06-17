/**
 * `ax cost images`: image-read context cost per session split by main-thread
 * vs subagent. Surfaces the ~26% of context tokens that come from binary
 * (image) tool outputs and ~60% of which persists on MAIN-thread sessions,
 * re-billing across every later turn.
 *
 * Two flat queries, joined in JS (deref-free house idiom):
 *   1. SELECT VALUE type::string(out) FROM spawned  -> subagent session id set
 *   2. GROUP BY sid over has_content WHERE out = content_type:binary + ts window
 *
 * NOTE: estTokens uses BYTES_PER_TOKEN (4 B/tok) - the character-level
 * approximation for text. Image vision billing is based on image dimensions
 * (tiles), not byte length, so estTokens is a rough indicator only.
 *
 * Tables used (read-only):
 *   spawned: edge from parent to child session (out = child session record)
 *   has_content: out (content_type record), session, bytes (int), ts (datetime)
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { countField } from "@ax/lib/shared/surreal";
import { BYTES_PER_TOKEN } from "./content-types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImageContextRow {
    readonly session: string;       // session record id string
    readonly origin: "main" | "subagent";
    readonly calls: number;
    readonly bytes: number;
    /** bytes / BYTES_PER_TOKEN (approx; image vision cost differs - see module comment) */
    readonly estTokens: number;
}

export interface ImageContextResult {
    /** MAIN rows first, sorted by bytes desc, then subagent by bytes desc; capped by limit */
    readonly rows: ReadonlyArray<ImageContextRow>;
    readonly totals: {
        readonly mainBytes: number;
        readonly mainCalls: number;
        readonly subagentBytes: number;
        readonly subagentCalls: number;
    };
}

export interface ImageContextInput {
    readonly sinceDays: number;
    readonly limit: number;
}

// ---------------------------------------------------------------------------
// SQL-boundary guard (mirrors cost-analytics sqlWindowDays)
// ---------------------------------------------------------------------------

const sqlWindowDays = (n: number): number => Math.max(1, Math.trunc(n));

// ---------------------------------------------------------------------------
// Internal raw-row shape (what the DB returns before joining)
// ---------------------------------------------------------------------------

interface RawImageRow {
    readonly sid: string;
    readonly calls: number;
    readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Pure aggregation helper - unit testable without a DB
// ---------------------------------------------------------------------------

/**
 * Classify each session as main/subagent, compute estTokens, build totals,
 * sort (main first by bytes desc, then subagent by bytes desc), cap by limit.
 *
 * Kept pure so it can be exercised by unit tests without a live DB.
 */
export const rollupImageContext = (
    rawRows: ReadonlyArray<RawImageRow>,
    subagentSet: ReadonlySet<string>,
    limit: number,
): ImageContextResult => {
    const mainRows: ImageContextRow[] = [];
    const subagentRows: ImageContextRow[] = [];

    let mainBytes = 0;
    let mainCalls = 0;
    let subagentBytes = 0;
    let subagentCalls = 0;

    for (const raw of rawRows) {
        const bytes = Number(raw.bytes ?? 0);
        const calls = Number(raw.calls ?? 0);
        const origin: "main" | "subagent" = subagentSet.has(raw.sid) ? "subagent" : "main";
        const estTokens = Math.round(bytes / BYTES_PER_TOKEN);
        const row: ImageContextRow = { session: raw.sid, origin, calls, bytes, estTokens };

        if (origin === "main") {
            mainRows.push(row);
            mainBytes += bytes;
            mainCalls += calls;
        } else {
            subagentRows.push(row);
            subagentBytes += bytes;
            subagentCalls += calls;
        }
    }

    mainRows.sort((a, b) => b.bytes - a.bytes);
    subagentRows.sort((a, b) => b.bytes - a.bytes);

    const combined = [...mainRows, ...subagentRows];
    const rows = limit > 0 ? combined.slice(0, limit) : combined;

    return {
        rows,
        totals: { mainBytes, mainCalls, subagentBytes, subagentCalls },
    };
};

// ---------------------------------------------------------------------------
// SQL queries (flat, no derefs in aggregates)
// ---------------------------------------------------------------------------

/**
 * Fetch all subagent session ids in one cheap scan of the spawned edge table.
 * `out` is a record ref; type::string converts to "session:<id>" strings.
 */
const SPAWNED_IDS_SQL = `SELECT VALUE type::string(out) FROM spawned;`;

/**
 * Count binary content (images) per session within the time window.
 * `out = content_type:binary` filters to the binary bucket only.
 * Deref-free: session is a denormalized scalar on the edge row.
 */
const IMAGE_CONTEXT_SQL = (sinceDays: number) => `
SELECT type::string(session) AS sid, count() AS calls, math::sum(bytes) AS bytes
FROM has_content
WHERE out = content_type:binary AND session != NONE AND ts > time::now() - ${sqlWindowDays(sinceDays)}d
GROUP BY sid;
`;

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

export const fetchImageContext = Effect.fn("queries.fetchImageContext")(
    function* (input: ImageContextInput) {
        const db = yield* SurrealClient;

        // Query 1: subagent session ids (spawned is small; no window filter needed)
        const [spawnedRaw] = yield* db.query<[Array<unknown>]>(SPAWNED_IDS_SQL);
        const subagentSet = new Set<string>(
            (spawnedRaw ?? []).map((v) => String(v)).filter(Boolean),
        );

        // Query 2: image rows in the requested time window
        const [rawRows] = yield* db.query<[Array<Record<string, unknown>>]>(
            IMAGE_CONTEXT_SQL(input.sinceDays),
        );

        const parsed: RawImageRow[] = (rawRows ?? []).map((row) => ({
            sid: row.sid == null ? "" : String(row.sid),
            calls: countField(row, "calls"),
            bytes: countField(row, "bytes"),
        }));

        return rollupImageContext(parsed, subagentSet, input.limit);
    },
);
