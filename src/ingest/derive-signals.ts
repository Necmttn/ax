import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";

/**
 * Negation patterns that signal a user pushed back on the previous assistant
 * turn. Each entry is `[regex, label]` - the label is what we persist on the
 * `corrected_by.pattern` field so downstream queries can group by phrase.
 *
 * Patterns are matched against the first ~200 chars of the user turn text,
 * lowercased. Word boundaries keep us from firing on "actually" inside a URL
 * or "no" inside "node".
 */
const NEGATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    // Hard interrupts logged by Claude Code itself - strongest correction
    // signal we have, since the user literally cancelled mid-tool-use.
    [/\[request interrupted by user/i, "interrupted"],
    [/\bno\b/, "no"],
    [/\bstop\b/, "stop"],
    [/\bwrong\b/, "wrong"],
    [/\bnot that\b/, "not that"],
    [/\bactually\b/, "actually"],
    [/\binstead\b/, "instead"],
    [/\bwait\b/, "wait"],
    [/\bhold on\b/, "hold on"],
    [/\byou missed\b/, "you missed"],
    [/\byou forgot\b/, "you forgot"],
] as const;

const CORRECTION_WINDOW_CHARS = 200;

function matchNegation(text: string): string | null {
    const head = text.slice(0, CORRECTION_WINDOW_CHARS).toLowerCase();
    for (const [re, label] of NEGATION_PATTERNS) {
        if (re.test(head)) return label;
    }
    return null;
}

/**
 * Build a deterministic edge record-id so re-runs upsert instead of
 * duplicating. Surreal record-ids escape via backticks, so we strip out the
 * `turn:` prefix and join the two raw keys.
 */
function correctedByEdgeId(fromTurnKey: string, toTurnKey: string): string {
    return `${fromTurnKey}__${toTurnKey}`;
}

function proposedEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

interface TurnRow {
    id: { tb: string; id: string } | string;
    seq: number;
    role: string;
    text_excerpt: string | null;
    ts: string | Date;
    invoked_skills: ReadonlyArray<string>; // skill names this turn already invoked
}

interface SessionTurns {
    sessionId: string;
    turns: TurnRow[];
}

/** Extract the raw `id` portion of a turn record-id (`turn:⟨xyz⟩` → `xyz`). */
function rawTurnKey(id: TurnRow["id"]): string {
    if (typeof id === "string") {
        const colon = id.indexOf(":");
        return colon === -1 ? id : id.slice(colon + 1);
    }
    return id.id;
}

function tsToIso(ts: TurnRow["ts"]): string {
    return ts instanceof Date ? ts.toISOString() : String(ts);
}

/**
 * Fetch every (session → turns) bundle in one round-trip. Each turn carries
 * its outgoing `->invoked->skill.name` array so we can detect "proposed but
 * not invoked" without a second query.
 */
