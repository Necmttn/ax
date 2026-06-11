# Phase 5: Signal Derivation Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `apps/axctl/src/ingest/derive-signals.ts` (1,018 LOC, one tiny satellite test) into read-evidence → pure derivation core → write-statements, so every Friction Event / Diagnostic Event classification rule is exhaustively testable against fixture rows shaped like real transcripts - without a SurrealDB instance.

**Architecture:** A new `apps/axctl/src/ingest/signals/` module trio (mirroring the existing `stage/`, `normalized/`, `content-blocks/` subdir convention): `types.ts` (evidence-row + edge/event shapes), `core.ts` (pure derivation: typed evidence rows in → signal records + edge specs out), `statements.ts` (pure SurrealQL statement builders, all literals via `@ax/lib/shared/surql`). `derive-signals.ts` shrinks to Ingest Stage wiring per ADR-0006 (`docs/adr/0006-typed-stats-as-ingest-stage-contract.md`): three SELECTs, the per-bundle progress loop, `executeStatementsWith` calls, typed `SignalsStats`. Stage key/deps/tags and the `deriveSignals` public signature are untouched, so `stage/registry.ts`, `cli/index.ts`, and the LaunchAgent `derive-signals` command keep working unchanged.

**Tech Stack:** TypeScript (strict), bun ≥ 1.3, Effect v4 beta (only in the stage wiring - the core is Effect-free), `bun:test` colocated `*.test.ts`, SurrealQL literal seam `@ax/lib/shared/surql`, chunked executor `@ax/lib/shared/statement-exec`.

**Why this split (read this before "simplifying" it):** This is NOT pure-function-extraction-for-testability's-sake. The classification logic IS where signal-quality bugs live: a false `user_correction` Friction Event (e.g. `\bno\b` firing on "node", an anchor not resetting after an unrelated user turn, a tool_result user turn swallowing the interrupt marker) pollutes Retrospective Candidates and everything downstream of `friction_event` (`derive-retro-proposals`, `session-health`, `outcomes`). The refactor's value is that the derivation rules get locality - one module, one fixture suite, one place to fix a misclassification - not that the file gets shorter.

**Working tree:** worktree branch off `main` (e.g. `refactor/signals-split`). All commits land there; integrate via PR.

---

## Derivation Rule Inventory

Every rule in `derive-signals.ts` today, what evidence it reads, what classification logic it applies, and what it writes. Line numbers refer to the current file.

