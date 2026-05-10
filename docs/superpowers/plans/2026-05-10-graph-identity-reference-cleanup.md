# Graph Identity and Record Reference Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repository, checkout, file, commit, skill, turn, tool, plan, and relation identities cohesive while using SurrealDB references and indexed valued edges for fast graph queries.

**Architecture:** Add a shared identity module that replaces duplicated key builders and lossy encodings. Update schema and ingestion writers so direct ownership uses record fields and eventful relationships keep relation tables with payload. Add graph health queries before any migration-style rewrite.

**Tech Stack:** Bun 1.3+, TypeScript strict, Effect beta v4, SurrealDB 3.x schemafull tables, SurrealQL, `bun test`, `bun run typecheck`. Before editing Effect code, run `effect-solutions list` and `effect-solutions show services-and-layers error-handling testing`.

---

## File Structure

- Create `src/lib/ids.ts`: shared deterministic ID helpers, record key escaping, versioned hash helper, legacy compatibility helpers.
- Create `src/queries/graph-health.ts`: SQL builders for duplicate identity and stale edge health checks.
- Create `src/queries/graph-health.test.ts`: tests for graph health SQL.
- Modify `src/ingest/record-keys.ts`: re-export shared ID helpers for compatibility.
- Modify `src/lib/skill-id.ts`: use collision-safe skill IDs and expose legacy lookup helpers.
- Modify `src/ingest/transcripts.ts`: remove local `turnRecordKey` and `fileRecordKey`; use shared IDs for turns and edited files.
- Modify `src/ingest/codex.ts`: remove local `turnRecordKey`; use shared IDs.
- Modify `src/ingest/evidence-writers.ts`: use shared record references and ID helpers.
- Modify `src/ingest/git.ts`: add deterministic `touched` and valued `produced` writes.
- Modify `schema/schema.surql`: add valued fields and indexes for `produced`, index support for `touched`, and graph-health supporting indexes. Keep existing `record<table>` field types unless a local SurrealDB syntax check confirms `REFERENCE` annotations are accepted in this schema.
- Modify `src/queries/insights.ts`: add `graph-health` insight view that returns a single array of typed health rows.
- Modify `src/cli/index.ts`: expose `agentctl insights graph-health`.
- Modify tests next to each changed ingestion module.

## Task 1: Shared ID Module

**Files:**
- Create: `src/lib/ids.ts`
- Modify: `src/ingest/record-keys.ts`
- Test: `src/ingest/record-keys.test.ts`

- [ ] **Step 1: Write failing tests for stable and collision-safe IDs**

Add these tests to `src/ingest/record-keys.test.ts`:

```ts
import {
    checkoutRecordKey,
    commitRecordKey,
    fileRecordKey,
    repositoryRecordKey,
    toolCallRecordKey,
    turnRecordKey,
} from "./record-keys.ts";

test("fileRecordKey normalizes SDK-style repository record IDs", () => {
    expect(fileRecordKey("repository:`remote__github_com_org_repo__abc123`", "src/index.ts"))
        .toBe(fileRecordKey("remote__github_com_org_repo__abc123", "src/index.ts"));
});

test("commitRecordKey normalizes plain and record-literal repository keys", () => {
    expect(commitRecordKey("repository:`remote__repo__001`", "a".repeat(40)))
        .toBe(commitRecordKey("remote__repo__001", "a".repeat(40)));
});

test("turnRecordKey is centralized and deterministic", () => {
    expect(turnRecordKey("session-abc", 7)).toMatch(/^session_abc__[a-f0-9]{16}__seq_000007$/);
});

test("toolCallRecordKey keeps call id distinct from seq fallback", () => {
    expect(toolCallRecordKey({ sessionId: "s1", seq: 1, callId: "seq_000001" }))
        .not.toBe(toolCallRecordKey({ sessionId: "s1", seq: 1 }));
});

test("repository and checkout IDs stay deterministic", () => {
    expect(repositoryRecordKey({ remoteUrlNormalized: "github.com/org/repo" }))
        .toBe(repositoryRecordKey({ remoteUrlNormalized: "github.com/org/repo" }));
    expect(checkoutRecordKey("/tmp/repo")).toBe(checkoutRecordKey("/tmp/repo"));
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```sh
bun test src/ingest/record-keys.test.ts
```

Expected: FAIL because `turnRecordKey` is not exported and SDK-style repository record IDs are not fully normalized.

- [ ] **Step 3: Add shared ID helpers**

Create `src/lib/ids.ts`:

```ts
import { createHash } from "node:crypto";

