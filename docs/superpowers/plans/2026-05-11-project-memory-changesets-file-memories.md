# Project Memory Changesets And File Memories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #64 by deriving durable `changeset` and `file_memory` records from existing session, commit, edit, touched-file, plan, tool-call, friction, and diagnostic evidence.

**Architecture:** Add a small `src/memory/` derivation layer that builds deterministic memory records and SQL statements without changing transcript or Git ingest formats. Wire it as an explicit `agentctl derive-memory` command first, then call it after `derive-signals` during normal ingest once focused tests and a smoke run prove idempotence. Keep the first pass deterministic and extractive; do not call an LLM or add embeddings.

**Tech Stack:** Bun, TypeScript, Effect, SurrealDB, existing record-id helpers, existing CLI telemetry stage wrappers.

---

## Scope Check

This plan addresses only #64:

- Populate `changeset`, `file_memory`, `includes`, and `involves`.
- Add query/CLI surfaces for recent memory and file memory.
- Mark memory schema tables active when writers exist.

This plan does not implement:

- `agentctl recall` (#65).
- Entity resolution (#66).
- Guidance lifecycle (#67).
- Dashboard product polish (#68).
- Code structure tracing (#69).
- OTEL/dev-run ingestion (#70).
- Broad Effect service-boundary refactors (#71).

## File Structure

- Create: `src/memory/keys.ts`
  - Deterministic keys for `changeset`, `file_memory`, `includes`, and `involves`.
- Create: `src/memory/derive.ts`
  - Pure derivation types and functions for commit-sourced/session-sourced memory.
- Create: `src/memory/sql.ts`
  - SQL statement builders and query builders for memory derivation and inspection.
- Create: `src/memory/derive.test.ts`
  - Pure derivation and idempotent key tests.
- Create: `src/memory/sql.test.ts`
  - Statement/query builder tests.
- Modify: `src/cli/index.ts`
  - Add `agentctl derive-memory [--since=DAYS]`.
  - Run memory derivation after `derive-signals` during full ingest.
- Modify: `src/queries/insights.ts`
  - Mark memory tables/relations as active.
  - Add memory insight query builders if the CLI uses the insights module.
- Modify: `src/queries/insights.test.ts`
  - Assert active schema stage and query SQL shape.
- Modify: `README.md`
  - Document `agentctl derive-memory` and the first memory query examples.

## Task 1: Deterministic Memory Keys

**Files:**
- Create: `src/memory/keys.ts`
- Test: `src/memory/derive.test.ts`

- [ ] **Step 1: Write failing key tests**

Create `src/memory/derive.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import {
    changesetKeyForCommit,
    changesetKeyForSession,
    fileMemoryKey,
    includesKey,
    involvesKey,
} from "./keys.ts";

describe("memory keys", () => {
    test("changeset keys are deterministic for commit and session evidence", () => {
        expect(changesetKeyForCommit("commit:`repo__abc123`")).toBe(
            changesetKeyForCommit("commit:`repo__abc123`"),
        );
        expect(changesetKeyForCommit("commit:`repo__abc123`")).not.toBe(
            changesetKeyForSession("session:`repo__abc123`"),
        );
    });

    test("file memory keys include changeset, file, and kind", () => {
        expect(fileMemoryKey({
            changesetKey: "commit__abc",
            fileKey: "file__src_index_ts",
            kind: "commit_summary",
        })).toBe(fileMemoryKey({
            changesetKey: "commit__abc",
            fileKey: "file__src_index_ts",
            kind: "commit_summary",
        }));
        expect(fileMemoryKey({
            changesetKey: "commit__abc",
            fileKey: "file__src_index_ts",
            kind: "commit_summary",
        })).not.toBe(fileMemoryKey({
            changesetKey: "commit__abc",
            fileKey: "file__src_index_ts",
            kind: "session_summary",
        }));
    });

    test("relation keys include both endpoints", () => {
        expect(includesKey("changeset__a", "file_memory__b")).toContain("changeset__a");
        expect(involvesKey("changeset__a", "file__b")).toContain("changeset__a");
        expect(includesKey("changeset__a", "file_memory__b")).not.toBe(
            includesKey("changeset__b", "file_memory__b"),
        );
    });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test src/memory/derive.test.ts`

Expected: fail because `src/memory/keys.ts` does not exist.

- [ ] **Step 3: Implement key helpers**

Create `src/memory/keys.ts`:

```ts
import { stableDigest, sanitizeRecordKeyPart } from "../lib/ids.ts";

function refPart(ref: string): string {
    return sanitizeRecordKeyPart(ref.replace(/^[a-z_]+:/, "").replace(/^`|`$/g, ""));
}

function shortHash(input: string): string {
    return stableDigest(input).slice(0, 16);
}

export function changesetKeyForCommit(commitRef: string): string {
    const part = refPart(commitRef).slice(0, 80);
    return `commit__${part}__${shortHash(commitRef)}`;
}

export function changesetKeyForSession(sessionRef: string): string {
    const part = refPart(sessionRef).slice(0, 80);
    return `session__${part}__${shortHash(sessionRef)}`;
}

export function fileMemoryKey(input: {
    readonly changesetKey: string;
    readonly fileKey: string;
    readonly kind: string;
}): string {
    const file = refPart(input.fileKey).slice(0, 80);
    return `${input.kind}__${file}__${shortHash(`${input.changesetKey}|${input.fileKey}|${input.kind}`)}`;
}

export function includesKey(changesetKey: string, fileMemoryKeyValue: string): string {
    return `${changesetKey.slice(0, 48)}__${fileMemoryKeyValue.slice(0, 48)}__${shortHash(`${changesetKey}|${fileMemoryKeyValue}`)}`;
}

export function involvesKey(changesetKey: string, fileKey: string): string {
    const file = refPart(fileKey).slice(0, 48);
    return `${changesetKey.slice(0, 48)}__${file}__${shortHash(`${changesetKey}|${fileKey}`)}`;
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `bun test src/memory/derive.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory/keys.ts src/memory/derive.test.ts
git commit -m "feat: add memory record keys"
```

## Task 2: Pure Memory Derivation

**Files:**
- Create: `src/memory/derive.ts`
- Modify: `src/memory/derive.test.ts`

- [ ] **Step 1: Add failing pure derivation tests**

Append to `src/memory/derive.test.ts`:

```ts
import { deriveCommitChangesetMemory, deriveSessionChangesetMemory } from "./derive.ts";

describe("memory derivation", () => {
    test("derives commit-sourced changeset and file memories", () => {
        const output = deriveCommitChangesetMemory({
            commitRef: "commit:`repo__abc123`",
            sessionRef: "session:`s1`",
            repositoryRef: "repository:`repo`",
            checkoutRef: "checkout:`co`",
            message: "fix: wire ingest telemetry",
            ts: "2026-05-11T00:00:00.000Z",
            files: [
                {
                    fileRef: "file:`repo__src_cli_index_ts`",
                    path: "src/cli/index.ts",
                    additions: 12,
                    deletions: 3,
                    status: "modified",
                },
            ],
            toolFailureCount: 2,
            planSnapshotCount: 1,
        });

        expect(output.changeset.summaryText).toBe("fix: wire ingest telemetry");
        expect(output.changeset.status).toBe("committed");
        expect(output.fileMemories).toHaveLength(1);
        expect(output.fileMemories[0]).toMatchObject({
            path: "src/cli/index.ts",
            kind: "commit_summary",
            text: "Committed fix: wire ingest telemetry; modified src/cli/index.ts (+12/-3).",
        });
        expect(output.involves).toHaveLength(1);
        expect(output.includes).toHaveLength(1);
    });

    test("derives provisional session changeset from edits when no commit exists", () => {
        const output = deriveSessionChangesetMemory({
            sessionRef: "session:`s2`",
            repositoryRef: "repository:`repo`",
            checkoutRef: "checkout:`co`",
            cwd: "/Users/necmttn/Projects/agentctl",
            startedAt: "2026-05-11T00:00:00.000Z",
            endedAt: "2026-05-11T00:10:00.000Z",
            editedFiles: [
                { fileRef: "file:`repo__README_md`", path: "README.md", editCount: 2 },
            ],
            toolFailureCount: 0,
            planSnapshotCount: 3,
        });

        expect(output.changeset.status).toBe("provisional");
        expect(output.changeset.summaryText).toContain("Session edited 1 file");
        expect(output.fileMemories[0]?.kind).toBe("session_summary");
    });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test src/memory/derive.test.ts`

Expected: fail because `src/memory/derive.ts` does not exist.

- [ ] **Step 3: Implement deterministic derivation**

Create `src/memory/derive.ts` with these exported shapes and functions:

```ts
import {
    changesetKeyForCommit,
    changesetKeyForSession,
    fileMemoryKey,
    includesKey,
    involvesKey,
} from "./keys.ts";

export interface MemoryChangeset {
    readonly key: string;
    readonly sessionRef: string | null;
    readonly repositoryRef: string | null;
    readonly checkoutRef: string | null;
    readonly summaryText: string;
    readonly detailText: string | null;
    readonly status: "committed" | "provisional";
    readonly labels: Record<string, unknown>;
    readonly metrics: Record<string, unknown>;
    readonly createdAt: string;
    readonly updatedAt: string | null;
}

export interface MemoryFileMemory {
    readonly key: string;
    readonly fileRef: string;
    readonly repositoryRef: string | null;
    readonly checkoutRef: string | null;
    readonly path: string;
    readonly kind: "commit_summary" | "session_summary";
    readonly text: string;
    readonly labels: Record<string, unknown>;
    readonly metrics: Record<string, unknown>;
    readonly createdAt: string;
}

export interface MemoryInvolves {
    readonly key: string;
    readonly changesetKey: string;
    readonly fileRef: string;
    readonly role: string;
    readonly labels: Record<string, unknown>;
    readonly ts: string;
}

export interface MemoryIncludes {
    readonly key: string;
    readonly changesetKey: string;
    readonly fileMemoryKey: string;
    readonly kind: string;
    readonly labels: Record<string, unknown>;
    readonly ts: string;
}

export interface DerivedMemoryBundle {
    readonly changeset: MemoryChangeset;
    readonly fileMemories: readonly MemoryFileMemory[];
    readonly involves: readonly MemoryInvolves[];
    readonly includes: readonly MemoryIncludes[];
}
```

Implement `deriveCommitChangesetMemory` and `deriveSessionChangesetMemory` using only the input data described in the tests. Keep the text intentionally simple and deterministic:

- Commit summary: first non-empty commit message line, with fallback `Committed changeset <hash>`.
- Commit file memory: `Committed <summary>; <status> <path> (+<additions>/-<deletions>).`
- Session summary: `Session edited N file(s) in <cwd or checkout>.`
- Session file memory: `Session edited <path> <editCount> time(s) before a linked commit was observed.`
- Metrics must include counts used in the input: file count, tool failure count, plan snapshot count, additions/deletions where available.

- [ ] **Step 4: Run the derivation tests**

Run: `bun test src/memory/derive.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory/derive.ts src/memory/derive.test.ts
git commit -m "feat: derive project memory records"
```

## Task 3: SQL Statement Builders And Source Queries

**Files:**
- Create: `src/memory/sql.ts`
- Create: `src/memory/sql.test.ts`

- [ ] **Step 1: Write failing SQL tests**

Create `src/memory/sql.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    buildMemoryWriteStatements,
    commitMemorySourceSql,
    memoryRecentSql,
    sessionMemorySourceSql,
} from "./sql.ts";

describe("memory SQL", () => {
    test("source queries read produced commits and edited sessions", () => {
        expect(commitMemorySourceSql(7)).toContain("FROM produced");
        expect(commitMemorySourceSql(7)).toContain("FROM touched");
        expect(sessionMemorySourceSql(7)).toContain("FROM edited");
        expect(sessionMemorySourceSql(7)).toContain("WHERE started_at > time::now() - 7d");
    });

    test("write statements upsert nodes and deterministic relation ids", () => {
        const statements = buildMemoryWriteStatements({
            changeset: {
                key: "commit__abc",
                sessionRef: "session:`s1`",
                repositoryRef: "repository:`repo`",
                checkoutRef: "checkout:`co`",
                summaryText: "fix: test",
                detailText: null,
                status: "committed",
                labels: { source: "commit" },
                metrics: { fileCount: 1 },
                createdAt: "2026-05-11T00:00:00.000Z",
                updatedAt: null,
            },
            fileMemories: [{
                key: "memory__a",
                fileRef: "file:`f1`",
                repositoryRef: "repository:`repo`",
                checkoutRef: "checkout:`co`",
                path: "src/index.ts",
                kind: "commit_summary",
                text: "Committed fix: test; modified src/index.ts (+1/-0).",
                labels: {},
                metrics: {},
                createdAt: "2026-05-11T00:00:00.000Z",
            }],
            involves: [{
                key: "involves__a",
                changesetKey: "commit__abc",
                fileRef: "file:`f1`",
                role: "touched",
                labels: {},
                ts: "2026-05-11T00:00:00.000Z",
            }],
            includes: [{
                key: "includes__a",
                changesetKey: "commit__abc",
                fileMemoryKey: "memory__a",
                kind: "summary",
                labels: {},
                ts: "2026-05-11T00:00:00.000Z",
            }],
        });

        expect(statements.join("\n")).toContain("UPSERT changeset:`commit__abc`");
        expect(statements.join("\n")).toContain("UPSERT file_memory:`memory__a`");
        expect(statements.join("\n")).toContain("RELATE changeset:`commit__abc`->involves:`involves__a`->file:`f1`");
        expect(statements.join("\n")).toContain("RELATE changeset:`commit__abc`->includes:`includes__a`->file_memory:`memory__a`");
    });

    test("recent memory query is bounded", () => {
        expect(memoryRecentSql(5)).toContain("LIMIT 5");
        expect(() => memoryRecentSql(0)).toThrow("limit must be a positive integer");
    });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test src/memory/sql.test.ts`

Expected: fail because `src/memory/sql.ts` does not exist.

- [ ] **Step 3: Implement SQL builders**

Create `src/memory/sql.ts`:

- Reuse `recordRef` from `src/ingest/evidence-writers.ts`.
- Add local helpers for string/date/json/record options that match existing SurrealDB `NONE` conventions.
- Export:
  - `commitMemorySourceSql(days?: number): string`
  - `sessionMemorySourceSql(days?: number): string`
  - `buildMemoryWriteStatements(bundle: DerivedMemoryBundle): string[]`
  - `memoryRecentSql(limit: number): string`
  - `fileMemorySql(path: string, limit: number): string`

The source queries should return bounded rows shaped for `deriveCommitChangesetMemory` and `deriveSessionChangesetMemory`.

Use these query skeletons:

```sql
SELECT
    id,
    in AS session,
    out AS commit,
    repository,
    checkout,
    ts,
    out.message AS message,
    (SELECT out AS file, out.path AS path, additions, deletions, status FROM touched WHERE in = $parent.out) AS files,
    array::len((SELECT id FROM tool_call WHERE session = $parent.in AND has_error = true)) AS toolFailureCount,
    array::len((SELECT id FROM plan_snapshot WHERE session = $parent.in)) AS planSnapshotCount
FROM produced
WHERE ts > time::now() - 7d;
```

```sql
SELECT
    id,
    repository,
    checkout,
    cwd,
    started_at,
    ended_at,
    (SELECT out AS file, out.path AS path, count() AS editCount FROM edited WHERE in.session = $parent.id GROUP BY out, out.path) AS editedFiles,
    array::len((SELECT id FROM produced WHERE in = $parent.id)) AS producedCount,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS toolFailureCount,
    array::len((SELECT id FROM plan_snapshot WHERE session = $parent.id)) AS planSnapshotCount
FROM session
WHERE started_at > time::now() - 7d;
```

Filter session rows in TypeScript so provisional session memory is only created when `producedCount === 0` and `editedFiles.length > 0`.

- [ ] **Step 4: Run SQL tests**

Run: `bun test src/memory/sql.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sql.ts src/memory/sql.test.ts
git commit -m "feat: write project memory SQL"
```

## Task 4: Effect Runner And CLI Command

**Files:**
- Create: `src/memory/index.ts`
- Modify: `src/cli/index.ts`
- Test: existing focused tests plus CLI smoke.

- [ ] **Step 1: Implement `deriveMemory` runner**

Create `src/memory/index.ts` exporting:

```ts
export interface MemoryDeriveStats {
    readonly commitChangesets: number;
    readonly sessionChangesets: number;
    readonly fileMemories: number;
    readonly involves: number;
    readonly includes: number;
}

export interface MemoryDeriveOpts {
    readonly sinceDays: number | undefined;
}
```

Implement `deriveMemory(opts)` as an Effect that:

1. Queries `commitMemorySourceSql(opts.sinceDays)`.
2. Converts rows to `deriveCommitChangesetMemory` inputs.
3. Writes each bundle using `buildMemoryWriteStatements`.
4. Queries `sessionMemorySourceSql(opts.sinceDays)`.
5. Skips rows with produced commits.
6. Converts remaining edited sessions to `deriveSessionChangesetMemory` inputs.
7. Writes each bundle.
8. Logs `[derive-memory] DONE commitChangesets=X sessionChangesets=Y fileMemories=Z involves=A includes=B`.

- [ ] **Step 2: Wire CLI help and dispatch**

Modify `src/cli/index.ts`:

- Add usage line: `agentctl derive-memory [--since=DAYS]`.
- Import `deriveMemory`.
- Add `cmdDeriveMemory` using the same ingest run telemetry wrapper shape as `cmdDeriveSignals`.
- Dispatch `derive-memory`.
- In `cmdIngest`, after `deriveSignals`, run `telemetryStage(db, runId, "memory", "derive", deriveMemory({ sinceDays }))` when not `skillsOnly` and not `gitOnly`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test src/memory/derive.test.ts src/memory/sql.test.ts
bun run typecheck
```

Expected: tests pass; typecheck exits `0`.

- [ ] **Step 4: Smoke CLI help**

Run:

```bash
bun src/cli/index.ts --help | rg "derive-memory"
```

Expected: help includes `agentctl derive-memory [--since=DAYS]`.

- [ ] **Step 5: Commit**

```bash
git add src/memory/index.ts src/cli/index.ts
git commit -m "feat: add memory derivation command"
```

## Task 5: Query Surface And Schema Coverage

**Files:**
- Modify: `src/queries/insights.ts`
- Modify: `src/queries/insights.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing query tests**

In `src/queries/insights.test.ts`, add assertions:

```ts
test("schema coverage marks memory tables active", () => {
    const stages = new Map(SCHEMA_TABLES.map((row) => [row.table, row.stage]));
    expect(stages.get("changeset")).toBe("active");
    expect(stages.get("file_memory")).toBe("active");
    expect(stages.get("includes")).toBe("active");
    expect(stages.get("involves")).toBe("active");
});

test("memory insight SQL reads changesets and file memories", () => {
    expect(memoryRecentSql(10)).toContain("FROM changeset");
    expect(memoryRecentSql(10)).toContain("LIMIT 10");
    expect(fileMemorySql("src/cli/index.ts", 5)).toContain("FROM file_memory");
    expect(fileMemorySql("src/cli/index.ts", 5)).toContain("src/cli/index.ts");
});
```

Import `memoryRecentSql` and `fileMemorySql` from `src/memory/sql.ts`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test src/queries/insights.test.ts`

Expected: fail because schema stages are still staged or imports are missing.

- [ ] **Step 3: Mark memory tables active and add CLI view**

Modify `src/queries/insights.ts`:

- Add `"memory"` to `INSIGHT_VIEWS`.
- Change `changeset`, `file_memory`, `includes`, and `involves` stages to `"active"`.

Modify `src/cli/index.ts` in `cmdInsights` so:

- `agentctl insights memory --limit=N` prints `memoryRecentSql(limit)` JSON.
- Keep all output JSON-first like other insight views.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test src/queries/insights.test.ts src/memory/sql.test.ts
bun run typecheck
```

Expected: pass / exit `0`.

- [ ] **Step 5: Commit**

```bash
git add src/queries/insights.ts src/queries/insights.test.ts src/cli/index.ts
git commit -m "feat: expose project memory insights"
```

## Task 6: Documentation And End-To-End Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-05-11-original-inspiration-completion-roadmap.md` if sequencing notes need updating.

- [ ] **Step 1: Update README usage**

In `README.md`, add:

```bash
agentctl derive-memory [--since=DAYS] # derive changesets + file memories from existing graph evidence
agentctl insights memory --limit=25   # recent changesets and linked file memories
```

Add a short paragraph explaining:

- `changeset` is the durable unit of work.
- `file_memory` is a compact per-file retrieval card.
- Both are deterministic first-pass summaries derived from local evidence, not LLM-generated prose.

- [ ] **Step 2: Run full verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: all tests pass; typecheck exits `0`.

- [ ] **Step 3: Empty/recent DB smoke**

Run:

```bash
scripts/bench-empty-db.sh --since=1 --dashboard-limit=5
```

Expected:

- ingest completes.
- output includes `[derive-memory] DONE`.
- `agentctl insights schema` on the benchmark database shows non-zero `changeset`, `file_memory`, `includes`, and `involves` when recent produced commits or edited sessions exist.

- [ ] **Step 4: Direct CLI smoke**

Run against the normal local DB:

```bash
bun src/cli/index.ts derive-memory --since=7
bun src/cli/index.ts insights memory --limit=5
```

Expected:

- derive command exits `0`.
- insights command returns JSON rows or `[]`, not a thrown query error.

- [ ] **Step 5: Close #64**

Comment on #64 with:

- commit hash.
- focused test output.
- full verification output.
- benchmark or direct smoke output.
- counts for `changeset`, `file_memory`, `includes`, and `involves`.

Then close #64.

- [ ] **Step 6: Final commit**

```bash
git add README.md docs/superpowers/plans/2026-05-11-original-inspiration-completion-roadmap.md
git commit -m "docs: document project memory derivation"
```

## Self-Review

- Spec coverage: This plan implements #64 only and explicitly leaves #65-#71 to their linked issues.
- Placeholder scan: No TBD/TODO/fill-in placeholders are present.
- Type consistency: The plan consistently uses `changeset`, `file_memory`, `includes`, `involves`, `deriveMemory`, `memoryRecentSql`, and `fileMemorySql`.
- Risk: The source SQL sketches may need minor SurrealDB syntax adjustment during implementation; tests should assert generated SQL shape, and the smoke gate must run against a real DB before #64 is closed.