| # | Rule (function, lines) | Evidence read | Classification logic | Emits |
|---|---|---|---|---|
| 0 | Session grouping (inline in `fetchSessionTurns`, 375–407) | `turn` rows: `id, session, seq, role, text_excerpt, ts, has_error, session.repository, session.checkout, session.cwd, ->invoked->skill.name AS invoked_skills`, ordered `session ASC, seq ASC` | Normalize `session` (string `session:⟨id⟩` with prefix/backtick/angle stripping, or `{id}` object) → group turns into `SessionTurns` bundles; first row wins for repo/checkout/cwd meta | `SessionTurns[]` (in-memory evidence bundles) |
| 1 | User correction (`deriveCorrections`, 442–480) | `SessionTurns` bundle | Walk turns in seq order; track last assistant turn as anchor; tool_result user turns (no `text_excerpt`) skip WITHOUT resetting the anchor; a user turn with text matching one of 11 `NEGATION_PATTERNS` (first 200 chars, lowercased, word-boundary regexes; `[request interrupted by user` strongest) emits an edge anchored at the previous assistant turn; ANY text-bearing user turn resets the anchor | `CorrectionEdge` → `RELATE turn -> corrected_by:⟨from__to⟩ -> turn SET pattern, ts` (idempotent via deterministic edge id) |
| 2 | was_corrected denormalisation (`markWasCorrected`, 734–759) | `CorrectionEdge[]` from rule 1 | Expand each correction to turn keys `[max(1, correctedSeq-3) .. correctedSeq]` in the corrected session (session id with `-` stripped, `_<seq>` suffix); dedupe across overlapping corrections | `UPDATE invoked SET was_corrected = true WHERE in = turn:⟨key⟩` per unique turn (issue #31 denormalisation) |
| 3 | Correction Friction Event (`deriveFrictionFromCorrections`, 621–658) | `CorrectionEdge[]` from rule 1 | Scope resolution: repository > checkout > cwd ("workspace") > session; confidence 0.8; labels carry pattern + scope; raw carries corrected/correction turn refs + correctedSeq | `DerivedFrictionEvent` kind `user_correction`, key `user_correction__<toTurnKey>` → `UPSERT friction_event MERGE {...}` |
| 4 | Proposed-not-invoked (`deriveProposed`, 488–517) | `SessionTurns` bundle + `SELECT name FROM skill` catalog | Assistant turns only; case-sensitive substring match of canonical skill name in `text_excerpt`; skip if the turn already `->invoked->` that skill; skip names shorter than 4 chars (noise guard); excerpt = ±40 chars around the match | `ProposedEdge` → `RELATE turn -> proposed:⟨from__skillKey⟩ -> skill SET ts, context_excerpt` |
| 5 | Skill pairing (`deriveSkillPairs`, 541–584) | `SessionTurns` bundle (accumulates across ALL bundles into one Map) | Per-turn dedupe of `invoked_skills`; every unordered pair of skills invoked within `PAIR_WINDOW = 3` seq steps (same turn counts, `sa > sb` same-turn guard avoids double count); undirected: lexicographically-smaller `skillRecordKey` in the `in` slot; edge id `lo[0..24)__hi[0..24)__Bun.hash(lo__hi).hex[0..12)`; count + max(ts) accumulate | `SkillPairAccum` → `RELATE skill -> skill_paired:⟨id⟩ -> skill SET count, last_seen` - written ONLY when `shouldDeriveAllTimeSkillPairs(sinceDays)` (i.e. full derive, no `--since`); a scoped derive would clobber all-time counts |
| 6 | Error recovery (`deriveRecovered`, 593–619) | `SessionTurns` bundle | Turn with `has_error = true`; scan forward up to `RECOVERY_WINDOW = 3` seq steps; first turn with any invocations wins (all skill names on that turn emit, then break - one recovery window per error) | `RecoveryEdge` → `RELATE turn -> recovered_by:⟨from__skillKey⟩ -> skill SET ts, error_excerpt` (`NONE` when excerpt missing) |
| 7 | Tool-failure Friction Event (`deriveFrictionFromToolCalls`, 288–315) | `tool_call` rows `WHERE has_error = true` (`id, session, turn, tool, tool.name, name, ts, status, command_norm, output_excerpt, error_text, exit_code, duration_ms, has_error, cwd, seq, call_id, session.repository, session.checkout`) | `isFailedToolCall` re-check (has_error / status "error" / exit_code ≠ 0); target name precedence `command_norm > tool_name > toolName > tool.name > name > "unknown_tool"`; evidence text `error_text ?? output_excerpt`; stable key = record id, else `safeKeyPart(session__callId|seq|target) + Bun.hash` fallback; confidence 1 | `DerivedFrictionEvent` kind `tool_error`, key `tool_error__<toolCallKey>` → `UPSERT friction_event MERGE {...}` |
| 8 | Tool-failure Diagnostic Event (`deriveDiagnosticsFromToolCalls`, 317–343) | same rows as rule 7 | identical classification, plus `status: "error"` | `DerivedDiagnosticEvent` kind `tool_failure`, key `tool_failure__<toolCallKey>` → `UPSERT diagnostic_event MERGE {...}` |

**Not derived here (out of scope):** Feedback Events (user approval/preference/strategy) live in `reaction-events.ts` / turn-feedback derivation, not in this stage. Intent edges live in `derive-intents.ts`. No schema changes, no CLI surface changes, no new stage keys.

**Write order (must be preserved exactly):** corrections → was_corrected → proposed → skill_pairs (gated) → recovered → friction_events → diagnostic_events, each via `executeStatementsWith(db, stmts, { chunkSize: 500 })`.

## Evidence input shapes (the core's input types)

From the three SELECTs (these become `signals/types.ts`, moved verbatim):

```ts
// fetchSessionTurns (lines 356–371) row shape, grouped into bundles:
interface TurnRow {
    id: { tb: string; id: string } | string;
    seq: number;
    role: string;
    text_excerpt: string | undefined;
    ts: string | Date;
    has_error: boolean;
    invoked_skills: ReadonlyArray<string>; // ->invoked->skill.name (runtime may hand back undefined; all consumers use `?? []`)
    repository?: RecordRefLike;            // session.repository
    checkout?: RecordRefLike;              // session.checkout
    cwd?: string;                          // session.cwd
}
interface SessionTurns {
    sessionId: string;
    repositoryKey: string | null;
    checkoutKey: string | null;
    cwd: string | null;
    turns: TurnRow[];
}
// fetchFailedToolCalls (lines 675–698) rows: the existing exported ToolCallLike
// (snake_case + camelCase duals, RecordRefLike id/session/turn/tool, optional
// command_norm/output_excerpt/error_text/exit_code/duration_ms/status/has_error/
// ts/cwd/seq/call_id/repository/checkout) - moved as-is.
// fetchSkillNames: ReadonlyArray<string>.
```

## Output spec (the core's outputs → statement builders)

Core outputs are the existing in-memory specs, promoted to exported types: `CorrectionEdge`, `ProposedEdge`, `SkillPairAccum` (+ parallel edge-id list), `RecoveryEdge`, `DerivedFrictionEvent`, `DerivedDiagnosticEvent`. `signals/statements.ts` turns each batch into SurrealQL strings - the templates are MOVED VERBATIM from today's `upsertCorrections` / `markWasCorrected` / `upsertProposed` / `upsertSkillPairs` / `upsertRecovered` / `upsertFrictionEvents` / `upsertDiagnosticEvents` (lines 710–841), keeping `recordRef`, `surrealString`, `surrealObject`, `surrealDate`, `surrealOptionRecord`, `surrealOptionString`, `surrealJsonTextOption` from `@ax/lib/shared/surql` (note: `derive-signals.ts` currently imports `recordRef` via `./evidence-writers.ts`, which is itself a re-export of the surql one - import it directly from `@ax/lib/shared/surql` in the new module).

The statement strings ARE the write behavior: same evidence rows → identical statement strings → identical DB writes (chunking is `executeStatementsWith`'s already-tested concern). This is what makes exact behavior preservation verifiable without a live DB.

## External consumers (compat constraints - verified by grep)

| Consumer | Imports | Constraint |
|---|---|---|
| `apps/axctl/src/ingest/stage/registry.ts:18` | `SignalsKey`, `signalsStage` | keep exported from `derive-signals.ts` |
| `apps/axctl/src/cli/index.ts:81` | `deriveSignals` | keep signature `(opts: Partial<DeriveOpts>) => Effect<DeriveStats, DbError, SurrealClient>`; per-bundle `onProgress` cadence (first 5 bundles, then every 50) must keep firing - CLI progress UX depends on it |
| `apps/axctl/src/cli/install.ts:132,169` | shell string `axctl derive-signals` | command name untouched; `import.meta.main` block stays in `derive-signals.ts` |
| `apps/axctl/src/ingest/derive-signals.stage.test.ts` | `SignalsKey`, `signalsStage` | unchanged, must keep passing |
| `apps/axctl/src/ingest/evidence-derivation.test.ts` | `deriveFrictionFromToolCalls`, `deriveDiagnosticsFromToolCalls`, `shouldDeriveAllTimeSkillPairs` | its 3 cases get folded into `signals/core.test.ts` and the file deleted (Task 1) |
| `effect-cli.test.ts`, `self-improve/signals.ts` | command-name strings only / unrelated `deriveSignalsForSelfImprove` | no change |

No other module imports `ToolCallLike` / `DerivedFrictionEvent` / `DerivedDiagnosticEvent` / `DeriveStats` - re-exports from `derive-signals.ts` are NOT needed once `evidence-derivation.test.ts` is folded in.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/axctl/src/ingest/signals/types.ts` | `RecordRefLike`, `JsonRecord`, `ToolCallLike`, `TurnRow`, `SessionTurns`, `CorrectionEdge`, `ProposedEdge`, `SkillPairAccum`, `RecoveryEdge`, `DerivedFrictionEvent`, `DerivedDiagnosticEvent`, `SignalEvidence`, `DerivedSignals` | Create (Task 2) |
| `apps/axctl/src/ingest/signals/core.ts` | All pure derivation: negation matching, edge-id generation, per-rule derivers, tool-call classification helpers, `groupTurnsBySession`, `deriveSignalsFromEvidence` | Create (Task 4) |
| `apps/axctl/src/ingest/signals/core.test.ts` | Exhaustive per-rule fixture tests (characterization-first: written against `../derive-signals.ts`, flipped to `./core.ts` in Task 4) | Create (Task 1) |
| `apps/axctl/src/ingest/signals/statements.ts` | Pure statement builders + `correctedInvokedTurnKeys` | Create (Task 3) |
| `apps/axctl/src/ingest/signals/statements.test.ts` | Golden-string tests for every builder | Create (Task 3) |
| `apps/axctl/src/ingest/signals/derive-pipeline.test.ts` | End-to-end: realistic multi-session evidence → `deriveSignalsFromEvidence` → all builders in stage order | Create (Task 6) |
| `apps/axctl/src/ingest/derive-signals.ts` | Stage wiring only: 3 fetches, progress loop, builder+exec calls, `DeriveStats`, `import.meta.main`, `SignalsKey`/`SignalsStats`/`signalsStage` (~230 LOC) | Shrink (Tasks 1–5) |
| `apps/axctl/src/ingest/evidence-derivation.test.ts` | superseded | Delete (Task 1) |
| `apps/axctl/src/ingest/derive-signals.stage.test.ts` | stage meta contract | Untouched (verify green) |

## Behavior-preservation strategy

The full old `deriveSignals` cannot run against in-memory rows - it dereferences `SurrealClient` and embeds its SELECTs, and standing up a scratch SurrealDB per test run is not this repo's unit-test convention (no ingest test does it; stage tests only assert meta). But EVERYTHING after the fetches is plain functions over plain rows, so the harness operates one seam below the Effect boundary, in two layers:

1. **Characterization tests written FIRST against the old code (Task 1).** Add `export` keywords to the currently-private helpers (zero behavior change), write `signals/core.test.ts` importing from `../derive-signals.ts`, and confirm green against the monolith. In Task 4 the ONLY change to that file is the import path (`../derive-signals.ts` → `./core.ts` / `./types.ts`). Same assertions passing against old then new = the before/after diff harness for the derivation core.
2. **Golden statement strings (Task 3).** The builders are cut verbatim from the `upsert*` bodies; tests pin the exact SurrealQL output per batch. Since `executeStatementsWith(db, stmts, { chunkSize: 500 })` already no-ops on `[]` (verified: `statement-exec.ts:37`), dropping the `if (edges.length === 0) return` guards is behavior-neutral, and identical statement arrays ⇒ identical DB writes.
3. **Optional live sanity diff (Task 6).** Run `bun apps/axctl/src/ingest/derive-signals.ts --since=7` on the local DB before starting and after Task 5; the logged stats line (sessions/turns/corrections/proposed/skillPairs/recoveries/frictionEvents/diagnosticEvents) must match. All writes are idempotent upserts/RELATEs with deterministic ids, so the re-run is safe. Caveat (memory: re-ingest watcher race): don't run while `ax-watch` is mid-ingest.

---

## Task 1: Characterization harness against the monolith

**Files:**
- Modify: `apps/axctl/src/ingest/derive-signals.ts` (add `export` keywords: lines 38, 51, 55, 65, 75, 154, 167, 196, 410, 427, 442, 488, 519, 526, 541, 593, 621; extract `groupTurnsBySession` from `fetchSessionTurns` lines 375–407)
- Create: `apps/axctl/src/ingest/signals/core.test.ts`
- Delete: `apps/axctl/src/ingest/evidence-derivation.test.ts`

- [ ] **Step 1: Export the private derivation internals (no logic change)**

In `derive-signals.ts`, add `export` to: `matchNegation`, `correctedByEdgeId`, `proposedEdgeId`, `skillPairedEdgeId`, `recoveredByEdgeId`, `toolCallStableKey`, `deriveCorrections`, `deriveProposed`, `deriveSkillPairs`, `deriveRecovered`, `deriveFrictionFromCorrections`, and the interfaces `TurnRow`, `SessionTurns`, `CorrectionEdge`, `ProposedEdge`, `SkillPairAccum`, `RecoveryEdge`. (`deriveFrictionFromToolCalls`, `deriveDiagnosticsFromToolCalls`, `shouldDeriveAllTimeSkillPairs`, `ToolCallLike`, `DerivedFrictionEvent`, `DerivedDiagnosticEvent` are already exported.)

- [ ] **Step 2: Extract `groupTurnsBySession` (verbatim cut-paste of the pure tail of `fetchSessionTurns`)**

Replace lines 375–407 of `fetchSessionTurns` with `return groupTurnsBySession(rows);` and add above it:

```ts
/** Pure grouping of raw turn rows into per-session bundles. Session ids come
 *  back from Surreal as either `session:⟨id⟩` strings or `{ tb, id }` objects;
 *  both normalize to the bare key. First row wins for repo/checkout/cwd meta. */
export function groupTurnsBySession(
    rows: ReadonlyArray<TurnRow & { session: unknown }>,
): SessionTurns[] {
    const bySession = new Map<string, TurnRow[]>();
    const metaBySession = new Map<
        string,
        { repositoryKey: string | null; checkoutKey: string | null; cwd: string | null }
    >();
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
        if (!metaBySession.has(sessionId)) {
            metaBySession.set(sessionId, {
                repositoryKey: recordKeyPart(row.repository, "repository"),
                checkoutKey: recordKeyPart(row.checkout, "checkout"),
                cwd: nonEmptyString(row.cwd),
            });
        }
    }
    return [...bySession.entries()].map(([sessionId, turns]) => ({
        sessionId,
        ...(metaBySession.get(sessionId) ?? {
            repositoryKey: null,
            checkoutKey: null,
            cwd: null,
        }),
        turns,
    }));
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `bun test apps/axctl/src/ingest/evidence-derivation.test.ts apps/axctl/src/ingest/derive-signals.stage.test.ts` → PASS. Run `bun run typecheck` → clean.

- [ ] **Step 4: Write the characterization suite (must pass IMMEDIATELY - it pins current behavior)**

Create `apps/axctl/src/ingest/signals/core.test.ts`. Sibling test conventions followed (`derive-intents.test.ts`, `derive-opportunities.test.ts`): `bun:test`, row-literal factory helpers, no DB, assertions on exported pure functions. Full content:

```ts
import { describe, expect, test } from "bun:test";
import { skillRecordKey } from "@ax/lib/skill-id";
// Task 4 flips these two imports to "./core.ts" / "./types.ts" - that flip is
// the before/after behavior-preservation harness. Do not edit assertions then.
import {
    deriveCorrections,
    deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections,
    deriveFrictionFromToolCalls,
    deriveProposed,
    deriveRecovered,
    deriveSkillPairs,
    groupTurnsBySession,
    matchNegation,
    shouldDeriveAllTimeSkillPairs,
    skillPairedEdgeId,
    toolCallStableKey,
    type SessionTurns,
    type SkillPairAccum,
    type ToolCallLike,
    type TurnRow,
} from "../derive-signals.ts";

const turn = (
    partial: Partial<TurnRow> & Pick<TurnRow, "id" | "seq" | "role">,
): TurnRow => ({
    text_excerpt: undefined,
    ts: "2026-06-01T10:00:00.000Z",
    has_error: false,
    invoked_skills: [],
    ...partial,
});

const bundle = (turns: TurnRow[], meta?: Partial<SessionTurns>): SessionTurns => ({
    sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
    repositoryKey: null,
    checkoutKey: null,
    cwd: null,
    turns,
    ...meta,
});

describe("matchNegation", () => {
    test("hard interrupt marker is the strongest correction signal", () => {
        expect(matchNegation("[Request interrupted by user]")).toBe("interrupted");
        expect(matchNegation("[Request interrupted by user for tool use]")).toBe("interrupted");
    });

    test("word-boundary negations match case-insensitively in the first 200 chars", () => {
        expect(matchNegation("No, use the other parser")).toBe("no");
        expect(matchNegation("stop - that branch is protected")).toBe("stop");
        expect(matchNegation("that's the wrong file")).toBe("wrong");
        expect(matchNegation("wait, that deletes prod data")).toBe("wait");
        expect(matchNegation("you forgot the migration file")).toBe("you forgot");
    });

    test("pattern order decides the label when several match", () => {
        // "actually" precedes "instead" in NEGATION_PATTERNS
        expect(matchNegation("actually, let's use bun instead")).toBe("actually");
        // "no" precedes "wrong"
        expect(matchNegation("no, that's the wrong file")).toBe("no");
    });

    test("word boundaries keep 'no' from firing inside 'node'", () => {
        expect(matchNegation("node looks good, ship it")).toBeNull();
    });

    test("plain approval does not match", () => {
        expect(matchNegation("looks great, ship it")).toBeNull();
    });

    test("negations past the 200-char window are ignored", () => {
        expect(matchNegation(`${"a".repeat(200)} wrong`)).toBeNull();
        expect(matchNegation(`${"a".repeat(190)} wrong`)).toBe("wrong");
    });
});

describe("deriveCorrections", () => {
    const assistant = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000003" },
        seq: 3,
        role: "assistant",
        text_excerpt: "I refactored the ingest stage to write directly to the DB.",
        ts: "2026-06-01T10:00:00.000Z",
    });
    const toolResult = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000004" },
        seq: 4,
        role: "user", // tool_result user turn: no text_excerpt
    });
    const pushback = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000005" },
        seq: 5,
        role: "user",
        text_excerpt: "no, that's the wrong file - the stage lives in derive-signals.ts",
        ts: "2026-06-01T10:00:30.000Z",
    });

    test("user pushback anchors to the last assistant turn, skipping tool_result turns", () => {
        const edges = deriveCorrections(bundle([assistant, toolResult, pushback]));
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000003",
                toTurnKey: "0a1b2c3d__seq_000005",
                pattern: "no",
                text: "no, that's the wrong file - the stage lives in derive-signals.ts",
                ts: "2026-06-01T10:00:30.000Z",
                repositoryKey: null,
                checkoutKey: null,
                cwd: null,
                correctedSession: "0a1b2c3d-1111-2222-3333-444455556666",
                correctedSeq: 3,
            },
        ]);
    });

    test("a negation before any assistant turn emits nothing", () => {
        expect(deriveCorrections(bundle([pushback]))).toEqual([]);
    });

    test("a text-bearing user turn resets the anchor even without a negation", () => {
        const ack = turn({
            id: { tb: "turn", id: "0a1b2c3d__seq_000004b" },
            seq: 4,
            role: "user",
            text_excerpt: "ok sounds good, continue",
        });
        // assistant -> ack (resets anchor) -> pushback: no anchor left, no edge
        expect(deriveCorrections(bundle([assistant, ack, pushback]))).toEqual([]);
    });

    test("approval text emits nothing", () => {
        const approval = turn({
            id: { tb: "turn", id: "0a1b2c3d__seq_000005c" },
            seq: 5,
            role: "user",
            text_excerpt: "looks great, ship it",
        });
        expect(deriveCorrections(bundle([assistant, approval]))).toEqual([]);
    });
});

describe("deriveProposed", () => {
    const skillNames = ["superpowers:test-driven-development", "diagnose", "tdd"];
    const mention = "Run superpowers:test-driven-development first.";

    test("assistant mention of a known skill it did not invoke emits a proposed edge", () => {
        const edges = deriveProposed(
            bundle([
                turn({
                    id: { tb: "turn", id: "0a1b2c3d__seq_000002" },
                    seq: 2,
                    role: "assistant",
                    text_excerpt: mention,
                    ts: "2026-06-01T10:00:00.000Z",
                }),
            ]),
            skillNames,
        );
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey("superpowers:test-driven-development"),
                skillName: "superpowers:test-driven-development",
                ts: "2026-06-01T10:00:00.000Z",
                contextExcerpt: mention, // short text: +/-40 chars covers it all
            },
        ]);
    });

    test("already-invoked skills, short names, case mismatches, user turns: no edge", () => {
        const turns = [
            // invoked it -> not "proposed"
            turn({ id: { tb: "turn", id: "t1" }, seq: 1, role: "assistant", text_excerpt: mention, invoked_skills: ["superpowers:test-driven-development"] }),
            // "tdd" mentioned but name.length < 4 -> noise guard
            turn({ id: { tb: "turn", id: "t2" }, seq: 2, role: "assistant", text_excerpt: "Use tdd here." }),
            // case-sensitive: "Diagnose" !== "diagnose"
            turn({ id: { tb: "turn", id: "t3" }, seq: 3, role: "assistant", text_excerpt: "Diagnose the failure first." }),
            // user turns never propose
            turn({ id: { tb: "turn", id: "t4" }, seq: 4, role: "user", text_excerpt: mention }),
        ];
        expect(deriveProposed(bundle(turns), skillNames)).toEqual([]);
    });

    test("empty catalog short-circuits", () => {
        expect(deriveProposed(bundle([turn({ id: "turn:t1", seq: 1, role: "assistant", text_excerpt: mention })]), [])).toEqual([]);
    });
});

describe("deriveSkillPairs", () => {
    const keysSorted = (a: string, b: string): [string, string] => {
        const ka = skillRecordKey(a);
        const kb = skillRecordKey(b);
        return ka < kb ? [ka, kb] : [kb, ka];
    };

    test("skills within 3 seq steps pair undirected; duplicates in one turn dedupe", () => {
        const accum = new Map<string, SkillPairAccum>();
        deriveSkillPairs(
            bundle([
                turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["commit", "commit"], ts: "2026-06-01T10:00:00.000Z" }),
                turn({ id: "turn:t2", seq: 4, role: "assistant", invoked_skills: ["diagnose"], ts: "2026-06-01T10:02:00.000Z" }),
                turn({ id: "turn:t3", seq: 8, role: "assistant", invoked_skills: ["retro"], ts: "2026-06-01T10:05:00.000Z" }),
            ]),
            accum,
        );
        // commit<->diagnose (delta 3, in window); diagnose<->retro delta 4: out
        expect(accum.size).toBe(1);
        const [lo, hi] = keysSorted("commit", "diagnose");
        const pair = [...accum.values()][0]!;
        expect(pair).toEqual({ fromKey: lo, toKey: hi, count: 1, lastSeen: "2026-06-01T10:02:00.000Z" });
    });

    test("same-turn co-invocation counts once, never self-pairs", () => {
        const accum = new Map<string, SkillPairAccum>();
        deriveSkillPairs(
            bundle([
                turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["alpha-skill", "beta-skill", "alpha-skill"] }),
            ]),
            accum,
        );
        expect(accum.size).toBe(1);
        expect([...accum.values()][0]!.count).toBe(1);
    });

    test("accumulates counts across bundles into the shared map", () => {
        const accum = new Map<string, SkillPairAccum>();
        const b = bundle([
            turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["commit"] }),
            turn({ id: "turn:t2", seq: 2, role: "assistant", invoked_skills: ["diagnose"], ts: "2026-06-02T09:00:00.000Z" }),
        ]);
        deriveSkillPairs(b, accum);
        deriveSkillPairs(b, accum);
        expect([...accum.values()][0]!.count).toBe(2);
    });

    test("skillPairedEdgeId is symmetric and orders keys lexicographically", () => {
        const a = skillRecordKey("commit");
        const b = skillRecordKey("diagnose");
        const fwd = skillPairedEdgeId(a, b);
        const rev = skillPairedEdgeId(b, a);
        expect(fwd).toEqual(rev);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        expect(fwd.fromKey).toBe(lo);
        expect(fwd.toKey).toBe(hi);
        expect(fwd.edgeId.startsWith(`${lo.slice(0, 24)}__${hi.slice(0, 24)}__`)).toBe(true);
    });
});

describe("deriveRecovered", () => {
    const errorTurn = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000002" },
        seq: 2,
        role: "assistant",
        has_error: true,
        text_excerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
    });

    test("first invocation within 3 seq steps recovers; all skills on that turn emit; later ones don't", () => {
        const edges = deriveRecovered(
            bundle([
                errorTurn,
                turn({ id: { tb: "turn", id: "0a1b2c3d__seq_000004" }, seq: 4, role: "assistant", invoked_skills: ["diagnose", "failure-recovery"], ts: "2026-06-01T10:01:00.000Z" }),
                turn({ id: { tb: "turn", id: "0a1b2c3d__seq_000005" }, seq: 5, role: "assistant", invoked_skills: ["retro"], ts: "2026-06-01T10:02:00.000Z" }),
            ]),
        );
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey("diagnose"),
                skillName: "diagnose",
                ts: "2026-06-01T10:01:00.000Z",
                errorExcerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
            },
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey("failure-recovery"),
                skillName: "failure-recovery",
                ts: "2026-06-01T10:01:00.000Z",
                errorExcerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
            },
        ]);
    });

    test("invocations outside the 3-step window do not recover", () => {
        const edges = deriveRecovered(
            bundle([
                errorTurn,
                turn({ id: "turn:t6", seq: 6, role: "assistant", invoked_skills: ["diagnose"] }),
            ]),
        );
        expect(edges).toEqual([]);
    });

    test("no error turns -> nothing", () => {
        expect(
            deriveRecovered(bundle([turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["diagnose"] })])),
        ).toEqual([]);
    });
});

describe("deriveFrictionFromCorrections", () => {
    const edge = {
        fromTurnKey: "0a1b2c3d__seq_000003",
        toTurnKey: "0a1b2c3d__seq_000005",
        pattern: "no",
        text: "no, that's the wrong file",
        ts: "2026-06-01T10:00:30.000Z",
        repositoryKey: null as string | null,
        checkoutKey: null as string | null,
        cwd: null as string | null,
        correctedSession: "0a1b2c3d-1111-2222-3333-444455556666",
        correctedSeq: 3,
    };

    test("repository scope wins; event keyed by the correcting turn", () => {
        const [event] = deriveFrictionFromCorrections([
            { ...edge, repositoryKey: "github_com_necmttn_ax", cwd: "/Users/necmttn/Projects/ax" },
        ]);
        expect(event).toMatchObject({
            key: "user_correction__0a1b2c3d__seq_000005",
            kind: "user_correction",
            sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
            turnKey: "0a1b2c3d__seq_000005",
            source: "corrected_by",
            confidence: 0.8,
            text: "no, that's the wrong file",
            ts: "2026-06-01T10:00:30.000Z",
        });
        expect(event!.labels).toMatchObject({
            source: "corrected_by",
            pattern: "no",
            repository: "repository:github_com_necmttn_ax",
            scope: "repository",
            scopeId: "repository:github_com_necmttn_ax",
        });
        expect(event!.metrics).toEqual({ confidence: 0.8 });
        expect(event!.raw).toEqual({
            correctedTurn: "turn:0a1b2c3d__seq_000003",
            correctionTurn: "turn:0a1b2c3d__seq_000005",
            correctedSeq: 3,
        });
    });

    test("falls back to session scope when repo/checkout/cwd are all null", () => {
        const [event] = deriveFrictionFromCorrections([edge]);
        expect(event!.labels).toMatchObject({
            scope: "session",
            scopeId: "0a1b2c3d-1111-2222-3333-444455556666",
        });
    });
});

describe("tool-call derivers", () => {
    const failedCall: ToolCallLike = {
        id: "tool_call:session__call_1",
        session: "session:abc",
        turn: "turn:abc_7",
        name: "exec_command",
        command_norm: "bun test",
        output_excerpt: "1 fail, 2 pass",
        error_text: "Expected 1 failure",
        exit_code: 1,
        has_error: true,
        ts: "2026-05-09T10:00:00.000Z",
    };

    test("failed command derives tool_error friction with command target name", () => {
        const events = deriveFrictionFromToolCalls([failedCall]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_error__session__call_1",
            kind: "tool_error",
            sessionId: "abc",
            turnKey: "abc_7",
            targetType: "tool",
            targetName: "bun test",
            text: "Expected 1 failure",
            ts: "2026-05-09T10:00:00.000Z",
        });
        expect(events[0]?.labels).toMatchObject({ targetType: "tool", targetName: "bun test" });
        expect(events[0]?.metrics).toMatchObject({ exitCode: 1 });
    });

    test("failed command derives diagnostic_event shape", () => {
        const events = deriveDiagnosticsFromToolCalls([
            { ...failedCall, id: "tool_call:session__call_2", turn: "turn:abc_8", output_excerpt: "TypeScript error", error_text: undefined, status: "error", ts: "2026-05-09T10:01:00.000Z" },
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_failure__session__call_2",
            kind: "tool_failure",
            status: "error",
            text: "TypeScript error",
            targetType: "tool",
            targetName: "bun test",
        });
    });

    test("successful calls derive nothing (isFailedToolCall re-check)", () => {
        const ok: ToolCallLike = { ...failedCall, has_error: false, exit_code: 0, status: "ok" };
        expect(deriveFrictionFromToolCalls([ok])).toEqual([]);
        expect(deriveDiagnosticsFromToolCalls([ok])).toEqual([]);
    });

    test("nonzero exit code alone marks the call failed", () => {
        const events = deriveFrictionFromToolCalls([{ ...failedCall, has_error: undefined, status: undefined, exit_code: 2 }]);
        expect(events).toHaveLength(1);
        expect(events[0]?.metrics).toMatchObject({ exitCode: 2 });
    });

    test("toolCallStableKey: record id wins; deterministic hashed fallback otherwise", () => {
        expect(toolCallStableKey(failedCall, 0)).toBe("session__call_1");
        const noId: ToolCallLike = { session: "session:abc", call_id: "call_42", has_error: true, ts: "2026-05-09T10:00:00.000Z" };
        const k1 = toolCallStableKey(noId, 0);
        const k2 = toolCallStableKey(noId, 5); // index only matters when nothing else identifies the call
        expect(k1).toBe(k2);
        expect(k1.startsWith("abc__call_42__")).toBe(true);
        expect(k1).toMatch(/__[0-9a-f]+$/);
    });

    test("targetName precedence: command_norm > tool_name > tool.name > name", () => {
        expect(deriveFrictionFromToolCalls([failedCall])[0]?.targetName).toBe("bun test");
        expect(
            deriveFrictionFromToolCalls([{ ...failedCall, command_norm: undefined, tool_name: "Bash" }])[0]?.targetName,
        ).toBe("Bash");
        expect(
            deriveFrictionFromToolCalls([
                { ...failedCall, command_norm: undefined, tool_name: undefined, tool: { name: "Bash" } },
            ])[0]?.targetName,
        ).toBe("Bash");
        expect(
            deriveFrictionFromToolCalls([
                { ...failedCall, command_norm: undefined, tool_name: undefined, tool: undefined },
            ])[0]?.targetName,
        ).toBe("exec_command");
    });
});

describe("groupTurnsBySession", () => {
    test("string and object session refs normalize to the same bundle; first row wins meta", () => {
        const rows = [
            {
                ...turn({ id: "turn:t1", seq: 1, role: "user", text_excerpt: "fix the parser" }),
                session: "session:⟨0a1b⟩",
                repository: "repository:github_com_necmttn_ax",
                cwd: "/Users/necmttn/Projects/ax",
            },
            {
                ...turn({ id: "turn:t2", seq: 2, role: "assistant", text_excerpt: "done" }),
                session: { tb: "session", id: "0a1b" },
            },
        ];
        const bundles = groupTurnsBySession(rows);
        expect(bundles).toHaveLength(1);
        expect(bundles[0]).toMatchObject({
            sessionId: "0a1b",
            repositoryKey: "github_com_necmttn_ax",
            checkoutKey: null,
            cwd: "/Users/necmttn/Projects/ax",
        });
        expect(bundles[0]!.turns).toHaveLength(2);
    });
});

describe("shouldDeriveAllTimeSkillPairs", () => {
    test("skips all-time skill pair aggregate updates for since-scoped derives", () => {
        expect(shouldDeriveAllTimeSkillPairs(undefined)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(0)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(1)).toBe(false);
    });
});
```

- [ ] **Step 5: Run the suite - characterization tests must pass against the monolith as-is**

Run: `bun test apps/axctl/src/ingest/signals/core.test.ts`
Expected: PASS. If any assertion fails, the assertion is wrong (it mis-states current behavior) - fix the TEST, never the monolith, and re-read the relevant lines of `derive-signals.ts`.

- [ ] **Step 6: Delete the superseded satellite test**

Delete `apps/axctl/src/ingest/evidence-derivation.test.ts` (its 3 cases are ported verbatim into the `tool-call derivers` / `shouldDeriveAllTimeSkillPairs` blocks above).

- [ ] **Step 7: Full gate + commit**

Run: `bun test apps/axctl/src/ingest` and `bun run typecheck` → PASS/clean.

```
test(ingest): characterize signal derivation rules against derive-signals internals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: `signals/types.ts` - evidence + signal shapes

**Files:**
- Create: `apps/axctl/src/ingest/signals/types.ts`
- Modify: `apps/axctl/src/ingest/derive-signals.ts` (delete type decls at lines 79–173, 410–433, 519–532; import + re-export from the new module)

- [ ] **Step 1: Move the types verbatim**

Cut from `derive-signals.ts` into `signals/types.ts` (keep JSDoc comments): `RecordRefLike`, `JsonRecord`, `ToolCallLike`, `DerivedFrictionEvent`, `DerivedDiagnosticEvent`, `TurnRow`, `SessionTurns`, `CorrectionEdge`, `ProposedEdge`, `SkillPairAccum`, `RecoveryEdge` - all `export`ed. The only import the file needs:

```ts
import type { TimestampInput } from "@ax/lib/shared/derive-keys";
```

Also add the two new aggregate types the core will produce (used from Task 4 on):

```ts
/** Everything the derivation core needs to run - the typed mirror of the
 *  three SELECTs in derive-signals.ts. */
export interface SignalEvidence {
    readonly bundles: ReadonlyArray<SessionTurns>;
    readonly skillNames: ReadonlyArray<string>;
    readonly failedToolCalls: ReadonlyArray<ToolCallLike>;
}

/** Everything the core derives - the typed input of signals/statements.ts. */
export interface DerivedSignals {
    readonly corrections: CorrectionEdge[];
    readonly proposed: ProposedEdge[];
    readonly recoveries: RecoveryEdge[];
    readonly skillPairs: SkillPairAccum[];
    readonly skillPairEdgeIds: string[];
    readonly frictionEvents: DerivedFrictionEvent[];
    readonly diagnosticEvents: DerivedDiagnosticEvent[];
    readonly turnCount: number;
}
```

- [ ] **Step 2: Re-import in `derive-signals.ts`**

```ts
import type {
    CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent, JsonRecord,
    ProposedEdge, RecordRefLike, RecoveryEdge, SessionTurns, SkillPairAccum,
    ToolCallLike, TurnRow,
} from "./signals/types.ts";
export type { DerivedDiagnosticEvent, DerivedFrictionEvent, SessionTurns, SkillPairAccum, ToolCallLike, TurnRow } from "./signals/types.ts";
```

(The transitional re-export keeps `signals/core.test.ts`'s `from "../derive-signals.ts"` type imports compiling; it gets pruned in Task 5.)

- [ ] **Step 3: Verify + commit**

Run: `bun test apps/axctl/src/ingest/signals apps/axctl/src/ingest/derive-signals.stage.test.ts` → PASS; `bun run typecheck` → clean.

```
refactor(ingest): extract signal evidence and edge types into signals/types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 3: `signals/statements.ts` - pure write-statement builders (golden tests first)

**Files:**
- Create: `apps/axctl/src/ingest/signals/statements.test.ts`
- Create: `apps/axctl/src/ingest/signals/statements.ts`
- Modify: `apps/axctl/src/ingest/derive-signals.ts` (rewire `upsertCorrections` 710–719, `markWasCorrected` 734–759, `upsertProposed` 761–770, `upsertSkillPairs` 778–787, `upsertRecovered` 789–800, `upsertFrictionEvents` 802–820, `upsertDiagnosticEvents` 822–841)

- [ ] **Step 1: Write the golden-string tests (RED - module doesn't exist yet)**

Create `apps/axctl/src/ingest/signals/statements.test.ts`. Builders take edge/event structs, so keys are plain literals here - no hashing needed. Full content:

```ts
import { describe, expect, test } from "bun:test";
import type { CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent } from "./types.ts";
import {
    buildCorrectedByStatements,
    buildDiagnosticEventStatements,
    buildFrictionEventStatements,
    buildProposedStatements,
    buildRecoveredStatements,
    buildSkillPairStatements,
    buildWasCorrectedStatements,
    correctedInvokedTurnKeys,
} from "./statements.ts";

const correction: CorrectionEdge = {
    fromTurnKey: "s1__seq_000003",
    toTurnKey: "s1__seq_000005",
    pattern: "no",
    text: "no, wrong file",
    ts: "2026-06-01T10:00:30.000Z",
    repositoryKey: null,
    checkoutKey: null,
    cwd: null,
    correctedSession: "0a1b-2c3d",
    correctedSeq: 3,
};

describe("buildCorrectedByStatements", () => {
    test("idempotent RELATE with deterministic from__to edge id", () => {
        expect(buildCorrectedByStatements([correction])).toEqual([
            'RELATE turn:`s1__seq_000003` -> corrected_by:`s1__seq_000003__s1__seq_000005` -> turn:`s1__seq_000005` SET pattern = "no", ts = d"2026-06-01T10:00:30.000Z";',
        ]);
    });

    test("empty in, empty out", () => {
        expect(buildCorrectedByStatements([])).toEqual([]);
    });
});

describe("correctedInvokedTurnKeys + buildWasCorrectedStatements", () => {
    test("expands the inclusive [seq-3, seq] window on the dash-stripped session, clamped at 1", () => {
        // correctedSeq 3 -> lo = max(1, 0) = 1 -> seqs 1..3
        expect(correctedInvokedTurnKeys([correction])).toEqual([
            "0a1b2c3d_1",
            "0a1b2c3d_2",
            "0a1b2c3d_3",
        ]);
    });

    test("overlapping corrections dedupe to one UPDATE per turn", () => {
        const keys = correctedInvokedTurnKeys([correction, { ...correction, correctedSeq: 4 }]);
        expect(keys).toEqual(["0a1b2c3d_1", "0a1b2c3d_2", "0a1b2c3d_3", "0a1b2c3d_4"]);
        expect(buildWasCorrectedStatements(keys)[0]).toBe(
            "UPDATE invoked SET was_corrected = true WHERE in = turn:`0a1b2c3d_1` RETURN NONE;",
        );
        expect(buildWasCorrectedStatements(keys)).toHaveLength(4);
    });
});

describe("buildProposedStatements", () => {
    test("RELATE turn -> proposed -> skill with ts + context excerpt", () => {
        expect(
            buildProposedStatements([
                {
                    fromTurnKey: "s1__seq_000002",
                    skillKey: "superpowers__test_driven_development",
                    skillName: "superpowers:test-driven-development",
                    ts: "2026-06-01T10:00:00.000Z",
                    contextExcerpt: "Run superpowers:test-driven-development first.",
                },
            ]),
        ).toEqual([
            'RELATE turn:`s1__seq_000002` -> proposed:`s1__seq_000002__superpowers__test_driven_development` -> skill:`superpowers__test_driven_development` SET ts = d"2026-06-01T10:00:00.000Z", context_excerpt = "Run superpowers:test-driven-development first.";',
        ]);
    });
});

describe("buildSkillPairStatements", () => {
    test("RELATE skill -> skill_paired -> skill with count + last_seen, ids supplied in parallel", () => {
        expect(
            buildSkillPairStatements(
                [{ fromKey: "a_skill", toKey: "b_skill", count: 3, lastSeen: "2026-06-01T10:02:00.000Z" }],
                ["a_skill__b_skill__deadbeef1234"],
            ),
        ).toEqual([
            'RELATE skill:`a_skill` -> skill_paired:`a_skill__b_skill__deadbeef1234` -> skill:`b_skill` SET count = 3, last_seen = d"2026-06-01T10:02:00.000Z";',
        ]);
    });
});

describe("buildRecoveredStatements", () => {
    test("RELATE turn -> recovered_by -> skill with error excerpt", () => {
        expect(
            buildRecoveredStatements([
                {
                    fromTurnKey: "s1__seq_000002",
                    skillKey: "diagnose",
                    skillName: "diagnose",
                    ts: "2026-06-01T10:01:00.000Z",
                    errorExcerpt: "TypeError: x is not a function",
                },
            ]),
        ).toEqual([
            'RELATE turn:`s1__seq_000002` -> recovered_by:`s1__seq_000002__diagnose` -> skill:`diagnose` SET ts = d"2026-06-01T10:01:00.000Z", error_excerpt = "TypeError: x is not a function";',
        ]);
    });

    test("missing excerpt serializes as NONE", () => {
        const [stmt] = buildRecoveredStatements([
            { fromTurnKey: "s1__seq_000002", skillKey: "diagnose", skillName: "diagnose", ts: "2026-06-01T10:01:00.000Z", errorExcerpt: undefined },
        ]);
        expect(stmt).toContain("error_excerpt = NONE;");
    });
});

const frictionEvent: DerivedFrictionEvent = {
    key: "tool_error__abc__call_1",
    kind: "tool_error",
    sessionId: "abc",
    turnKey: "abc_7",
    text: "Expected 1 failure",
    labels: { source: "derive_signals" },
    metrics: { confidence: 1 },
    raw: { status: "error" },
    ts: "2026-05-09T10:00:00.000Z",
};

describe("buildFrictionEventStatements", () => {
    test("UPSERT ... MERGE with JSON-text labels/metrics/raw (exact golden)", () => {
        expect(buildFrictionEventStatements([frictionEvent])).toEqual([
            'UPSERT friction_event:`tool_error__abc__call_1` MERGE { session: session:`abc`, turn: turn:`abc_7`, kind: "tool_error", text: "Expected 1 failure", labels: "{\\"source\\":\\"derive_signals\\"}", metrics: "{\\"confidence\\":1}", raw: "{\\"status\\":\\"error\\"}", ts: d"2026-05-09T10:00:00.000Z" };',
        ]);
    });

    test("null session/turn serialize as NONE", () => {
        const [stmt] = buildFrictionEventStatements([{ ...frictionEvent, sessionId: null, turnKey: null }]);
        expect(stmt).toContain("session: NONE, turn: NONE,");
    });
});

describe("buildDiagnosticEventStatements", () => {
    test("UPSERT ... MERGE carries status between kind and text", () => {
        const event: DerivedDiagnosticEvent = { ...frictionEvent, key: "tool_failure__abc__call_1", kind: "tool_failure", status: "error" };
        const [stmt] = buildDiagnosticEventStatements([event]);
        expect(stmt).toContain("UPSERT diagnostic_event:`tool_failure__abc__call_1` MERGE { ");
        expect(stmt).toContain('kind: "tool_failure", status: "error", text: "Expected 1 failure"');
        expect(stmt).toContain('ts: d"2026-05-09T10:00:00.000Z" };');
    });
});
```

- [ ] **Step 2: Run - confirm RED**

Run: `bun test apps/axctl/src/ingest/signals/statements.test.ts`
Expected: FAIL (cannot resolve `./statements.ts`).

- [ ] **Step 3: Implement `signals/statements.ts` by MOVING the templates verbatim**

The statement-template expressions are cut from the `upsert*` bodies - do not "improve" them (e.g. don't swap `d"${e.ts}"` for `surrealDate(e.ts)`; equivalence is incidental, verbatim is the guarantee). Full content:

```ts
/**
 * Pure SurrealQL statement builders for the signals stage. The derivation
 * core (./core.ts) produces edge/event specs; this module turns each batch
 * into idempotent statements. RELATE with a deterministic edge record-id
 * overwrites in place on re-run (SurrealDB rejects UPSERT on RELATION
 * tables); friction/diagnostic events use UPSERT..MERGE on deterministic
 * keys. All text literals route through @ax/lib/shared/surql.
 */
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import type {
    CorrectionEdge,
    DerivedDiagnosticEvent,
    DerivedFrictionEvent,
    ProposedEdge,
    RecoveryEdge,
    SkillPairAccum,
} from "./types.ts";

/**
 * Build a deterministic edge record-id so re-runs upsert instead of
 * duplicating. Surreal record-ids escape via backticks, so we strip out the
 * `turn:` prefix and join the two raw keys.
 */
export function correctedByEdgeId(fromTurnKey: string, toTurnKey: string): string {
    return `${fromTurnKey}__${toTurnKey}`;
}

export function proposedEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

export function recoveredByEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

export const buildCorrectedByStatements = (edges: readonly CorrectionEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = correctedByEdgeId(e.fromTurnKey, e.toTurnKey);
        return `RELATE turn:\`${e.fromTurnKey}\` -> corrected_by:\`${edgeId}\` -> turn:\`${e.toTurnKey}\` SET pattern = ${surrealString(e.pattern)}, ts = d"${e.ts}";`;
    });

/**
 * Expand correction edges into the turn keys whose `invoked` edges must be
 * marked `was_corrected = true`: every turn in `[correctedSeq - 3,
 * correctedSeq]` (inclusive both ends) of the corrected session. Mirrors the
 * original SurrealQL predicate `in.seq >= $parent.in.seq AND in.seq <=
 * $parent.in.seq + 3` (issue #31). Overlapping corrections dedupe via the
 * Set so exactly one UPDATE is issued per turn.
 */
export const correctedInvokedTurnKeys = (edges: readonly CorrectionEdge[]): string[] => {
    const turnsToMark = new Set<string>();
    for (const e of edges) {
        const lo = Math.max(1, e.correctedSeq - 3);
        const hi = e.correctedSeq;
        for (let seq = lo; seq <= hi; seq += 1) {
            // turnRecordKey strips `-` from session id; replicate inline
            // (separate file so we can't import the private helper).
            const sess = e.correctedSession.replace(/-/g, "");
            turnsToMark.add(`${sess}_${seq}`);
        }
    }
    return [...turnsToMark];
};

export const buildWasCorrectedStatements = (turnKeys: readonly string[]): string[] =>
    turnKeys.map(
        (turnKey) =>
            `UPDATE invoked SET was_corrected = true WHERE in = turn:\`${turnKey}\` RETURN NONE;`,
    );

export const buildProposedStatements = (edges: readonly ProposedEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = proposedEdgeId(e.fromTurnKey, e.skillKey);
        return `RELATE turn:\`${e.fromTurnKey}\` -> proposed:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", context_excerpt = ${surrealString(e.contextExcerpt)};`;
    });

export const buildSkillPairStatements = (
    pairs: readonly SkillPairAccum[],
    edgeIds: readonly string[],
): string[] =>
    pairs.map((p, i) => {
        const edgeId = edgeIds[i];
        return `RELATE skill:\`${p.fromKey}\` -> skill_paired:\`${edgeId}\` -> skill:\`${p.toKey}\` SET count = ${p.count}, last_seen = d"${p.lastSeen}";`;
    });

export const buildRecoveredStatements = (edges: readonly RecoveryEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = recoveredByEdgeId(e.fromTurnKey, e.skillKey);
        const excerpt = e.errorExcerpt == null ? "NONE" : surrealString(e.errorExcerpt);
        return `RELATE turn:\`${e.fromTurnKey}\` -> recovered_by:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", error_excerpt = ${excerpt};`;
    });