export type RepositoryKeyInput = {
    readonly remoteUrlNormalized?: string | null;
    readonly initialCommit?: string | null;
    readonly checkoutRoot?: string | null;
};

export type ToolKeyInput = {
    readonly provider: string;
    readonly kind: string;
    readonly name: string;
};

export type ToolCallKeyInput = {
    readonly sessionId: string;
    readonly seq: number;
    readonly callId?: string | null;
};

export function stableDigest(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function sanitizeRecordKeyPart(value: string, fallback = "_"): string {
    const sanitized = value
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
}

export function identityPart(value: string, fallback = "_"): string {
    return `${sanitizeRecordKeyPart(value, fallback)}__${stableDigest(value)}`;
}

export function normalizeRepositoryKey(repositoryKey: string): string {
    const trimmed = repositoryKey.trim();
    const recordLiteral = trimmed.match(/^repository:`(.+)`$/);
    if (recordLiteral) return recordLiteral[1];
    const recordPlain = trimmed.match(/^repository:(.+)$/);
    return recordPlain ? recordPlain[1] : trimmed;
}

export function repositoryRecordKey(input: RepositoryKeyInput): string {
    if (input.remoteUrlNormalized) return `remote__${identityPart(input.remoteUrlNormalized)}`;
    if (input.initialCommit) {
        return `initial__${sanitizeRecordKeyPart(input.initialCommit).slice(0, 16)}__${stableDigest(input.initialCommit, 12)}`;
    }
    return `local__${identityPart(input.checkoutRoot ?? "unknown", "checkout")}`;
}

export function checkoutRecordKey(checkoutRoot: string): string {
    return identityPart(checkoutRoot, "checkout");
}

export function fileRecordKey(repositoryKey: string, path: string): string {
    return `${identityPart(normalizeRepositoryKey(repositoryKey), "repository")}__${identityPart(path, "file")}`;
}

export function commitRecordKey(repositoryKey: string, sha: string): string {
    return `${identityPart(normalizeRepositoryKey(repositoryKey), "repository")}__${identityPart(sha, "commit")}`;
}

export function skillRecordKeyV2(name: string): string {
    return `v2__${identityPart(name, "skill")}`;
}

export function legacySkillRecordKey(name: string): string {
    return name.replace(/:/g, "__");
}

export function turnRecordKey(sessionId: string, seq: number): string {
    return `${sanitizeRecordKeyPart(sessionId, "session")}__${stableDigest(sessionId)}__seq_${seq.toString(10).padStart(6, "0")}`;
}

export function toolRecordKey(input: ToolKeyInput): string {
    return [
        identityPart(input.provider, "provider"),
        identityPart(input.kind, "kind"),
        identityPart(input.name, "tool"),
    ].join("__");
}

export function toolCallRecordKey(input: ToolCallKeyInput): string {
    const callPart = input.callId ? identityPart(input.callId, "call") : `seq_${input.seq.toString(10).padStart(6, "0")}`;
    return `${identityPart(input.sessionId, "session")}__${callPart}`;
}
```

- [ ] **Step 4: Re-export helpers from `record-keys.ts`**

Replace `src/ingest/record-keys.ts` with:

```ts
export {
    checkoutRecordKey,
    commitRecordKey,
    fileRecordKey,
    identityPart,
    normalizeRepositoryKey,
    repositoryRecordKey,
    sanitizeRecordKeyPart,
    stableDigest,
    toolCallRecordKey,
    toolRecordKey,
    turnRecordKey,
} from "../lib/ids.ts";
export type { RepositoryKeyInput, ToolCallKeyInput, ToolKeyInput } from "../lib/ids.ts";
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/ingest/record-keys.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/lib/ids.ts src/ingest/record-keys.ts src/ingest/record-keys.test.ts
git commit -m "feat: centralize graph record ids"
```

## Task 2: Collision-Safe Skill IDs

**Files:**
- Modify: `src/lib/skill-id.ts`
- Modify: `src/ingest/skills.ts`
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`
- Modify: `src/ingest/evidence-writers.ts`
- Test: `src/ingest/record-keys.test.ts`

- [ ] **Step 1: Write failing skill ID tests**

Add to `src/ingest/record-keys.test.ts`:

```ts
import { legacySkillRecordKey, skillRecordKey } from "../lib/skill-id.ts";

test("skillRecordKey does not collide on colon and double underscore names", () => {
    expect(skillRecordKey("a:b")).not.toBe(skillRecordKey("a__b"));
});

test("legacySkillRecordKey preserves old lookup behavior", () => {
    expect(legacySkillRecordKey("plugin:name")).toBe("plugin__name");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```sh
bun test src/ingest/record-keys.test.ts
```

Expected: FAIL because current `skillRecordKey("a:b")` equals `skillRecordKey("a__b")`.

- [ ] **Step 3: Update skill ID helper**

Replace `src/lib/skill-id.ts` with:

```ts
import { legacySkillRecordKey as legacyKey, skillRecordKeyV2 } from "./ids.ts";

export function skillRecordKey(name: string): string {
    return skillRecordKeyV2(name);
}

export function legacySkillRecordKey(name: string): string {
    return legacyKey(name);
}

export function skillRecordLookupKeys(name: string): string[] {
    const modern = skillRecordKey(name);
    const legacy = legacySkillRecordKey(name);
    return modern === legacy ? [modern] : [modern, legacy];
}
```

- [ ] **Step 4: Preserve compatibility at relation write sites**

In `src/ingest/evidence-writers.ts`, import `skillRecordLookupKeys` and update `relateToolCallSkill` so it uses the modern key for new `concerns` edges while creating the `skill` record if absent:

```ts
import { skillRecordKey, skillRecordLookupKeys } from "../lib/skill-id.ts";
```

When building the skill ref, use:

```ts
const skillKey = skillRecordKey(relation.skillName);
const lookupKeys = skillRecordLookupKeys(relation.skillName);
```

Add a prelude statement:

```ts
`UPSERT ${recordRef("skill", skillKey)} MERGE { name: ${sqlString(relation.skillName)}, scope: "unknown", dir_path: "", content_hash: "unknown" };`
```

Do not delete old skill records. Legacy lookup should be handled by query compatibility in follow-up health checks.

- [ ] **Step 5: Update direct skill reference imports**

Search:

```sh
rg "skillRecordKey" src
```

For each call in `src/ingest/skills.ts`, `src/ingest/transcripts.ts`, `src/ingest/codex.ts`, and `src/ingest/derive-signals.ts`, keep the function name but rely on the new implementation. Do not inline string replacement logic.

- [ ] **Step 6: Run tests**

Run:

```sh
bun test src/ingest/record-keys.test.ts src/ingest/evidence-writers.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/lib/skill-id.ts src/ingest/skills.ts src/ingest/transcripts.ts src/ingest/codex.ts src/ingest/evidence-writers.ts src/ingest/record-keys.test.ts
git commit -m "feat: use collision-safe skill ids"
```

## Task 3: Transcript and Codex Turn/File Identity Cleanup

**Files:**
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`
- Test: `src/ingest/transcripts.test.ts`
- Test: `src/ingest/codex.test.ts`

- [ ] **Step 1: Write failing tests for centralized turn IDs**

Add assertions in transcript and Codex extraction tests where turn IDs are expected:

```ts
import { turnRecordKey } from "./record-keys.ts";

expect(turns[0].id).toBe(turnRecordKey(session.id, 1));
```

If the existing extraction type does not expose `id`, update the test fixture to inspect the generated `UPSERT turn:` SQL and assert that it contains `turnRecordKey(session.id, 1)`.

- [ ] **Step 2: Write failing test for edited file ID joining Git file ID**

In `src/ingest/transcripts.test.ts`, add a fixture edit with `cwd: "/repo"` and path `/repo/src/a.ts`, then assert that the related file key equals:

```ts
fileRecordKey("remote__repo", "src/a.ts")
```

Use a test helper that passes repository context if already available; otherwise assert that local path fallback is explicit and health checks flag it.

- [ ] **Step 3: Run tests and verify failures**

Run:

```sh
bun test src/ingest/transcripts.test.ts src/ingest/codex.test.ts
```

Expected: FAIL due local `turnRecordKey` and transcript-local `fileRecordKey`.

- [ ] **Step 4: Replace duplicated turn key functions**

In both `src/ingest/transcripts.ts` and `src/ingest/codex.ts`:

```ts
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
```

Delete the local `turnRecordKey` functions.

- [ ] **Step 5: Replace transcript-local file key logic**

In `src/ingest/transcripts.ts`, delete the local `fileRecordKey` and import the shared helper:

```ts
import { fileRecordKey, toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
```

At edit write time, compute:

```ts
const repositoryKey = edit.repositoryKey ?? edit.repo ?? repoFromCwd(session.cwd) ?? "_";
const fileKey = fileRecordKey(repositoryKey, edit.path);
```

If repository context is not yet known, keep `repoFromCwd` fallback but set `identity_scope: "legacy_local"` on the file row so graph health can report it.

- [ ] **Step 6: Run tests**

Run:

```sh
bun test src/ingest/transcripts.test.ts src/ingest/codex.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/ingest/transcripts.ts src/ingest/codex.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts
git commit -m "feat: unify transcript graph ids"
```

## Task 4: Valued `produced` and Idempotent `touched`

**Files:**
- Modify: `schema/schema.surql`
- Modify: `src/ingest/git.ts`
- Test: `src/ingest/git.test.ts`

- [ ] **Step 1: Write failing tests for new relation statements**

Add to `src/ingest/git.test.ts`:

```ts
import {
    buildProducedRelationStatements,
    buildTouchedRelationStatements,
    touchedRelationRecordKey,
} from "./git.ts";

test("touchedRelationRecordKey is deterministic per commit file checkout", () => {
    expect(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"))
        .toBe(touchedRelationRecordKey("commit:`c1`", "file:`f1`", "checkout:`co1`"));
});

test("touched relation statements upsert deterministic relation ids", () => {
    const statements = buildTouchedRelationStatements({
        commitId: "commit:`c1`",
        repositoryId: "repository:`r1`",
        checkoutId: "checkout:`co1`",
        ts: "2026-05-10T00:00:00.000Z",
        files: [{ fileId: "file:`f1`", additions: 1, deletions: 2 }],
    });
    expect(statements.join("\n")).toContain("RELATE commit:`c1`->touched:");
    expect(statements.join("\n")).toContain("repository = repository:`r1`");
    expect(statements.join("\n")).toContain("checkout = checkout:`co1`");
});

test("produced relation statements include repository checkout and ts", () => {
    const statements = buildProducedRelationStatements({
        sessionIds: ["session:`s1`"],
        commitId: "commit:`c1`",
        repositoryId: "repository:`r1`",
        checkoutId: "checkout:`co1`",
        ts: "2026-05-10T00:00:00.000Z",
    });
    expect(statements.join("\n")).toContain("repository = repository:`r1`");
    expect(statements.join("\n")).toContain("checkout = checkout:`co1`");
    expect(statements.join("\n")).toContain("ts = d\"2026-05-10T00:00:00.000Z\"");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```sh
bun test src/ingest/git.test.ts
```

Expected: FAIL because `buildProducedRelationStatements` and `touchedRelationRecordKey` do not exist.

- [ ] **Step 3: Update schema**

In `schema/schema.surql`, replace bare `produced` definition with:

```surql
DEFINE TABLE produced TYPE RELATION FROM session TO commit;
DEFINE FIELD repository   ON produced TYPE option<record<repository>>;
DEFINE FIELD checkout     ON produced TYPE option<record<checkout>>;
DEFINE FIELD ts           ON produced TYPE option<datetime>;
DEFINE FIELD source       ON produced TYPE option<string>;
DEFINE FIELD kind         ON produced TYPE option<string>;
DEFINE INDEX IF NOT EXISTS produced_in_ts ON produced FIELDS in, ts;
DEFINE INDEX IF NOT EXISTS produced_out_ts ON produced FIELDS out, ts;
DEFINE INDEX IF NOT EXISTS produced_repository_checkout_ts ON produced FIELDS repository, checkout, ts;
```

Add:

```surql
DEFINE INDEX IF NOT EXISTS touched_in_checkout ON touched FIELDS in, checkout;
```

- [ ] **Step 4: Add deterministic relation helpers**

In `src/ingest/git.ts`, export:

```ts
export function touchedRelationRecordKey(
    commitId: string,
    fileId: string,
    checkoutId: string,
): string {
    return Bun.hash(`${commitId}|${fileId}|${checkoutId}`).toString(16).padStart(16, "0");
}

export function producedRelationRecordKey(sessionId: string, commitId: string): string {
    return Bun.hash(`${sessionId}|${commitId}`).toString(16).padStart(16, "0");
}
```

- [ ] **Step 5: Update touched write statements**

Change `buildTouchedRelationStatements` to remove the broad delete and relate with explicit edge IDs:

```ts
const edgeKey = touchedRelationRecordKey(input.commitId, file.fileId, input.checkoutId);
stmts.push(
    `RELATE ${input.commitId}->touched:\`${edgeKey}\`->${file.fileId} SET additions = ${add}, deletions = ${del}, repository = ${input.repositoryId}, checkout = ${input.checkoutId}, ts = d"${input.ts}";`,
);
```

- [ ] **Step 6: Add produced write statement helper**

Add:

```ts
export function buildProducedRelationStatements(input: {
    readonly sessionIds: readonly string[];
    readonly commitId: string;
    readonly repositoryId: string;
    readonly checkoutId: string;
    readonly ts: string;
}): string[] {
    return input.sessionIds.map((sessionId) => {
        const edgeKey = producedRelationRecordKey(sessionId, input.commitId);
        return `RELATE ${sessionId}->produced:\`${edgeKey}\`->${input.commitId} SET repository = ${input.repositoryId}, checkout = ${input.checkoutId}, ts = d"${input.ts}", source = "git", kind = "commit";`;
    });
}
```

- [ ] **Step 7: Use produced helper in `writeRepo`**

Replace the old `DELETE produced ...` and bare `RELATE` block with:

```ts
const stmts = buildProducedRelationStatements({
    sessionIds,
    commitId: cid,
    repositoryId,
    checkoutId,
    ts: c.ts,
});
```

- [ ] **Step 8: Run tests**

Run:

```sh
bun test src/ingest/git.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add schema/schema.surql src/ingest/git.ts src/ingest/git.test.ts
git commit -m "feat: enrich git graph relations"
```

## Task 5: Graph Health Queries and CLI View

**Files:**
- Create: `src/queries/graph-health.ts`
- Create: `src/queries/graph-health.test.ts`
- Modify: `src/queries/insights.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write graph health SQL tests**

Create `src/queries/graph-health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    duplicateFileIdentitySql,
    legacySkillCollisionSql,
    missingProducedScopeSql,
    repositorySiblingSql,
} from "./graph-health.ts";

describe("graph health SQL", () => {
    test("duplicateFileIdentitySql groups by repository path", () => {
        expect(duplicateFileIdentitySql(10)).toContain("GROUP BY repository, path");
    });

    test("repositorySiblingSql checks canonical identity drift", () => {
        expect(repositorySiblingSql(10)).toContain("initial_commit");
        expect(repositorySiblingSql(10)).toContain("remote_url");
    });

    test("missingProducedScopeSql checks valued produced fields", () => {
        expect(missingProducedScopeSql(10)).toContain("FROM produced");
        expect(missingProducedScopeSql(10)).toContain("repository IS NONE");
    });

    test("legacySkillCollisionSql finds lossy names", () => {
        expect(legacySkillCollisionSql(10)).toContain("string::replace");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/queries/graph-health.test.ts
```

Expected: FAIL because file does not exist.

- [ ] **Step 3: Implement graph health SQL builders**

Create `src/queries/graph-health.ts`:

```ts
function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

export function duplicateFileIdentitySql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT repository, repo, path, count() AS row_count, array::group(id) AS ids
FROM file
GROUP BY repository, repo, path
HAVING row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function repositorySiblingSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT initial_commit, remote_url, count() AS row_count, array::group(id) AS ids
FROM repository
WHERE initial_commit IS NOT NONE OR remote_url IS NOT NONE
GROUP BY initial_commit, remote_url
HAVING row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function missingProducedScopeSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT id, in, out, repository, checkout, ts
FROM produced
WHERE repository IS NONE OR checkout IS NONE OR ts IS NONE
LIMIT ${safeLimit};`.trim();
}