const fetchSessionTurns = (
    sinceDays: number | undefined,
): Effect.Effect<SessionTurns[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sinceFilter =
            sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const sql = `
SELECT
    id,
    session,
    seq,
    role,
    text_excerpt,
    ts,
    ->invoked->skill.name AS invoked_skills
FROM turn
${sinceFilter}
ORDER BY session ASC, seq ASC;`;
        const result = yield* db.query<[TurnRow[] & { session: unknown }[]]>(sql);
        const rows = (result?.[0] ?? []) as Array<TurnRow & { session: unknown }>;

        const bySession = new Map<string, TurnRow[]>();
        for (const row of rows) {
            const sess = row.session;
            const sessionId =
                typeof sess === "string"
                    ? sess.replace(/^session:/, "").replace(/[`⟨⟩]/g, "")
                    : sess && typeof sess === "object" && "id" in sess
                      ? String((sess as { id: unknown }).id)
                      : String(sess);
            const list = bySession.get(sessionId) ?? [];
            list.push(row);
            bySession.set(sessionId, list);
        }
        return [...bySession.entries()].map(([sessionId, turns]) => ({
            sessionId,
            turns,
        }));
    });

interface CorrectionEdge {
    fromTurnKey: string;
    toTurnKey: string;
    pattern: string;
    ts: string;
}

interface ProposedEdge {
    fromTurnKey: string;
    skillKey: string;
    skillName: string;
    ts: string;
    contextExcerpt: string;
}

/**
 * Walk turns in order. Whenever a user turn arrives, look back for the most
 * recent assistant turn (skipping tool_call / reasoning / function_call_output
 * noise that interleaves between assistant generations and user replies). If
 * the user text starts with a negation pattern, emit a correction edge from
 * that assistant turn to the user turn.
 */
function deriveCorrections(bundle: SessionTurns): CorrectionEdge[] {
    const out: CorrectionEdge[] = [];
    const turns = bundle.turns;
    let lastAssistantIdx: number | null = null;
    for (let i = 0; i < turns.length; i += 1) {
        const t = turns[i];
        if (t.role === "assistant") {
            lastAssistantIdx = i;
            continue;
        }
        if (t.role !== "user") continue;
        const text = t.text_excerpt;
        // Tool-result user turns carry no text excerpt - skip without
        // disturbing the anchor (this is what was masking interrupted-by-user
        // turns, which sit immediately after a tool_result user turn).
        if (!text) continue;
        if (lastAssistantIdx === null) continue;
        const matched = matchNegation(text);
        if (matched) {
            const prev = turns[lastAssistantIdx];
            out.push({
                fromTurnKey: rawTurnKey(prev.id),
                toTurnKey: rawTurnKey(t.id),
                pattern: matched,
                ts: tsToIso(t.ts),
            });
        }
        // After a user turn fires, reset the anchor so the next correction
        // must follow a fresh assistant turn.
        lastAssistantIdx = null;
    }
    return out;
}

/**
 * For each assistant turn whose excerpt mentions a known skill name but did
 * NOT outgoing-invoke that skill, emit a `proposed` edge. Substring match is
 * case-sensitive on the canonical skill name to avoid `gsd:plan-phase`
 * matching the word "plan" everywhere.
 */
function deriveProposed(
    bundle: SessionTurns,
    skillNames: ReadonlyArray<string>,
): ProposedEdge[] {
    if (skillNames.length === 0) return [];
    const out: ProposedEdge[] = [];
    for (const turn of bundle.turns) {
        if (turn.role !== "assistant") continue;
        const text = turn.text_excerpt;
        if (!text) continue;
        const invokedSet = new Set(turn.invoked_skills ?? []);
        for (const name of skillNames) {
            if (invokedSet.has(name)) continue;
            if (!text.includes(name)) continue;
            // Skip trivially-short names that would create noise (e.g. "ci").
            if (name.length < 4) continue;
            const idx = text.indexOf(name);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + name.length + 40);
            out.push({
                fromTurnKey: rawTurnKey(turn.id),
                skillKey: skillRecordKey(name),
                skillName: name,
                ts: tsToIso(turn.ts),
                contextExcerpt: text.slice(start, end),
            });
        }
    }
    return out;
}

const fetchSkillNames = (): Effect.Effect<string[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<{ name: string }>]>(
            `SELECT name FROM skill;`,
        );
        return (result?.[0] ?? []).map((r) => r.name).filter((n): n is string => Boolean(n));
    });

/**
 * Idempotent RELATE on the `corrected_by` relation. SurrealDB rejects raw
 * `UPSERT` against a RELATION-typed table ("is not a relation"), but
 * `RELATE in -> table:⟨id⟩ -> out` overwrites in place when the same edge
 * record-id is reused. Building the id deterministically from both endpoint
 * keys keeps re-runs side-effect-free.
 */
const upsertCorrections = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = correctedByEdgeId(e.fromTurnKey, e.toTurnKey);
            return `RELATE turn:\`${e.fromTurnKey}\` -> corrected_by:\`${edgeId}\` -> turn:\`${e.toTurnKey}\` SET pattern = ${JSON.stringify(e.pattern)}, ts = d"${e.ts}";`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertProposed = (edges: ProposedEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = proposedEdgeId(e.fromTurnKey, e.skillKey);
            return `RELATE turn:\`${e.fromTurnKey}\` -> proposed:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", context_excerpt = ${JSON.stringify(e.contextExcerpt)};`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

export interface DeriveStats {
    sessions: number;
    turns: number;
    corrections: number;
    proposed: number;
}

export interface DeriveOpts {
    sinceDays: number | undefined;
}

export const deriveSignals = (
    opts: Partial<DeriveOpts> = {},
): Effect.Effect<DeriveStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const skillNames = yield* fetchSkillNames();
        const bundles = yield* fetchSessionTurns(opts.sinceDays);

        let corrections = 0;
        let proposed = 0;
        let turnCount = 0;

        const correctionBatch: CorrectionEdge[] = [];
        const proposedBatch: ProposedEdge[] = [];

        for (const bundle of bundles) {
            turnCount += bundle.turns.length;
            const c = deriveCorrections(bundle);
            const p = deriveProposed(bundle, skillNames);
            corrections += c.length;
            proposed += p.length;
            correctionBatch.push(...c);
            proposedBatch.push(...p);
        }

        yield* upsertCorrections(correctionBatch);
        yield* upsertProposed(proposedBatch);

        console.log(
            `[derive-signals] DONE sessions=${bundles.length} turns=${turnCount} corrections=${corrections} proposed=${proposed}`,
        );
        return {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
        };
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveSignals({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveStats>,
    );
}