export const buildFrictionEventStatements = (
    events: readonly DerivedFrictionEvent[],
): string[] =>
    events.map(
        (event) =>
            `UPSERT ${recordRef("friction_event", event.key)} MERGE ${surrealObject([
                ["session", surrealOptionRecord("session", event.sessionId)],
                ["turn", surrealOptionRecord("turn", event.turnKey)],
                ["kind", surrealString(event.kind)],
                ["text", surrealOptionString(event.text)],
                ["labels", surrealJsonTextOption(event.labels)],
                ["metrics", surrealJsonTextOption(event.metrics)],
                ["raw", surrealJsonTextOption(event.raw)],
                ["ts", surrealDate(event.ts)],
            ])};`,
    );

export const buildDiagnosticEventStatements = (
    events: readonly DerivedDiagnosticEvent[],
): string[] =>
    events.map(
        (event) =>
            `UPSERT ${recordRef("diagnostic_event", event.key)} MERGE ${surrealObject([
                ["session", surrealOptionRecord("session", event.sessionId)],
                ["turn", surrealOptionRecord("turn", event.turnKey)],
                ["kind", surrealString(event.kind)],
                ["status", surrealOptionString(event.status)],
                ["text", surrealOptionString(event.text)],
                ["labels", surrealJsonTextOption(event.labels)],
                ["metrics", surrealJsonTextOption(event.metrics)],
                ["raw", surrealJsonTextOption(event.raw)],
                ["ts", surrealDate(event.ts)],
            ])};`,
    );