export function legacySkillCollisionSql(limit: number): string {
    const safeLimit = checkedLimit(limit);
    return `
SELECT string::replace(name, ":", "__") AS legacy_key, count() AS row_count, array::group(name) AS names
FROM skill
GROUP BY legacy_key
HAVING row_count > 1
ORDER BY row_count DESC
LIMIT ${safeLimit};`.trim();
}

export function graphHealthSql(limit: number): string {
    return `RETURN {
    duplicate_file_identity: (${duplicateFileIdentitySql(limit)}),
    repository_sibling: (${repositorySiblingSql(limit)}),
    missing_produced_scope: (${missingProducedScopeSql(limit)}),
    legacy_skill_collision: (${legacySkillCollisionSql(limit)})
};`;
}
```

- [ ] **Step 4: Add insights view**

In `src/queries/insights.ts`, add `"graph-health"` to `INSIGHT_VIEWS`, import `graphHealthSql`, and route:

```ts
case "graph-health":
    return graphHealthSql(limit);
```

In `src/cli/index.ts`, update help and unknown-view error to include `graph-health`.

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/queries/graph-health.test.ts src/queries/insights.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/queries/graph-health.ts src/queries/graph-health.test.ts src/queries/insights.ts src/queries/insights.test.ts src/cli/index.ts
git commit -m "feat: add graph health insight queries"
```

## Task 6: Verification

**Files:**
- No new source files.

- [ ] **Step 1: Apply schema locally**

Run:

```sh
bun scripts/apply-schema.ts
```

Expected: schema applies without SurrealQL errors.

- [ ] **Step 2: Run focused tests**

Run:

```sh
bun test src/ingest/record-keys.test.ts src/ingest/git.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/queries/graph-health.test.ts src/queries/insights.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run full tests**

Run:

```sh
bun test
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck**

Run:

```sh
bun run typecheck
```

Expected: exit 0. Existing Effect diagnostics may still print if they are warnings; do not introduce new TypeScript errors.

- [ ] **Step 5: Smoke test graph health**

Run:

```sh
bun src/cli/index.ts insights graph-health --limit=10
```

Expected: JSON arrays print without SQL errors.

- [ ] **Step 6: Commit verification fixes**

If verification required small fixes:

```sh
git add schema/schema.surql src
git commit -m "fix: stabilize graph identity cleanup"
```

If no fixes were needed, do not create an empty commit.