```

- [ ] **Step 4: Run - GREEN**

Run: `bun test apps/axctl/src/ingest/signals/statements.test.ts` → PASS. If a golden string differs, diff it character-by-character against the moved template - the TEMPLATE must stay verbatim; fix the golden only if you mis-transcribed it from the old `upsert*` body.

- [ ] **Step 5: Rewire `derive-signals.ts` writes through the builders**

Delete the duplicated edge-id functions (lines 51–77) and the statement-template bodies; each `upsert*` becomes a thin executor. Pattern (apply to all seven):

```ts
import {
    buildCorrectedByStatements, buildDiagnosticEventStatements,
    buildFrictionEventStatements, buildProposedStatements,
    buildRecoveredStatements, buildSkillPairStatements,
    buildWasCorrectedStatements, correctedInvokedTurnKeys,
} from "./signals/statements.ts";

const upsertCorrections = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildCorrectedByStatements(edges), { chunkSize: 500 });
    });

const markWasCorrected = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        yield* executeStatementsWith(db, buildWasCorrectedStatements(correctedInvokedTurnKeys(edges)), { chunkSize: 500 });
    });
```

(`executeStatementsWith` returns `Effect.void` for empty arrays - the old `if (edges.length === 0) return` guards are subsumed.) The `recordRef` import from `./evidence-writers.ts` and the `surrealDate/surrealJsonTextOption/surrealObject/surrealOptionRecord/surrealOptionString/surrealString` imports become unused in `derive-signals.ts` - remove them.

- [ ] **Step 6: Full gate + commit**

Run: `bun test apps/axctl/src/ingest` (characterization suite + stage test + the rest stay green) and `bun run typecheck`.

```
refactor(ingest): pure SurrealQL statement builders for signal writes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 4: `signals/core.ts` - move the derivation core, flip the harness

**Files:**
- Create: `apps/axctl/src/ingest/signals/core.ts`
- Modify: `apps/axctl/src/ingest/derive-signals.ts` (remove moved code; import from `./signals/core.ts`)
- Modify: `apps/axctl/src/ingest/signals/core.test.ts` (import path flip ONLY)

- [ ] **Step 1: Create `signals/core.ts` by moving these verbatim from `derive-signals.ts`**

Module header + moved members (all bodies byte-identical to the monolith; only `import` lines are new):

```ts
/**
 * Pure signal-derivation core: typed evidence rows in -> Friction Event /
 * Diagnostic Event records + edge specs out. No Effect, no SurrealClient -
 * every classification rule here is exercised by core.test.ts on fixture
 * rows shaped like real transcripts. This is where signal-quality bugs live;
 * keep new rules here, not in the stage wiring.
 */
import { skillRecordKey } from "@ax/lib/skill-id";
import {
    isoTimestamp,
    nonEmptyString,
    recordKeyPart,
    safeKeyPart,
} from "@ax/lib/shared/derive-keys";
import type {
    CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent,
    DerivedSignals, JsonRecord, ProposedEdge, RecoveryEdge, SessionTurns,
    SignalEvidence, SkillPairAccum, ToolCallLike, TurnRow,
} from "./types.ts";
```

Moved members: `NEGATION_PATTERNS`, `CORRECTION_WINDOW_CHARS`, `matchNegation`, `skillPairedEdgeId` (the only edge-id fn the CORE needs - it shapes the accumulation key; `correctedByEdgeId`/`proposedEdgeId`/`recoveredByEdgeId` already live in `statements.ts`), `PAIR_WINDOW`, `RECOVERY_WINDOW`, `shouldDeriveAllTimeSkillPairs`, `compactRecord`, `recordLabel`, `rawTurnKey`, `tsToIso`, `toolCallStableKey`, `callString`, `callNumber`, `toolNameFromTool`, `toolTargetName`, `toolEvidenceText`, `isFailedToolCall`, `toolCallLabels`, `toolCallMetrics`, `toolCallRaw`, `deriveFrictionFromToolCalls`, `deriveDiagnosticsFromToolCalls`, `groupTurnsBySession`, `deriveCorrections`, `deriveProposed`, `deriveSkillPairs`, `deriveRecovered`, `deriveFrictionFromCorrections`. Keep every JSDoc comment. Export everything `core.test.ts` imports; the small leaf helpers (`callString`, `compactRecord`, ...) may stay private.

- [ ] **Step 2: Add the whole-evidence composition (new code, built ONLY from the moved functions)**

Append to `core.ts`:

```ts
/**
 * Whole-evidence composition of the per-rule derivers. The stage loop in
 * derive-signals.ts calls the same per-bundle functions one bundle at a time
 * (it interleaves progress effects); this composition exists for tests and
 * any future consumer that has all evidence in hand. Both paths share the
 * rule implementations, so they cannot drift.
 */
export function deriveSignalsFromEvidence(
    evidence: SignalEvidence,
    opts: { readonly includeSkillPairs: boolean },
): DerivedSignals {
    const corrections: CorrectionEdge[] = [];
    const proposed: ProposedEdge[] = [];
    const recoveries: RecoveryEdge[] = [];
    const pairsAccum = new Map<string, SkillPairAccum>();
    let turnCount = 0;
    for (const bundle of evidence.bundles) {
        turnCount += bundle.turns.length;
        corrections.push(...deriveCorrections(bundle));
        proposed.push(...deriveProposed(bundle, evidence.skillNames));
        recoveries.push(...deriveRecovered(bundle));
        deriveSkillPairs(bundle, pairsAccum);
    }
    const frictionEvents = [
        ...deriveFrictionFromToolCalls(evidence.failedToolCalls),
        ...deriveFrictionFromCorrections(corrections),
    ];
    const diagnosticEvents = deriveDiagnosticsFromToolCalls(evidence.failedToolCalls);
    return {
        corrections,
        proposed,
        recoveries,
        skillPairs: opts.includeSkillPairs ? [...pairsAccum.values()] : [],
        skillPairEdgeIds: opts.includeSkillPairs ? [...pairsAccum.keys()] : [],
        frictionEvents,
        diagnosticEvents,
        turnCount,
    };
}
```

- [ ] **Step 3: Flip the characterization harness - THE before/after check**

In `signals/core.test.ts`, change ONLY the import declarations: value imports `from "../derive-signals.ts"` → `from "./core.ts"`; type imports (`SessionTurns`, `SkillPairAccum`, `ToolCallLike`, `TurnRow`) → `from "./types.ts"`. Zero assertion edits.

Run: `bun test apps/axctl/src/ingest/signals/core.test.ts` → PASS. A failure here means the move was not verbatim - diff `core.ts` against the pre-move `derive-signals.ts` (git) and fix the MOVE, never the test.

- [ ] **Step 4: Point `derive-signals.ts` at the core**

Delete the moved members from `derive-signals.ts`; import what the stage loop still calls:

```ts
import {
    deriveCorrections, deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections, deriveFrictionFromToolCalls,
    deriveProposed, deriveRecovered, deriveSkillPairs,
    groupTurnsBySession, shouldDeriveAllTimeSkillPairs,
} from "./signals/core.ts";
```

Run: `bun test apps/axctl/src/ingest` and `bun run typecheck` → green/clean.

- [ ] **Step 5: Commit**

```
refactor(ingest): move signal derivation core into signals/core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 5: Shrink `derive-signals.ts` to stage wiring

**Files:**
- Modify: `apps/axctl/src/ingest/derive-signals.ts` (target ~230 LOC)

- [ ] **Step 1: Final layout of `derive-signals.ts`**

Keep, in order - moving the stage imports currently stranded at line 983 (`./stage/types.ts`, `./stage/registry.ts`) up to the top of the file (they were import-hoisted anyway; placement is cosmetic):

1. Imports: `Effect, Schema` from `effect`; `SurrealClient` from `@ax/lib/db`; `AppLayer`; `DbError`; `executeStatementsWith`; the core + statements + types imports from Tasks 3–4; stage types/registry.
2. `fetchSessionTurns` - SQL string UNCHANGED (lines 356–371), body ends `return groupTurnsBySession(rows);`.
3. `fetchSkillNames` - unchanged (660–667).
4. `fetchFailedToolCalls` - SQL string UNCHANGED (675–698).
5. `DeriveStats`, `DeriveOpts` - unchanged (843–857).
6. `deriveSignals` - same per-bundle loop and progress cadence, writes inlined through builders:

```ts
export const deriveSignals = (
    opts: Partial<DeriveOpts> = {},
): Effect.Effect<DeriveStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const skillNames = yield* fetchSkillNames();
        const bundles = yield* fetchSessionTurns(opts.sinceDays);
        if (opts.onProgress) yield* opts.onProgress({ sessions: bundles.length });

        let corrections = 0;
        let proposed = 0;
        let turnCount = 0;
        let recoveries = 0;

        const correctionBatch: CorrectionEdge[] = [];
        const proposedBatch: ProposedEdge[] = [];
        const recoveryBatch: RecoveryEdge[] = [];
        const pairsAccum = new Map<string, SkillPairAccum>();

        for (const [index, bundle] of bundles.entries()) {
            turnCount += bundle.turns.length;
            const c = deriveCorrections(bundle);
            const p = deriveProposed(bundle, skillNames);
            const r = deriveRecovered(bundle);
            corrections += c.length;
            proposed += p.length;
            recoveries += r.length;
            correctionBatch.push(...c);
            proposedBatch.push(...p);
            recoveryBatch.push(...r);
            deriveSkillPairs(bundle, pairsAccum);
            if (opts.onProgress && (index < 5 || (index + 1) % 50 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: bundles.length,
                    sessions: index + 1,
                    turns: turnCount,
                    corrections,
                    proposed,
                    recoveries,
                    skillPairs: pairsAccum.size,
                });
            }
        }

        const shouldWriteSkillPairs = shouldDeriveAllTimeSkillPairs(opts.sinceDays);
        const pairsList = shouldWriteSkillPairs ? [...pairsAccum.values()] : [];
        const pairEdgeIds = shouldWriteSkillPairs ? [...pairsAccum.keys()] : [];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
                turns: turnCount,
                corrections,
                proposed,
                recoveries,
                skillPairs: pairsList.length,
            });
        }
        const failedToolCalls = yield* fetchFailedToolCalls(opts.sinceDays);
        const frictionBatch = [
            ...deriveFrictionFromToolCalls(failedToolCalls),
            ...deriveFrictionFromCorrections(correctionBatch),
        ];
        const diagnosticBatch = deriveDiagnosticsFromToolCalls(failedToolCalls);
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
                turns: turnCount,
                corrections,
                proposed,
                recoveries,
                skillPairs: pairsList.length,
                frictionEvents: frictionBatch.length,
                diagnosticEvents: diagnosticBatch.length,
            });
        }

        // Write order is load-bearing (was_corrected denormalises onto edges
        // upserted by the corrections statement batch). chunkSize 500 matches
        // the pre-split executor calls.
        const exec = (stmts: readonly string[]) =>
            executeStatementsWith(db, stmts, { chunkSize: 500 });
        yield* exec(buildCorrectedByStatements(correctionBatch));
        yield* exec(buildWasCorrectedStatements(correctedInvokedTurnKeys(correctionBatch)));
        yield* exec(buildProposedStatements(proposedBatch));
        if (shouldWriteSkillPairs) {
            yield* exec(buildSkillPairStatements(pairsList, pairEdgeIds));
        }
        yield* exec(buildRecoveredStatements(recoveryBatch));
        yield* exec(buildFrictionEventStatements(frictionBatch));
        yield* exec(buildDiagnosticEventStatements(diagnosticBatch));

        yield* Effect.logDebug("signals derived", {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        });
        return {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
        };
    });
```

7. `import.meta.main` block - unchanged (968–977; the LaunchAgent invokes this file directly).
8. `SignalsKey`, `SignalsStats`, `signalsStage` - unchanged (986–1018).

Delete: the seven `upsert*` wrappers (now inlined), the transitional type re-exports from Task 2 (the test now imports from `./signals/types.ts`), and any now-unused imports. `derive-signals.ts` keeps NO derivation logic and NO statement templates.

- [ ] **Step 2: Verify the slim-down didn't drop anything**

Run: `rg -n "NEGATION_PATTERNS|matchNegation|RELATE |UPSERT friction_event|UPSERT diagnostic_event" apps/axctl/src/ingest/derive-signals.ts` → no matches.
Run: `wc -l apps/axctl/src/ingest/derive-signals.ts` → ≤ ~260.
Run: `bun test apps/axctl/src/ingest` → PASS (incl. `derive-signals.stage.test.ts` and `stage/registry.test.ts` untouched).
Run: `bun run typecheck` → clean.

- [ ] **Step 3: Commit**

```
refactor(ingest): shrink derive-signals to stage wiring (read -> derive -> write)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 6: End-to-end pure pipeline test + verification

**Files:**
- Create: `apps/axctl/src/ingest/signals/derive-pipeline.test.ts`

- [ ] **Step 1: Write the cross-module test (RED only if Tasks 4–5 broke composition)**

```ts
import { describe, expect, test } from "bun:test";
import { skillRecordKey } from "@ax/lib/skill-id";
import { deriveSignalsFromEvidence } from "./core.ts";
import {
    buildCorrectedByStatements,
    buildDiagnosticEventStatements,
    buildFrictionEventStatements,
    buildProposedStatements,
    buildRecoveredStatements,
    buildSkillPairStatements,
    buildWasCorrectedStatements,
    correctedInvokedTurnKeys,
} from "./statements.ts";
import type { SessionTurns, ToolCallLike } from "./types.ts";

// One Claude-shaped session exercising every rule at once:
//   seq 1 user task -> seq 2 assistant proposes a skill + errors ->
//   seq 3 assistant invokes diagnose (recovery + pair partner) ->
//   seq 4 assistant invokes commit (pairs with diagnose) ->
//   seq 5 tool_result user turn (no text) -> seq 6 user pushback ("no").
const session: SessionTurns = {
    sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
    repositoryKey: "github_com_necmttn_ax",
    checkoutKey: null,
    cwd: "/Users/necmttn/Projects/ax",
    turns: [
        { id: { tb: "turn", id: "s1_1" }, seq: 1, role: "user", text_excerpt: "fix the failing ingest test", ts: "2026-06-01T10:00:00.000Z", has_error: false, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_2" }, seq: 2, role: "assistant", text_excerpt: "I'd start with superpowers:systematic-debugging here. TypeError: x is not a function", ts: "2026-06-01T10:00:10.000Z", has_error: true, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_3" }, seq: 3, role: "assistant", text_excerpt: "running diagnose", ts: "2026-06-01T10:00:20.000Z", has_error: false, invoked_skills: ["diagnose"] },
        { id: { tb: "turn", id: "s1_4" }, seq: 4, role: "assistant", text_excerpt: "committing", ts: "2026-06-01T10:00:30.000Z", has_error: false, invoked_skills: ["commit"] },
        { id: { tb: "turn", id: "s1_5" }, seq: 5, role: "user", text_excerpt: undefined, ts: "2026-06-01T10:00:40.000Z", has_error: false, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_6" }, seq: 6, role: "user", text_excerpt: "no - you fixed the wrong test", ts: "2026-06-01T10:00:50.000Z", has_error: false, invoked_skills: [] },
    ],
};

const failedToolCalls: ToolCallLike[] = [
    {
        id: "tool_call:s1__call_1",
        session: "session:0a1b2c3d-1111-2222-3333-444455556666",
        turn: "turn:s1_2",
        name: "exec_command",
        command_norm: "bun test",
        error_text: "TypeError: x is not a function",
        exit_code: 1,
        has_error: true,
        ts: "2026-06-01T10:00:10.000Z",
    },
];

describe("deriveSignalsFromEvidence -> statement builders (stage write order)", () => {
    test("full pipeline on one realistic session", () => {
        const derived = deriveSignalsFromEvidence(
            {
                bundles: [session],
                skillNames: ["superpowers:systematic-debugging", "diagnose", "commit"],
                failedToolCalls,
            },
            { includeSkillPairs: true },
        );

        expect(derived.turnCount).toBe(6);
        // rule 1: pushback at seq 6 anchored to the assistant turn at seq 4
        expect(derived.corrections).toHaveLength(1);
        expect(derived.corrections[0]).toMatchObject({ fromTurnKey: "s1_4", toTurnKey: "s1_6", pattern: "no", correctedSeq: 4 });
        // rule 4: mentioned superpowers:systematic-debugging, never invoked it
        expect(derived.proposed).toHaveLength(1);
        expect(derived.proposed[0]).toMatchObject({ fromTurnKey: "s1_2", skillKey: skillRecordKey("superpowers:systematic-debugging") });
        // rule 6: error at seq 2 recovered by diagnose at seq 3
        expect(derived.recoveries).toHaveLength(1);
        expect(derived.recoveries[0]).toMatchObject({ fromTurnKey: "s1_2", skillKey: skillRecordKey("diagnose") });
        // rule 5: diagnose (seq 3) + commit (seq 4) pair within the window
        expect(derived.skillPairs).toHaveLength(1);
        expect(derived.skillPairs[0]).toMatchObject({ count: 1, lastSeen: "2026-06-01T10:00:30.000Z" });
        // rules 3 + 7: one tool_error + one user_correction friction
        expect(derived.frictionEvents.map((e) => e.kind).sort()).toEqual(["tool_error", "user_correction"]);
        // rule 8: one diagnostic
        expect(derived.diagnosticEvents).toHaveLength(1);
        expect(derived.diagnosticEvents[0]?.kind).toBe("tool_failure");

        // statement layer, in stage write order
        const stmts = [
            ...buildCorrectedByStatements(derived.corrections),
            ...buildWasCorrectedStatements(correctedInvokedTurnKeys(derived.corrections)),
            ...buildProposedStatements(derived.proposed),
            ...buildSkillPairStatements(derived.skillPairs, derived.skillPairEdgeIds),
            ...buildRecoveredStatements(derived.recoveries),
            ...buildFrictionEventStatements(derived.frictionEvents),
            ...buildDiagnosticEventStatements(derived.diagnosticEvents),
        ];
        // 1 corrected_by + 4 was_corrected (seqs 1..4) + 1 proposed + 1 pair
        // + 1 recovered + 2 friction + 1 diagnostic
        expect(stmts).toHaveLength(11);
        expect(stmts[0]).toContain("-> corrected_by:`s1_4__s1_6` ->");
        expect(stmts.filter((s) => s.startsWith("UPDATE invoked SET was_corrected = true"))).toHaveLength(4);
        expect(stmts.filter((s) => s.startsWith("UPSERT friction_event:"))).toHaveLength(2);
        expect(stmts.filter((s) => s.startsWith("UPSERT diagnostic_event:"))).toHaveLength(1);
    });

    test("includeSkillPairs=false (since-scoped derive) suppresses pair writes only", () => {
        const derived = deriveSignalsFromEvidence(
            { bundles: [session], skillNames: [], failedToolCalls: [] },
            { includeSkillPairs: false },
        );
        expect(derived.skillPairs).toEqual([]);
        expect(derived.skillPairEdgeIds).toEqual([]);
        expect(derived.corrections).toHaveLength(1);
    });
});
```

Run: `bun test apps/axctl/src/ingest/signals/derive-pipeline.test.ts` → PASS.

- [ ] **Step 2: Full verification gate**

- `bun test apps/axctl/src/ingest` → PASS
- `bun test apps/axctl` → PASS (CLI command-name tests reference `derive-signals` as a string; nothing renamed)
- `bun run typecheck` → clean
- `rg -n "from \"./signals/" apps/axctl/src --glob '!ingest/signals/*'` → only `derive-signals.ts` (the stage is the sole production consumer of the seam)

- [ ] **Step 3 (optional, local DB available): live stats diff**

With `ax-watch` idle, on the pre-refactor commit run `bun apps/axctl/src/ingest/derive-signals.ts --since=7` and record the `signals derived` debug stats; repeat on the final commit. All eight counters must match (writes are deterministic idempotent upserts, so the double run is safe). Skip if the local DB is unavailable - the golden-statement layer already pins write behavior.

- [ ] **Step 4: Commit**

```
test(ingest): end-to-end signal derivation pipeline fixture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Self-review notes (for the executing agent)

- **No placeholders anywhere above**: every regex, edge-id template, fixture row, and golden string is taken from the current `derive-signals.ts` (verified against lines 20–34, 51–77, 196–206, 442–658, 710–841) or hand-derived from those templates. If a golden mismatches at runtime, trust the moved template over the plan's transcription and fix the test string.
- **Type drift watch**: `TurnRow.invoked_skills` is typed `ReadonlyArray<string>` but runtime rows can omit it - every consumer uses `?? []`; preserve that, don't make it `optional` (would ripple into fixtures).
- **`Bun.hash` stays**: `skillPairedEdgeId` and the `toolCallStableKey` fallback hash with `Bun.hash`; `core.ts` lives in `apps/axctl` and tests run under bun, so this is fine (same precedent: `safeKeyPart` in `@ax/lib/shared/derive-keys`).
- **Do NOT route progress through the core**: `onProgress` is an Effect; the per-bundle cadence (first 5, then every 50) must keep firing from the stage loop. `deriveSignalsFromEvidence` is the progress-free composition for tests.
- **Stage contract untouched** (ADR-0006): `SignalsKey`, deps `["claude","codex","pi","opencode","cursor","subagents","spawned","git"]`, tags `["derive"]`, `SignalsStats` fields - `derive-signals.stage.test.ts` enforces this and must never be edited by this plan.

## Open questions

None blocking. One deliberate choice to revisit later: `correctedInvokedTurnKeys` re-implements the private `turnRecordKey` dash-stripping inline (as the monolith already did, see its comment); unifying it with `@ax/lib`'s `turnRecordKey` would CHANGE keys (that one appends a digest + zero-padded seq) and is explicitly out of scope for a behavior-preserving split.
