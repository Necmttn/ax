# Agent Evidence Graph Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working prototype of the richer agent evidence graph: repositories/checkouts, canonical files, tool calls, plans, imported insights, friction/diagnostic evidence, recommendations, and query examples.

**Architecture:** Extend the existing SurrealDB schema without removing the current taste graph. Add pure extraction helpers first, then wire Claude, Codex, and Git ingest to write the new graph while preserving existing `turn -> invoked`, `turn -> edited`, `session -> produced`, and `commit -> touched` behavior for compatibility. Add query adapter functions and CLI examples so integration tests can exercise stable query surfaces instead of scattering SurrealQL across the app.

**Tech Stack:** Bun, TypeScript strict mode, Effect 4 beta, SurrealDB 3, Bun test, existing `SurrealClient` service.

---

## Scope Check

This plan is one vertical prototype. It intentionally excludes the dashboard UI, paid sync, long-term retention/redaction enforcement, full static code tracer, and LLM enrichment jobs. It does include the schema and query shapes those later systems need.

Prototype success means:

- `agentctl ingest --since=1` still works.
- Existing taste/search commands still work.
- Claude transcripts write `tool_call`, `plan`, `plan_item`, `plan_snapshot`, and tool-call-level `edited` edges.
- Codex sessions write `tool_call`, call outputs, `plan_snapshot`, and tool-call-level skill/tool evidence.
- Git ingest writes `repository`, `checkout`, canonical `file.repository`, `commit.repository`, and enriched `touched`.
- Claude `/insights` JSON imports as `insight` and coarse `friction_event`.
- Query adapter returns useful repository/session/change/friction rows.

## File Structure

Create:

- `src/ingest/record-keys.ts`: deterministic RecordId key helpers shared by ingest modules.
- `src/ingest/record-keys.test.ts`: unit tests for stable key behavior.
- `src/ingest/repository-identity.ts`: Git repository and checkout identity helpers.
- `src/ingest/repository-identity.test.ts`: tests for remote normalization and fallback identity.
- `src/ingest/tool-calls.ts`: normalized tool/tool-call types, command extraction, output parsing helpers.
- `src/ingest/tool-calls.test.ts`: tests for CLI normalization and Codex output parsing.
- `src/ingest/plans.ts`: plan snapshot normalization for Claude `TodoWrite`/`TaskCreate`/`TaskUpdate` and Codex `update_plan`.
- `src/ingest/plans.test.ts`: tests for plan snapshot normalization.
- `src/ingest/claude-insights.ts`: importer for `~/.claude/usage-data/facets` and `session-meta`.
- `src/ingest/claude-insights.test.ts`: tests for facet-to-insight/friction conversion.
- `src/ingest/evidence-writers.ts`: batch SurrealQL writers for tools, tool calls, plans, insights, events, and recommendations.
- `src/queries/insights.ts`: query adapter for dashboard/CLI/integration-test query surfaces.
- `src/queries/insights.test.ts`: string-shape/unit tests for query adapter output builders.

Modify:

- `schema/schema.surql`: add new node/relation tables, fields, and indexes.
- `src/ingest/transcripts.ts`: emit normalized tool calls, plan snapshots, and tool-call-level edit/skill evidence.
- `src/ingest/codex.ts`: emit normalized tool calls, call outputs, Codex plan snapshots, and tool-call-level evidence.
- `src/ingest/git.ts`: write `repository`, `checkout`, canonical `file`, `commit.repository`, and enriched `touched`.
- `src/cli/index.ts`: add `agentctl ingest-insights` and `agentctl insights` commands.
- `docs/repo-file-change-graph-design.md`: append final prototype execution notes after implementation.

## Task 1: Stable Record Keys

**Files:**
- Create: `src/ingest/record-keys.ts`
- Create: `src/ingest/record-keys.test.ts`

- [ ] **Step 1: Write failing tests for key stability**

Create `src/ingest/record-keys.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    checkoutRecordKey,
    fileRecordKey,
    repositoryRecordKey,
    toolCallRecordKey,
    toolRecordKey,
} from "./record-keys.ts";

describe("record keys", () => {
    test("repository key prefers normalized remote", () => {
        expect(
            repositoryRecordKey({
                remoteUrlNormalized: "github.com/necmttn/agentctl",
                initialCommit: "abc",
                checkoutRoot: "/Users/necmttn/Projects/agentctl",
            }),
        ).toBe("remote__github_com_necmttn_agentctl");
    });

    test("repository key falls back to initial commit", () => {
        expect(repositoryRecordKey({ initialCommit: "a".repeat(40) })).toBe(
            "initial__aaaaaaaaaaaaaaaa",
        );
    });

    test("repository key falls back to checkout root hash", () => {
        const key = repositoryRecordKey({
            checkoutRoot: "/Users/necmttn/Projects/local-only",
        });

        expect(key.startsWith("local__Users_necmttn_Projects_local_only__")).toBe(true);
    });

    test("checkout key is tied to the local path", () => {
        const key = checkoutRecordKey("/Users/necmttn/Projects/agentctl");

        expect(key.startsWith("Users_necmttn_Projects_agentctl__")).toBe(true);
    });

    test("file key is repository scoped", () => {
        expect(fileRecordKey("repository:remote__github_com_necmttn_agentctl", "src/cli/index.ts")).toBe(
            "repository_remote_github_com_necmttn_agentctl__src_cli_index_ts",
        );
    });

    test("tool key separates provider and kind", () => {
        expect(toolRecordKey({ provider: "codex", kind: "cli", name: "git" })).toBe(
            "codex__cli__git",
        );
    });

    test("tool call key uses call id when available", () => {
        expect(
            toolCallRecordKey({
                sessionId: "019df8f4-f912-7a80-8321-f8b1509fd0e5",
                seq: 7,
                callId: "call_abc",
            }),
        ).toBe("019df8f4f9127a808321f8b1509fd0e5__call_abc");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/record-keys.test.ts`

Expected: FAIL with `Cannot find module './record-keys.ts'`.

- [ ] **Step 3: Implement record key helpers**

Create `src/ingest/record-keys.ts`:

```ts
const MAX_PART = 96;

export function safeIdPart(value: string): string {
    const trimmed = value.trim().replace(/^\/+/, "");
    const normalized = trimmed.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return (normalized || "unknown").slice(0, MAX_PART);
}

export function shortHash(value: string): string {
    return Bun.hash(value).toString(16).slice(0, 10);
}

export function repositoryRecordKey(input: {
    readonly remoteUrlNormalized?: string | null;
    readonly initialCommit?: string | null;
    readonly checkoutRoot?: string | null;
}): string {
    if (input.remoteUrlNormalized && input.remoteUrlNormalized.trim().length > 0) {
        return `remote__${safeIdPart(input.remoteUrlNormalized)}`;
    }
    if (input.initialCommit && input.initialCommit.trim().length >= 16) {
        return `initial__${safeIdPart(input.initialCommit).slice(0, 16)}`;
    }
    const root = input.checkoutRoot ?? "unknown";
    return `local__${safeIdPart(root)}__${shortHash(root)}`;
}

export function checkoutRecordKey(path: string): string {
    return `${safeIdPart(path)}__${shortHash(path)}`;
}

export function fileRecordKey(scopeRecord: string, path: string): string {
    return `${safeIdPart(scopeRecord)}__${safeIdPart(path)}`;
}

export function commitRecordKey(repositoryKey: string, sha: string): string {
    return `${safeIdPart(repositoryKey)}__${safeIdPart(sha).slice(0, 40)}`;
}

export function toolRecordKey(input: {
    readonly provider: string;
    readonly kind: string;
    readonly name: string;
}): string {
    return `${safeIdPart(input.provider)}__${safeIdPart(input.kind)}__${safeIdPart(input.name)}`;
}

export function toolCallRecordKey(input: {
    readonly sessionId: string;
    readonly seq: number;
    readonly callId?: string | null;
}): string {
    const session = input.sessionId.replace(/-/g, "");
    const suffix = input.callId && input.callId.length > 0 ? safeIdPart(input.callId) : String(input.seq);
    return `${session}__${suffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ingest/record-keys.test.ts`

Expected: PASS all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/record-keys.ts src/ingest/record-keys.test.ts
git commit -m "feat: add graph record key helpers"
```

## Task 2: Schema Extension For Prototype Graph

**Files:**
- Modify: `schema/schema.surql`

- [ ] **Step 1: Append graph schema block**

Append this block after the existing node table definitions and before relation definitions in `schema/schema.surql`:

```sql
-- ==== Repository / checkout identity ====

DEFINE TABLE repository SCHEMAFULL;
DEFINE FIELD identity_kind ON repository TYPE string;
DEFINE FIELD remote_url ON repository TYPE option<string>;
DEFINE FIELD remote_url_normalized ON repository TYPE option<string>;
DEFINE FIELD initial_commit ON repository TYPE option<string>;
DEFINE FIELD local_fallback ON repository TYPE option<string>;
DEFINE FIELD first_seen_at ON repository TYPE datetime VALUE time::now();
DEFINE FIELD last_seen_at ON repository TYPE datetime VALUE time::now();
DEFINE INDEX repository_remote ON repository FIELDS remote_url_normalized;
DEFINE INDEX repository_initial_commit ON repository FIELDS initial_commit;

DEFINE TABLE checkout SCHEMAFULL;
DEFINE FIELD repository ON checkout TYPE record<repository>;
DEFINE FIELD path ON checkout TYPE string;
DEFINE FIELD git_dir ON checkout TYPE option<string>;
DEFINE FIELD branch ON checkout TYPE option<string>;
DEFINE FIELD worktree_kind ON checkout TYPE string DEFAULT "normal";
DEFINE FIELD first_seen_at ON checkout TYPE datetime VALUE time::now();
DEFINE FIELD last_seen_at ON checkout TYPE datetime VALUE time::now();
DEFINE INDEX checkout_path_uq ON checkout FIELDS path UNIQUE;
DEFINE INDEX checkout_repository ON checkout FIELDS repository;

DEFINE TABLE workspace SCHEMAFULL;
DEFINE FIELD path ON workspace TYPE string;
DEFINE FIELD first_seen_at ON workspace TYPE datetime VALUE time::now();
DEFINE FIELD last_seen_at ON workspace TYPE datetime VALUE time::now();
DEFINE INDEX workspace_path_uq ON workspace FIELDS path UNIQUE;

DEFINE FIELD repository ON session TYPE option<record<repository>>;
DEFINE FIELD checkout ON session TYPE option<record<checkout>>;
DEFINE FIELD workspace ON session TYPE option<record<workspace>>;

DEFINE FIELD repository ON file TYPE option<record<repository>>;
DEFINE FIELD checkout ON file TYPE option<record<checkout>>;
DEFINE FIELD workspace ON file TYPE option<record<workspace>>;
DEFINE FIELD kind ON file TYPE string DEFAULT "unknown";
DEFINE FIELD identity_scope ON file TYPE string DEFAULT "legacy";

DEFINE FIELD repository ON commit TYPE option<record<repository>>;
DEFINE FIELD checkout ON commit TYPE option<record<checkout>>;
```

Append this block near the existing relation definitions:

```sql
DEFINE TABLE has_checkout TYPE RELATION FROM repository TO checkout;
DEFINE FIELD ts ON has_checkout TYPE datetime VALUE time::now();

-- ==== Tool calls / plans / evidence ====

DEFINE TABLE tool SCHEMAFULL;
DEFINE FIELD name ON tool TYPE string;
DEFINE FIELD kind ON tool TYPE string;
DEFINE FIELD provider ON tool TYPE string;
DEFINE FIELD description ON tool TYPE option<string>;
DEFINE FIELD first_seen_at ON tool TYPE datetime VALUE time::now();
DEFINE FIELD last_seen_at ON tool TYPE datetime VALUE time::now();
DEFINE INDEX tool_identity_uq ON tool FIELDS provider, kind, name UNIQUE;

DEFINE TABLE tool_call SCHEMAFULL;
DEFINE FIELD session ON tool_call TYPE record<session>;
DEFINE FIELD turn ON tool_call TYPE option<record<turn>>;
DEFINE FIELD tool ON tool_call TYPE record<tool>;
DEFINE FIELD seq ON tool_call TYPE int;
DEFINE FIELD call_id ON tool_call TYPE option<string>;
DEFINE FIELD ts ON tool_call TYPE datetime;
DEFINE FIELD cwd ON tool_call TYPE option<string>;
DEFINE FIELD repository ON tool_call TYPE option<record<repository>>;
DEFINE FIELD checkout ON tool_call TYPE option<record<checkout>>;
DEFINE FIELD args ON tool_call TYPE option<string>;
DEFINE FIELD command_text ON tool_call TYPE option<string>;
DEFINE FIELD command_norm ON tool_call TYPE option<string>;
DEFINE FIELD command_tool ON tool_call TYPE option<record<tool>>;
DEFINE FIELD output_excerpt ON tool_call TYPE option<string>;
DEFINE FIELD error_text ON tool_call TYPE option<string>;
DEFINE FIELD exit_code ON tool_call TYPE option<int>;
DEFINE FIELD duration_ms ON tool_call TYPE option<int>;
DEFINE FIELD has_error ON tool_call TYPE bool DEFAULT false;
DEFINE INDEX tool_call_session_ts ON tool_call FIELDS session, ts;
DEFINE INDEX tool_call_tool_ts ON tool_call FIELDS tool, ts;
DEFINE INDEX tool_call_command_norm ON tool_call FIELDS command_norm;

DEFINE TABLE plan SCHEMAFULL;
DEFINE FIELD session ON plan TYPE record<session>;
DEFINE FIELD source ON plan TYPE string;
DEFINE FIELD status ON plan TYPE string;
DEFINE FIELD created_at ON plan TYPE datetime;
DEFINE FIELD updated_at ON plan TYPE datetime;
DEFINE FIELD raw_artifact ON plan TYPE option<record<artifact>>;
DEFINE INDEX plan_session ON plan FIELDS session;

DEFINE TABLE plan_item SCHEMAFULL;
DEFINE FIELD plan ON plan_item TYPE record<plan>;
DEFINE FIELD external_id ON plan_item TYPE option<string>;
DEFINE FIELD seq ON plan_item TYPE int;
DEFINE FIELD content ON plan_item TYPE string;
DEFINE FIELD active_form ON plan_item TYPE option<string>;
DEFINE FIELD status ON plan_item TYPE string;
DEFINE FIELD first_seen_at ON plan_item TYPE datetime;
DEFINE FIELD last_seen_at ON plan_item TYPE datetime;
DEFINE INDEX plan_item_plan_seq ON plan_item FIELDS plan, seq UNIQUE;

DEFINE TABLE artifact SCHEMAFULL;
DEFINE FIELD kind ON artifact TYPE string;
DEFINE FIELD source ON artifact TYPE string;
DEFINE FIELD uri ON artifact TYPE string;
DEFINE FIELD content_hash ON artifact TYPE option<string>;
DEFINE FIELD bytes ON artifact TYPE option<int>;
DEFINE FIELD mime ON artifact TYPE option<string>;
DEFINE FIELD created_at ON artifact TYPE datetime VALUE time::now();
DEFINE INDEX artifact_uri_uq ON artifact FIELDS uri UNIQUE;

DEFINE TABLE plan_snapshot SCHEMAFULL;
DEFINE FIELD plan ON plan_snapshot TYPE record<plan>;
DEFINE FIELD tool_call ON plan_snapshot TYPE option<record<tool_call>>;
DEFINE FIELD items_json ON plan_snapshot TYPE string;
DEFINE FIELD explanation ON plan_snapshot TYPE option<string>;
DEFINE FIELD ts ON plan_snapshot TYPE datetime;
DEFINE INDEX plan_snapshot_plan_ts ON plan_snapshot FIELDS plan, ts;

DEFINE TABLE insight SCHEMAFULL;
DEFINE FIELD subject_type ON insight TYPE string;
DEFINE FIELD subject_id ON insight TYPE option<string>;
DEFINE FIELD kind ON insight TYPE string;
DEFINE FIELD source ON insight TYPE string;
DEFINE FIELD model ON insight TYPE option<string>;
DEFINE FIELD prompt_version ON insight TYPE option<string>;
DEFINE FIELD confidence ON insight TYPE string;
DEFINE FIELD title ON insight TYPE option<string>;
DEFINE FIELD text ON insight TYPE option<string>;
DEFINE FIELD labels_json ON insight TYPE option<string>;
DEFINE FIELD metrics_json ON insight TYPE option<string>;
DEFINE FIELD source_path ON insight TYPE option<string>;
DEFINE FIELD created_at ON insight TYPE datetime VALUE time::now();
DEFINE INDEX insight_subject ON insight FIELDS subject_type, subject_id;

DEFINE TABLE friction_event SCHEMAFULL;
DEFINE FIELD session ON friction_event TYPE record<session>;
DEFINE FIELD turn ON friction_event TYPE option<record<turn>>;
DEFINE FIELD tool_call ON friction_event TYPE option<record<tool_call>>;
DEFINE FIELD repository ON friction_event TYPE option<record<repository>>;
DEFINE FIELD checkout ON friction_event TYPE option<record<checkout>>;
DEFINE FIELD changeset ON friction_event TYPE option<record<changeset>>;
DEFINE FIELD target_type ON friction_event TYPE string;
DEFINE FIELD target_file ON friction_event TYPE option<record<file>>;
DEFINE FIELD target_tool ON friction_event TYPE option<record<tool>>;
DEFINE FIELD target_skill ON friction_event TYPE option<record<skill>>;
DEFINE FIELD target_name ON friction_event TYPE option<string>;
DEFINE FIELD kind ON friction_event TYPE string;
DEFINE FIELD raw_kind ON friction_event TYPE option<string>;
DEFINE FIELD severity ON friction_event TYPE string;
DEFINE FIELD source ON friction_event TYPE string;
DEFINE FIELD confidence ON friction_event TYPE string;
DEFINE FIELD evidence_text ON friction_event TYPE option<string>;
DEFINE FIELD detector ON friction_event TYPE option<string>;
DEFINE FIELD ts ON friction_event TYPE datetime;
DEFINE FIELD raw ON friction_event TYPE option<string>;
DEFINE INDEX friction_session_kind ON friction_event FIELDS session, kind;
DEFINE INDEX friction_repo_kind ON friction_event FIELDS repository, kind;

DEFINE TABLE feedback_event SCHEMAFULL;
DEFINE FIELD session ON feedback_event TYPE record<session>;
DEFINE FIELD turn ON feedback_event TYPE record<turn>;
DEFINE FIELD kind ON feedback_event TYPE string;
DEFINE FIELD sentiment ON feedback_event TYPE string;
DEFINE FIELD target_type ON feedback_event TYPE string;
DEFINE FIELD evidence_text ON feedback_event TYPE option<string>;
DEFINE FIELD source ON feedback_event TYPE string;
DEFINE FIELD confidence ON feedback_event TYPE string;
DEFINE FIELD ts ON feedback_event TYPE datetime;
DEFINE INDEX feedback_session_kind ON feedback_event FIELDS session, kind;

DEFINE TABLE diagnostic_event SCHEMAFULL;
DEFINE FIELD session ON diagnostic_event TYPE record<session>;
DEFINE FIELD turn ON diagnostic_event TYPE option<record<turn>>;
DEFINE FIELD tool_call ON diagnostic_event TYPE option<record<tool_call>>;
DEFINE FIELD repository ON diagnostic_event TYPE option<record<repository>>;
DEFINE FIELD checkout ON diagnostic_event TYPE option<record<checkout>>;
DEFINE FIELD file ON diagnostic_event TYPE option<record<file>>;
DEFINE FIELD tool ON diagnostic_event TYPE option<record<tool>>;
DEFINE FIELD kind ON diagnostic_event TYPE string;
DEFINE FIELD severity ON diagnostic_event TYPE string;
DEFINE FIELD message_excerpt ON diagnostic_event TYPE option<string>;
DEFINE FIELD line ON diagnostic_event TYPE option<int>;
DEFINE FIELD column ON diagnostic_event TYPE option<int>;
DEFINE FIELD command_norm ON diagnostic_event TYPE option<string>;
DEFINE FIELD source ON diagnostic_event TYPE string;
DEFINE FIELD ts ON diagnostic_event TYPE datetime;
DEFINE INDEX diagnostic_session_kind ON diagnostic_event FIELDS session, kind;
DEFINE INDEX diagnostic_file ON diagnostic_event FIELDS file;

DEFINE TABLE recommendation SCHEMAFULL;
DEFINE FIELD kind ON recommendation TYPE string;
DEFINE FIELD scope ON recommendation TYPE string;
DEFINE FIELD repository ON recommendation TYPE option<record<repository>>;
DEFINE FIELD checkout ON recommendation TYPE option<record<checkout>>;
DEFINE FIELD workspace ON recommendation TYPE option<record<workspace>>;
DEFINE FIELD title ON recommendation TYPE string;
DEFINE FIELD rationale ON recommendation TYPE string;
DEFINE FIELD status ON recommendation TYPE string;
DEFINE FIELD source ON recommendation TYPE string;
DEFINE FIELD confidence ON recommendation TYPE string;
DEFINE FIELD created_at ON recommendation TYPE datetime VALUE time::now();
DEFINE FIELD updated_at ON recommendation TYPE datetime VALUE time::now();
DEFINE INDEX recommendation_status ON recommendation FIELDS status;

DEFINE TABLE guidance SCHEMAFULL;
DEFINE FIELD kind ON guidance TYPE string;
DEFINE FIELD scope ON guidance TYPE string;
DEFINE FIELD repository ON guidance TYPE option<record<repository>>;
DEFINE FIELD checkout ON guidance TYPE option<record<checkout>>;
DEFINE FIELD path ON guidance TYPE option<string>;
DEFINE FIELD title ON guidance TYPE string;
DEFINE FIELD enabled ON guidance TYPE bool DEFAULT true;
DEFINE FIELD current_version ON guidance TYPE option<record<guidance_version>>;
DEFINE INDEX guidance_scope ON guidance FIELDS scope, kind;

DEFINE TABLE guidance_version SCHEMAFULL;
DEFINE FIELD guidance ON guidance_version TYPE record<guidance>;
DEFINE FIELD content_hash ON guidance_version TYPE string;
DEFINE FIELD text_excerpt ON guidance_version TYPE option<string>;
DEFINE FIELD git_commit ON guidance_version TYPE option<record<commit>>;
DEFINE FIELD observed_at ON guidance_version TYPE datetime;
DEFINE FIELD valid_from ON guidance_version TYPE datetime;
DEFINE FIELD valid_to ON guidance_version TYPE option<datetime>;
DEFINE FIELD source ON guidance_version TYPE string;
DEFINE INDEX guidance_version_guidance ON guidance_version FIELDS guidance, valid_from;

DEFINE TABLE concerns TYPE RELATION SCHEMAFULL;
DEFINE FIELD source ON concerns TYPE string;
DEFINE FIELD ref_text ON concerns TYPE option<string>;
DEFINE FIELD confidence ON concerns TYPE string;
DEFINE FIELD weight ON concerns TYPE option<float>;
DEFINE FIELD ts ON concerns TYPE datetime VALUE time::now();
DEFINE INDEX concerns_in ON concerns FIELDS in;
DEFINE INDEX concerns_out ON concerns FIELDS out;

DEFINE TABLE includes TYPE RELATION FROM changeset TO file_memory;
DEFINE FIELD ts ON includes TYPE datetime VALUE time::now();

DEFINE TABLE involves TYPE RELATION FROM changeset TO file;
DEFINE FIELD role ON involves TYPE string DEFAULT "committed";
DEFINE FIELD source ON involves TYPE string DEFAULT "derived";
DEFINE FIELD confidence ON involves TYPE string DEFAULT "observed";
DEFINE FIELD ts ON involves TYPE datetime VALUE time::now();

DEFINE TABLE resulted_in TYPE RELATION SCHEMAFULL;
DEFINE FIELD ts ON resulted_in TYPE datetime VALUE time::now();

DEFINE TABLE supersedes TYPE RELATION SCHEMAFULL;
DEFINE FIELD ts ON supersedes TYPE datetime VALUE time::now();

DEFINE TABLE produced_artifact TYPE RELATION SCHEMAFULL;
DEFINE FIELD ts ON produced_artifact TYPE datetime VALUE time::now();

DEFINE TABLE has_artifact TYPE RELATION SCHEMAFULL;
DEFINE FIELD ts ON has_artifact TYPE datetime VALUE time::now();

DEFINE TABLE derived_from TYPE RELATION SCHEMAFULL;
DEFINE FIELD ts ON derived_from TYPE datetime VALUE time::now();
```

- [ ] **Step 2: Add change memory tables**

Add this block after `commit`:

```sql
DEFINE TABLE changeset SCHEMAFULL;
DEFINE FIELD repository ON changeset TYPE record<repository>;
DEFINE FIELD commit ON changeset TYPE option<record<commit>>;
DEFINE FIELD session ON changeset TYPE option<record<session>>;
DEFINE FIELD ts ON changeset TYPE datetime;
DEFINE FIELD source ON changeset TYPE string;
DEFINE FIELD status ON changeset TYPE string DEFAULT "current";
DEFINE FIELD superseded_by ON changeset TYPE option<record<changeset>>;
DEFINE FIELD title ON changeset TYPE option<string>;
DEFINE FIELD summary_text ON changeset TYPE option<string>;
DEFINE INDEX changeset_repo_ts ON changeset FIELDS repository, ts;
DEFINE INDEX changeset_status ON changeset FIELDS status;

DEFINE TABLE file_memory SCHEMAFULL;
DEFINE FIELD repository ON file_memory TYPE record<repository>;
DEFINE FIELD file ON file_memory TYPE record<file>;
DEFINE FIELD changeset ON file_memory TYPE record<changeset>;
DEFINE FIELD commit ON file_memory TYPE option<record<commit>>;
DEFINE FIELD session ON file_memory TYPE option<record<session>>;
DEFINE FIELD turn ON file_memory TYPE option<record<turn>>;
DEFINE FIELD ts ON file_memory TYPE datetime;
DEFINE FIELD source ON file_memory TYPE string;
DEFINE FIELD confidence ON file_memory TYPE string;
DEFINE FIELD status ON file_memory TYPE string DEFAULT "current";
DEFINE FIELD superseded_by ON file_memory TYPE option<record<file_memory>>;
DEFINE FIELD generation ON file_memory TYPE int DEFAULT 1;
DEFINE FIELD title ON file_memory TYPE option<string>;
DEFINE FIELD text ON file_memory TYPE string;
DEFINE FIELD additions ON file_memory TYPE option<int>;
DEFINE FIELD deletions ON file_memory TYPE option<int>;
DEFINE INDEX file_memory_file_ts ON file_memory FIELDS file, ts;
DEFINE INDEX file_memory_status ON file_memory FIELDS status;

DEFINE ANALYZER IF NOT EXISTS memory_text
    TOKENIZERS class
    FILTERS lowercase, ngram(2, 12);
DEFINE INDEX IF NOT EXISTS changeset_search_summary
    ON changeset FIELDS summary_text
    FULLTEXT ANALYZER memory_text BM25 HIGHLIGHTS;
DEFINE INDEX IF NOT EXISTS file_memory_search_text
    ON file_memory FIELDS text
    FULLTEXT ANALYZER memory_text BM25 HIGHLIGHTS;
```

- [ ] **Step 3: Run schema smoke check**

Run: `bun run db:schema`

Expected: command exits 0 and SurrealDB accepts all `DEFINE TABLE` and `DEFINE FIELD` statements.

- [ ] **Step 4: Commit**

```bash
git add schema/schema.surql
git commit -m "feat: extend graph schema for agent evidence"
```

## Task 3: Repository And Checkout Identity

**Files:**
- Create: `src/ingest/repository-identity.ts`
- Create: `src/ingest/repository-identity.test.ts`
- Modify: `src/ingest/git.ts`
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`

- [ ] **Step 1: Write failing tests for identity helpers**

Create `src/ingest/repository-identity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeGitRemoteUrl, classifyCheckoutKind } from "./repository-identity.ts";

describe("normalizeGitRemoteUrl", () => {
    test("normalizes git ssh remote", () => {
        expect(normalizeGitRemoteUrl("git@github.com:Necmttn/agentctl.git")).toBe(
            "github.com/necmttn/agentctl",
        );
    });

    test("normalizes https remote", () => {
        expect(normalizeGitRemoteUrl("https://github.com/Necmttn/agentctl.git")).toBe(
            "github.com/necmttn/agentctl",
        );
    });

    test("returns null for empty remote", () => {
        expect(normalizeGitRemoteUrl("")).toBeNull();
    });
});

describe("classifyCheckoutKind", () => {
    test("detects worktree gitdir file", () => {
        expect(classifyCheckoutKind("gitdir: /Users/necmttn/Projects/repo/.git/worktrees/a")).toBe(
            "worktree",
        );
    });

    test("detects normal git directory", () => {
        expect(classifyCheckoutKind("directory")).toBe("normal");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/repository-identity.test.ts`

Expected: FAIL with `Cannot find module './repository-identity.ts'`.

- [ ] **Step 3: Implement identity helpers**

Create `src/ingest/repository-identity.ts`:

```ts
export function normalizeGitRemoteUrl(remote: string | null | undefined): string | null {
    const value = remote?.trim();
    if (!value) return null;
    const withoutGitSuffix = value.replace(/\.git$/i, "");
    const ssh = withoutGitSuffix.match(/^git@([^:]+):(.+)$/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
    const https = withoutGitSuffix.match(/^https?:\/\/(.+)$/i);
    if (https) return https[1].replace(/^www\./i, "").toLowerCase();
    return withoutGitSuffix.toLowerCase();
}

export function classifyCheckoutKind(gitEntry: string | null | undefined): "normal" | "worktree" {
    const value = gitEntry ?? "";
    return value.includes("/worktrees/") || value.startsWith("gitdir:") ? "worktree" : "normal";
}

export interface RepositoryIdentity {
    readonly identityKind: "remote" | "initial_commit" | "local_path_hash";
    readonly remoteUrl: string | null;
    readonly remoteUrlNormalized: string | null;
    readonly initialCommit: string | null;
    readonly checkoutRoot: string;
}

export function chooseIdentity(input: {
    readonly remoteUrl?: string | null;
    readonly initialCommit?: string | null;
    readonly checkoutRoot: string;
}): RepositoryIdentity {
    const remoteUrlNormalized = normalizeGitRemoteUrl(input.remoteUrl);
    if (remoteUrlNormalized) {
        return {
            identityKind: "remote",
            remoteUrl: input.remoteUrl ?? null,
            remoteUrlNormalized,
            initialCommit: input.initialCommit ?? null,
            checkoutRoot: input.checkoutRoot,
        };
    }
    if (input.initialCommit) {
        return {
            identityKind: "initial_commit",
            remoteUrl: input.remoteUrl ?? null,
            remoteUrlNormalized: null,
            initialCommit: input.initialCommit,
            checkoutRoot: input.checkoutRoot,
        };
    }
    return {
        identityKind: "local_path_hash",
        remoteUrl: input.remoteUrl ?? null,
        remoteUrlNormalized: null,
        initialCommit: null,
        checkoutRoot: input.checkoutRoot,
    };
}
```

- [ ] **Step 4: Run identity tests**

Run: `bun test src/ingest/repository-identity.test.ts`

Expected: PASS all 5 tests.

- [ ] **Step 5: Update Git ingest discovery fields**

Modify `src/ingest/git.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import {
    checkoutRecordKey,
    commitRecordKey,
    fileRecordKey,
    repositoryRecordKey,
} from "./record-keys.ts";
import { chooseIdentity, classifyCheckoutKind } from "./repository-identity.ts";
import type { DbError } from "../lib/errors.ts";
```

Change `RepoInfo`:

```ts
interface RepoInfo {
    path: string;
    repositoryKey: string;
    checkoutKey: string;
    identityKind: "remote" | "initial_commit" | "local_path_hash";
    remoteUrl: string | null;
    remoteUrlNormalized: string | null;
    initialCommit: string | null;
    gitDir: string | null;
    branch: string | null;
    worktreeKind: "normal" | "worktree";
}
```

Add these helpers near `runGit`:

```ts
async function readGitEntry(path: string): Promise<string> {
    try {
        const entry = await Bun.file(join(path, ".git")).text();
        return entry.trim();
    } catch {
        return "directory";
    }
}

const runGitText = async (cwd: string, args: string[]): Promise<string | null> => {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? stdout.trim() : null;
};

async function enrichRepo(path: string): Promise<RepoInfo> {
    const [remoteUrl, initialCommit, branch, gitEntry] = await Promise.all([
        runGitText(path, ["config", "--get", "remote.origin.url"]),
        runGitText(path, ["rev-list", "--max-parents=0", "HEAD"]),
        runGitText(path, ["branch", "--show-current"]),
        readGitEntry(path),
    ]);
    const identity = chooseIdentity({ remoteUrl, initialCommit, checkoutRoot: path });
    const repositoryKey = repositoryRecordKey({
        remoteUrlNormalized: identity.remoteUrlNormalized,
        initialCommit: identity.initialCommit,
        checkoutRoot: path,
    });
    return {
        path,
        repositoryKey,
        checkoutKey: checkoutRecordKey(path),
        identityKind: identity.identityKind,
        remoteUrl: identity.remoteUrl,
        remoteUrlNormalized: identity.remoteUrlNormalized,
        initialCommit: identity.initialCommit,
        gitDir: gitEntry,
        branch,
        worktreeKind: classifyCheckoutKind(gitEntry),
    };
}
```

Change `discoverRepos` to call `enrichRepo(p)` instead of building `{ path, slug }`.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
bun test src/ingest/repository-identity.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/repository-identity.ts src/ingest/repository-identity.test.ts src/ingest/git.ts src/ingest/transcripts.ts src/ingest/codex.ts
git commit -m "feat: resolve repository and checkout identity"
```

## Task 4: Tool And Tool Call Normalization

**Files:**
- Create: `src/ingest/tool-calls.ts`
- Create: `src/ingest/tool-calls.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingest/tool-calls.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    extractCommandTool,
    normalizeCommand,
    parseCodexFunctionOutput,
    toolKindForName,
} from "./tool-calls.ts";

describe("tool call helpers", () => {
    test("classifies builtin tool names", () => {
        expect(toolKindForName("Bash")).toBe("builtin");
        expect(toolKindForName("mcp__browser__open")).toBe("mcp");
        expect(toolKindForName("Skill")).toBe("skill");
        expect(toolKindForName("/insights")).toBe("slash_command");
    });

    test("extracts command tool from bash command", () => {
        expect(extractCommandTool("git status --short")).toBe("git");
        expect(extractCommandTool("bun test src/ingest/tool-calls.test.ts")).toBe("bun");
        expect(extractCommandTool("cd src && bun test")).toBe("bun");
    });

    test("normalizes commands to stable patterns", () => {
        expect(normalizeCommand("git status --short")).toBe("git status");
        expect(normalizeCommand("bun test src/ingest/tool-calls.test.ts")).toBe("bun test");
        expect(normalizeCommand("surreal sql --conn http://127.0.0.1:8521")).toBe("surreal sql");
    });

    test("parses Codex function output metadata", () => {
        const parsed = parseCodexFunctionOutput(
            "Chunk ID: abc\\nWall time: 0.1000 seconds\\nProcess exited with code 2\\nOriginal token count: 30\\nOutput:\\nrg: missing\\n",
        );

        expect(parsed).toEqual({
            exitCode: 2,
            durationMs: 100,
            outputExcerpt: "rg: missing",
            hasError: true,
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/tool-calls.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement helpers**

Create `src/ingest/tool-calls.ts`:

```ts
export type ToolKind = "builtin" | "cli" | "mcp" | "skill" | "slash_command" | "api" | "unknown";

export function toolKindForName(name: string): ToolKind {
    if (name.startsWith("mcp__")) return "mcp";
    if (name.startsWith("/")) return "slash_command";
    if (name === "Skill") return "skill";
    if (/^[a-z0-9._-]+$/i.test(name) && ["git", "gh", "bun", "surreal", "npm", "pnpm", "yarn"].includes(name)) {
        return "cli";
    }
    if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return "builtin";
    return "unknown";
}

const COMMAND_PREFIXES = ["cd", "env", "time", "sudo"];

export function extractCommandTool(command: string | null | undefined): string | null {
    if (!command) return null;
    const cleaned = command.replace(/&&/g, " && ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < cleaned.length; i += 1) {
        const token = cleaned[i];
        if (token === "&&" || token === "||" || token === ";") continue;
        if (COMMAND_PREFIXES.includes(token)) continue;
        if (token.includes("=") && !token.includes("/")) continue;
        return token.replace(/^["']|["']$/g, "");
    }
    return null;
}

export function normalizeCommand(command: string | null | undefined): string | null {
    const tool = extractCommandTool(command);
    if (!tool || !command) return null;
    const afterTool = command.slice(command.indexOf(tool) + tool.length).trim();
    const firstArg = afterTool.split(/\s+/).find((part) => part.length > 0 && !part.startsWith("-"));
    return firstArg ? `${tool} ${firstArg}` : tool;
}

export interface ParsedFunctionOutput {
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    readonly outputExcerpt: string | null;
    readonly hasError: boolean;
}

export function parseCodexFunctionOutput(output: string | null | undefined): ParsedFunctionOutput {
    const text = output ?? "";
    const codeMatch = text.match(/Process exited with code (-?\d+)/);
    const wallMatch = text.match(/Wall time: ([0-9.]+) seconds/);
    const outputMarker = "Output:\\n";
    const markerIndex = text.indexOf(outputMarker);
    const outputText = markerIndex >= 0 ? text.slice(markerIndex + outputMarker.length).trim() : text.trim();
    const exitCode = codeMatch ? Number.parseInt(codeMatch[1], 10) : null;
    return {
        exitCode,
        durationMs: wallMatch ? Math.round(Number.parseFloat(wallMatch[1]) * 1000) : null,
        outputExcerpt: outputText.length > 0 ? outputText.slice(0, 1200) : null,
        hasError: exitCode !== null && exitCode !== 0,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ingest/tool-calls.test.ts`

Expected: PASS all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/tool-calls.ts src/ingest/tool-calls.test.ts
git commit -m "feat: normalize agent tool calls"
```

## Task 5: Plan Snapshot Normalization

**Files:**
- Create: `src/ingest/plans.ts`
- Create: `src/ingest/plans.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingest/plans.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    normalizeClaudeTodoWrite,
    normalizeCodexUpdatePlan,
} from "./plans.ts";

describe("plan normalization", () => {
    test("normalizes Claude TodoWrite snapshot", () => {
        const snapshot = normalizeClaudeTodoWrite({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                todos: [
                    { content: "Inspect schema", activeForm: "Inspecting schema", status: "completed" },
                    { content: "Add tests", activeForm: "Adding tests", status: "in_progress" },
                ],
            },
        });

        expect(snapshot.source).toBe("claude_todowrite");
        expect(snapshot.items).toEqual([
            { externalId: null, seq: 1, content: "Inspect schema", activeForm: "Inspecting schema", status: "completed" },
            { externalId: null, seq: 2, content: "Add tests", activeForm: "Adding tests", status: "in_progress" },
        ]);
    });

    test("normalizes Codex update_plan snapshot", () => {
        const snapshot = normalizeCodexUpdatePlan({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                explanation: "Following the plan gate.",
                plan: [
                    { step: "Inspect files", status: "completed" },
                    { step: "Patch schema", status: "pending" },
                ],
            },
        });

        expect(snapshot.source).toBe("codex_update_plan");
        expect(snapshot.explanation).toBe("Following the plan gate.");
        expect(snapshot.items[1]).toEqual({
            externalId: null,
            seq: 2,
            content: "Patch schema",
            activeForm: null,
            status: "pending",
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/plans.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement plan helpers**

Create `src/ingest/plans.ts`:

```ts
export type PlanStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface NormalizedPlanItem {
    readonly externalId: string | null;
    readonly seq: number;
    readonly content: string;
    readonly activeForm: string | null;
    readonly status: PlanStatus;
}

export interface NormalizedPlanSnapshot {
    readonly sessionId: string;
    readonly source: "claude_todowrite" | "claude_task" | "codex_update_plan";
    readonly ts: string;
    readonly explanation: string | null;
    readonly items: NormalizedPlanItem[];
}

function normalizeStatus(status: unknown): PlanStatus {
    return status === "in_progress" || status === "completed" || status === "abandoned"
        ? status
        : "pending";
}

export function normalizeClaudeTodoWrite(input: {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
}): NormalizedPlanSnapshot {
    const raw = input.input as { todos?: Array<Record<string, unknown>> };
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    return {
        sessionId: input.sessionId,
        source: "claude_todowrite",
        ts: input.ts,
        explanation: null,
        items: todos.map((todo, index) => ({
            externalId: typeof todo.id === "string" ? todo.id : null,
            seq: index + 1,
            content: String(todo.content ?? ""),
            activeForm: typeof todo.activeForm === "string" ? todo.activeForm : null,
            status: normalizeStatus(todo.status),
        })).filter((item) => item.content.length > 0),
    };
}

export function normalizeCodexUpdatePlan(input: {
    readonly sessionId: string;
    readonly ts: string;
    readonly input: unknown;
}): NormalizedPlanSnapshot {
    const raw = input.input as {
        readonly plan?: Array<Record<string, unknown>>;
        readonly explanation?: unknown;
    };
    const plan = Array.isArray(raw.plan) ? raw.plan : [];
    return {
        sessionId: input.sessionId,
        source: "codex_update_plan",
        ts: input.ts,
        explanation: typeof raw.explanation === "string" ? raw.explanation : null,
        items: plan.map((item, index) => ({
            externalId: null,
            seq: index + 1,
            content: String(item.step ?? ""),
            activeForm: null,
            status: normalizeStatus(item.status),
        })).filter((item) => item.content.length > 0),
    };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/plans.test.ts`

Expected: PASS all 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/plans.ts src/ingest/plans.test.ts
git commit -m "feat: normalize agent plan snapshots"
```

## Task 6: Evidence Writers

**Files:**
- Create: `src/ingest/evidence-writers.ts`
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`

- [ ] **Step 1: Create writer module**

Create `src/ingest/evidence-writers.ts`:

```ts
import { Effect } from "effect";
import { RecordId, SurrealClient } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { toolCallRecordKey, toolRecordKey } from "./record-keys.ts";
import type { DbError } from "../lib/errors.ts";

const q = (value: string): string => JSON.stringify(value);
const opt = (value: string | number | boolean | null | undefined): string =>
    value === null || value === undefined ? "NONE" : JSON.stringify(value);

export interface ToolCallWrite {
    readonly sessionId: string;
    readonly turnKey: string | null;
    readonly provider: string;
    readonly toolName: string;
    readonly toolKind: string;
    readonly seq: number;
    readonly callId: string | null;
    readonly ts: string;
    readonly cwd: string | null;
    readonly argsJson: string | null;
    readonly commandText: string | null;
    readonly commandNorm: string | null;
    readonly commandToolName: string | null;
    readonly outputExcerpt: string | null;
    readonly errorText: string | null;
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    readonly hasError: boolean;
}

export const writeToolCalls = (calls: readonly ToolCallWrite[]) =>
    Effect.gen(function* () {
        if (calls.length === 0) return;
        const db = yield* SurrealClient;
        const stmts: string[] = [];
        for (const call of calls) {
            const toolKey = toolRecordKey({ provider: call.provider, kind: call.toolKind, name: call.toolName });
            stmts.push(`UPSERT tool:\`${toolKey}\` MERGE { name: ${q(call.toolName)}, kind: ${q(call.toolKind)}, provider: ${q(call.provider)}, last_seen_at: d"${call.ts}" };`);
            if (call.commandToolName) {
                const commandToolKey = toolRecordKey({ provider: "local", kind: "cli", name: call.commandToolName });
                stmts.push(`UPSERT tool:\`${commandToolKey}\` MERGE { name: ${q(call.commandToolName)}, kind: "cli", provider: "local", last_seen_at: d"${call.ts}" };`);
            }
            const callKey = toolCallRecordKey({ sessionId: call.sessionId, seq: call.seq, callId: call.callId });
            const turn = call.turnKey ? `turn:\`${call.turnKey}\`` : "NONE";
            const commandTool = call.commandToolName
                ? `tool:\`${toolRecordKey({ provider: "local", kind: "cli", name: call.commandToolName })}\``
                : "NONE";
            stmts.push(`UPSERT tool_call:\`${callKey}\` CONTENT { session: session:\`${call.sessionId}\`, turn: ${turn}, tool: tool:\`${toolKey}\`, seq: ${call.seq}, call_id: ${opt(call.callId)}, ts: d"${call.ts}", cwd: ${opt(call.cwd)}, args: ${opt(call.argsJson)}, command_text: ${opt(call.commandText)}, command_norm: ${opt(call.commandNorm)}, command_tool: ${commandTool}, output_excerpt: ${opt(call.outputExcerpt)}, error_text: ${opt(call.errorText)}, exit_code: ${call.exitCode ?? "NONE"}, duration_ms: ${call.durationMs ?? "NONE"}, has_error: ${call.hasError} };`);
        }
        for (let i = 0; i < stmts.length; i += 250) {
            yield* db.query(stmts.slice(i, i + 250).join(""));
        }
    });

export const relateToolCallSkill = (input: {
    readonly sessionId: string;
    readonly seq: number;
    readonly callId: string | null;
    readonly skillName: string;
    readonly ts: string;
    readonly argsJson: string;
    readonly hasError: boolean;
}) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const callKey = toolCallRecordKey(input);
        const skillKey = skillRecordKey(input.skillName);
        yield* db.query(
            `UPSERT skill:\`${skillKey}\` MERGE { name: ${q(input.skillName)}, scope: "unknown", dir_path: "(unknown)", content_hash: "unknown" };
             RELATE tool_call:\`${callKey}\`->invoked->skill:\`${skillKey}\` SET ts = d"${input.ts}", args = ${q(input.argsJson)}, turn_has_error = ${input.hasError};`,
        );
    });

export interface PlanSnapshotWrite {
    readonly planKey: string;
    readonly sessionId: string;
    readonly source: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly snapshotKey: string;
    readonly toolCallKey: string | null;
    readonly itemsJson: string;
    readonly explanation: string | null;
    readonly ts: string;
    readonly items: readonly {
        readonly key: string;
        readonly externalId: string | null;
        readonly seq: number;
        readonly content: string;
        readonly activeForm: string | null;
        readonly status: string;
    }[];
}

export const writePlanSnapshot = (snapshot: PlanSnapshotWrite) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const toolCall = snapshot.toolCallKey ? `tool_call:\`${snapshot.toolCallKey}\`` : "NONE";
        const stmts: string[] = [
            `UPSERT plan:\`${snapshot.planKey}\` MERGE { session: session:\`${snapshot.sessionId}\`, source: ${q(snapshot.source)}, status: ${q(snapshot.status)}, created_at: d"${snapshot.createdAt}", updated_at: d"${snapshot.updatedAt}" };`,
            `UPSERT plan_snapshot:\`${snapshot.snapshotKey}\` CONTENT { plan: plan:\`${snapshot.planKey}\`, tool_call: ${toolCall}, items_json: ${q(snapshot.itemsJson)}, explanation: ${opt(snapshot.explanation)}, ts: d"${snapshot.ts}" };`,
        ];
        for (const item of snapshot.items) {
            stmts.push(`UPSERT plan_item:\`${item.key}\` CONTENT { plan: plan:\`${snapshot.planKey}\`, external_id: ${opt(item.externalId)}, seq: ${item.seq}, content: ${q(item.content)}, active_form: ${opt(item.activeForm)}, status: ${q(item.status)}, first_seen_at: d"${snapshot.createdAt}", last_seen_at: d"${snapshot.updatedAt}" };`);
        }
        yield* db.query(stmts.join(""));
    });
```

- [ ] **Step 2: Run typecheck to catch writer syntax issues**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ingest/evidence-writers.ts src/ingest/transcripts.ts src/ingest/codex.ts
git commit -m "feat: add evidence graph writers"
```

## Task 7: Upgrade Claude Transcript Ingest

**Files:**
- Modify: `src/ingest/transcripts.ts`
- Test: `src/ingest/plans.test.ts`
- Test: `src/ingest/tool-calls.test.ts`

- [ ] **Step 1: Extend extracted data types**

In `src/ingest/transcripts.ts`, import helpers:

```ts
import { normalizeCommand, extractCommandTool, toolKindForName } from "./tool-calls.ts";
import { normalizeClaudeTodoWrite } from "./plans.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { writePlanSnapshot, writeToolCalls, type ToolCallWrite } from "./evidence-writers.ts";
```

Add interfaces:

```ts
interface ExtractedToolCall extends ToolCallWrite {
    readonly editPath: string | null;
    readonly editTool: string | null;
    readonly invokedSkill: string | null;
}

interface ExtractedPlanSnapshot {
    readonly sessionId: string;
    readonly ts: string;
    readonly toolCallSeq: number;
    readonly callId: string | null;
    readonly source: string;
    readonly itemsJson: string;
    readonly explanation: string | null;
    readonly items: readonly {
        readonly seq: number;
        readonly externalId: string | null;
        readonly content: string;
        readonly activeForm: string | null;
        readonly status: string;
    }[];
}
```

- [ ] **Step 2: Emit tool calls inside `extractFile`**

Inside the `block.type === "tool_use"` branch, add:

```ts
const toolName = block.name ?? "unknown";
const argsJson = JSON.stringify(block.input ?? {});
const commandText = toolName === "Bash" && typeof block.input?.command === "string"
    ? block.input.command
    : null;
const commandToolName = extractCommandTool(commandText);
toolCalls.push({
    sessionId,
    turnKey: turnRecordKey(sessionId, seq),
    provider: "claude",
    toolName,
    toolKind: toolKindForName(toolName),
    seq,
    callId: typeof (block as { id?: unknown }).id === "string" ? (block as { id: string }).id : null,
    ts,
    cwd,
    argsJson,
    commandText,
    commandNorm: normalizeCommand(commandText),
    commandToolName,
    outputExcerpt: null,
    errorText: null,
    exitCode: null,
    durationMs: null,
    hasError: false,
    editPath: null,
    editTool: null,
    invokedSkill: null,
});
```

When the tool is `Skill`, set `invokedSkill` to the skill name already detected. When the tool is `Edit`, `Write`, or `NotebookEdit`, set `editPath` and `editTool`.

- [ ] **Step 3: Normalize Claude `TodoWrite` plans**

When `toolName === "TodoWrite"`, call:

```ts
const snapshot = normalizeClaudeTodoWrite({
    sessionId,
    ts,
    input: block.input ?? {},
});
if (snapshot.items.length > 0) {
    planSnapshots.push({
        sessionId,
        ts,
        toolCallSeq: seq,
        callId: typeof (block as { id?: unknown }).id === "string" ? (block as { id: string }).id : null,
        source: snapshot.source,
        itemsJson: JSON.stringify(snapshot.items),
        explanation: snapshot.explanation,
        items: snapshot.items,
    });
}
```

- [ ] **Step 4: Write tool calls and plan snapshots after turns**

After `yield* upsertTurns(extracted.turns);`, add:

```ts
yield* writeToolCalls(extracted.toolCalls);
for (const snapshot of extracted.planSnapshots) {
    const planKey = `${snapshot.sessionId.replace(/-/g, "")}__${snapshot.source}`;
    const toolCallKey = toolCallRecordKey({
        sessionId: snapshot.sessionId,
        seq: snapshot.toolCallSeq,
        callId: snapshot.callId,
    });
    yield* writePlanSnapshot({
        planKey,
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        status: snapshot.items.every((item) => item.status === "completed") ? "completed" : "active",
        createdAt: snapshot.ts,
        updatedAt: snapshot.ts,
        snapshotKey: `${planKey}__${Bun.hash(snapshot.itemsJson).toString(16).slice(0, 10)}`,
        toolCallKey,
        itemsJson: snapshot.itemsJson,
        explanation: snapshot.explanation,
        ts: snapshot.ts,
        items: snapshot.items.map((item) => ({
            key: `${planKey}__${item.seq}`,
            ...item,
        })),
    });
}
```

- [ ] **Step 5: Preserve compatibility edges**

Keep existing `relateInvocations` and `upsertEdits` calls. Add a comment immediately above them:

```ts
// Compatibility edges for existing taste/search commands. Canonical execution
// evidence is now stored in tool_call and tool-call-level relations.
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
bun test src/ingest/tool-calls.test.ts src/ingest/plans.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/transcripts.ts
git commit -m "feat: ingest Claude tool calls and plans"
```

## Task 8: Upgrade Codex Ingest

**Files:**
- Modify: `src/ingest/codex.ts`
- Test: `src/ingest/tool-calls.test.ts`
- Test: `src/ingest/plans.test.ts`

- [ ] **Step 1: Extend Codex extraction state**

In `src/ingest/codex.ts`, import:

```ts
import { normalizeCommand, extractCommandTool, parseCodexFunctionOutput, toolKindForName } from "./tool-calls.ts";
import { normalizeCodexUpdatePlan } from "./plans.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { writePlanSnapshot, writeToolCalls, type ToolCallWrite } from "./evidence-writers.ts";
```

Add to `CodexExtract`:

```ts
toolCalls: ToolCallWrite[];
planSnapshots: Array<{
    readonly sessionId: string;
    readonly ts: string;
    readonly seq: number;
    readonly callId: string | null;
    readonly source: string;
    readonly itemsJson: string;
    readonly explanation: string | null;
    readonly items: readonly {
        readonly seq: number;
        readonly externalId: string | null;
        readonly content: string;
        readonly activeForm: string | null;
        readonly status: string;
    }[];
}>;
```

- [ ] **Step 2: Track function calls by `call_id`**

Inside `extractCodexFile`, add:

```ts
const toolCalls: ToolCallWrite[] = [];
const callIndex = new Map<string, number>();
const planSnapshots: CodexExtract["planSnapshots"] = [];
```

When `itemType === "function_call"`, parse arguments:

```ts
const toolName = payload.name as string | undefined;
const callId = payload.call_id as string | undefined;
let parsedArgs: unknown = {};
try {
    parsedArgs = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : (payload.arguments ?? {});
} catch {
    parsedArgs = payload.arguments ?? {};
}
const commandText = toolName === "exec_command" && typeof (parsedArgs as { cmd?: unknown }).cmd === "string"
    ? String((parsedArgs as { cmd: string }).cmd)
    : null;
const call: ToolCallWrite = {
    sessionId: session.id,
    turnKey: turnRecordKey(session.id, seq),
    provider: "codex",
    toolName: toolName ?? "unknown",
    toolKind: toolKindForName(toolName ?? "unknown"),
    seq,
    callId: callId ?? null,
    ts,
    cwd: session.cwd,
    argsJson: JSON.stringify(parsedArgs),
    commandText,
    commandNorm: normalizeCommand(commandText),
    commandToolName: extractCommandTool(commandText),
    outputExcerpt: null,
    errorText: null,
    exitCode: null,
    durationMs: null,
    hasError: false,
};
toolCalls.push(call);
if (callId) callIndex.set(callId, toolCalls.length - 1);
```

- [ ] **Step 3: Parse Codex `update_plan`**

In the same `function_call` branch:

```ts
if (toolName === "update_plan") {
    const snapshot = normalizeCodexUpdatePlan({
        sessionId: session.id,
        ts,
        input: parsedArgs,
    });
    if (snapshot.items.length > 0) {
        planSnapshots.push({
            sessionId: session.id,
            ts,
            seq,
            callId: callId ?? null,
            source: snapshot.source,
            itemsJson: JSON.stringify(snapshot.items),
            explanation: snapshot.explanation,
            items: snapshot.items,
        });
    }
}
```

- [ ] **Step 4: Attach function outputs**

When `payload.type === "function_call_output"`:

```ts
const callId = payload.call_id as string | undefined;
const idx = callId ? callIndex.get(callId) : undefined;
if (idx !== undefined) {
    const parsed = parseCodexFunctionOutput(String(payload.output ?? ""));
    const previous = toolCalls[idx];
    toolCalls[idx] = {
        ...previous,
        outputExcerpt: parsed.outputExcerpt,
        errorText: parsed.hasError ? parsed.outputExcerpt : null,
        exitCode: parsed.exitCode,
        durationMs: parsed.durationMs,
        hasError: parsed.hasError,
    };
}
```

- [ ] **Step 5: Write Codex evidence after turns**

After Codex turns are written:

```ts
yield* writeToolCalls(extracted.toolCalls);
for (const snapshot of extracted.planSnapshots) {
    const planKey = `${snapshot.sessionId.replace(/-/g, "")}__${snapshot.source}`;
    yield* writePlanSnapshot({
        planKey,
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        status: snapshot.items.every((item) => item.status === "completed") ? "completed" : "active",
        createdAt: snapshot.ts,
        updatedAt: snapshot.ts,
        snapshotKey: `${planKey}__${Bun.hash(snapshot.itemsJson).toString(16).slice(0, 10)}`,
        toolCallKey: toolCallRecordKey({
            sessionId: snapshot.sessionId,
            seq: snapshot.seq,
            callId: snapshot.callId,
        }),
        itemsJson: snapshot.itemsJson,
        explanation: snapshot.explanation,
        ts: snapshot.ts,
        items: snapshot.items.map((item) => ({
            key: `${planKey}__${item.seq}`,
            ...item,
        })),
    });
}
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
bun test src/ingest/tool-calls.test.ts src/ingest/plans.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/codex.ts
git commit -m "feat: ingest Codex tool calls and plans"
```

## Task 9: Import Claude Insights

**Files:**
- Create: `src/ingest/claude-insights.ts`
- Create: `src/ingest/claude-insights.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write tests for facet conversion**

Create `src/ingest/claude-insights.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { facetToInsightAndFriction } from "./claude-insights.ts";

describe("facetToInsightAndFriction", () => {
    test("converts Claude facet to insight and coarse friction events", () => {
        const result = facetToInsightAndFriction({
            sourcePath: "/Users/me/.claude/usage-data/facets/s1.json",
            facet: {
                session_id: "s1",
                underlying_goal: "Fix broken local dev",
                goal_categories: { bug_fix: 1 },
                outcome: "mostly_achieved",
                user_satisfaction_counts: { likely_satisfied: 2 },
                claude_helpfulness: "very_helpful",
                session_type: "single_task",
                friction_counts: { wrong_approach: 1 },
                friction_detail: "Claude tried a migration before checking deploy state",
                primary_success: "good_debugging",
                brief_summary: "Diagnosed local dev and fixed proxy config.",
            },
        });

        expect(result.insight.subjectType).toBe("session");
        expect(result.insight.text).toBe("Diagnosed local dev and fixed proxy config.");
        expect(result.frictionEvents).toEqual([
            expect.objectContaining({
                sessionId: "s1",
                kind: "wrong_approach",
                rawKind: "wrong_approach",
                evidenceText: "Claude tried a migration before checking deploy state",
            }),
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/claude-insights.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement converter and importer**

Create `src/ingest/claude-insights.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

const USAGE_DATA_DIR = process.env.AGENTCTL_CLAUDE_USAGE_DIR ?? join(homedir(), ".claude", "usage-data");
const q = (value: string): string => JSON.stringify(value);

type Facet = Record<string, unknown> & { session_id?: string };

const normalizeFrictionKind = (kind: string): string => {
    const known = new Set([
        "retry",
        "tool_error",
        "failed_edit",
        "repeated_edit",
        "user_correction",
        "plan_revision",
        "wrong_approach",
        "misunderstood_request",
        "buggy_code",
        "excessive_changes",
        "runtime_limit",
        "environment_blocker",
        "external_blocker",
        "unresolved_work",
        "abandoned_edit",
    ]);
    if (known.has(kind)) return kind;
    if (kind.includes("token_limit")) return "runtime_limit";
    if (kind.includes("environment")) return "environment_blocker";
    return "unknown";
};

export function facetToInsightAndFriction(input: { readonly sourcePath: string; readonly facet: Facet }) {
    const sessionId = String(input.facet.session_id ?? "");
    const labels = {
        underlying_goal: input.facet.underlying_goal ?? null,
        goal_categories: input.facet.goal_categories ?? {},
        outcome: input.facet.outcome ?? null,
        user_satisfaction_counts: input.facet.user_satisfaction_counts ?? {},
        claude_helpfulness: input.facet.claude_helpfulness ?? null,
        session_type: input.facet.session_type ?? null,
        primary_success: input.facet.primary_success ?? null,
    };
    const frictionCounts = input.facet.friction_counts as Record<string, number> | undefined;
    const frictionDetail = typeof input.facet.friction_detail === "string" ? input.facet.friction_detail : "";
    return {
        insight: {
            sessionId,
            subjectType: "session",
            kind: "classification",
            source: "claude_insights",
            confidence: "inferred",
            title: typeof input.facet.underlying_goal === "string" ? input.facet.underlying_goal : null,
            text: typeof input.facet.brief_summary === "string" ? input.facet.brief_summary : null,
            labelsJson: JSON.stringify(labels),
            metricsJson: JSON.stringify({ friction_counts: frictionCounts ?? {} }),
            sourcePath: input.sourcePath,
        },
        frictionEvents: Object.entries(frictionCounts ?? {}).flatMap(([rawKind, count]) =>
            Array.from({ length: Number(count) || 0 }, (_, index) => ({
                key: `${sessionId}__claude_insights__${rawKind}__${index + 1}`,
                sessionId,
                kind: normalizeFrictionKind(rawKind),
                rawKind,
                evidenceText: frictionDetail || null,
                ts: new Date().toISOString(),
            })),
        ),
    };
}

export const ingestClaudeInsights = (): Effect.Effect<{ insights: number; frictionEvents: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const facetDir = join(USAGE_DATA_DIR, "facets");
        let files: string[] = [];
        try {
            files = (yield* Effect.promise(() => readdir(facetDir))).filter((name) => name.endsWith(".json"));
        } catch {
            return { insights: 0, frictionEvents: 0 };
        }
        let insights = 0;
        let frictionEvents = 0;
        for (const file of files) {
            const sourcePath = join(facetDir, file);
            const raw = yield* Effect.promise(() => readFile(sourcePath, "utf8"));
            const facet = JSON.parse(raw) as Facet;
            const converted = facetToInsightAndFriction({ sourcePath, facet });
            if (!converted.insight.sessionId) continue;
            const insightKey = `${converted.insight.sessionId}__claude_insights`;
            yield* db.query(`UPSERT insight:\`${insightKey}\` CONTENT { subject_type: "session", subject_id: ${q(`session:${converted.insight.sessionId}`)}, kind: "classification", source: "claude_insights", confidence: "inferred", title: ${converted.insight.title === null ? "NONE" : q(converted.insight.title)}, text: ${converted.insight.text === null ? "NONE" : q(converted.insight.text)}, labels_json: ${q(converted.insight.labelsJson)}, metrics_json: ${q(converted.insight.metricsJson)}, source_path: ${q(converted.insight.sourcePath)} };
             RELATE insight:\`${insightKey}\`->concerns->session:\`${converted.insight.sessionId}\` SET source = "imported", confidence = "inferred", ref_text = "claude_insights";`);
            insights += 1;
            for (const event of converted.frictionEvents) {
                yield* db.query(`UPSERT friction_event:\`${event.key}\` CONTENT { session: session:\`${event.sessionId}\`, target_type: "unknown", kind: ${q(event.kind)}, raw_kind: ${q(event.rawKind)}, severity: "medium", source: "imported", confidence: "inferred", evidence_text: ${event.evidenceText === null ? "NONE" : q(event.evidenceText)}, ts: d"${event.ts}" };`);
                frictionEvents += 1;
            }
        }
        return { insights, frictionEvents };
    });
```

- [ ] **Step 4: Add CLI command**

Modify `src/cli/index.ts` imports:

```ts
import { ingestClaudeInsights } from "../ingest/claude-insights.ts";
```

Add help line:

```text
  agentctl ingest-insights
```

Add command branch:

```ts
if (cmd === "ingest-insights") {
    await Effect.runPromise(
        ingestClaudeInsights().pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>,
    );
    return;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
bun test src/ingest/claude-insights.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/claude-insights.ts src/ingest/claude-insights.test.ts src/cli/index.ts
git commit -m "feat: import Claude insight facets"
```

## Task 10: Query Adapter And Example Queries

**Files:**
- Create: `src/queries/insights.ts`
- Create: `src/queries/insights.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `docs/repo-file-change-graph-design.md`

- [ ] **Step 1: Write query adapter tests**

Create `src/queries/insights.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    recentFrictionSql,
    repositoryOverviewSql,
    toolFailuresSql,
} from "./insights.ts";

describe("insight query SQL", () => {
    test("repository overview query reads repository and checkout tables", () => {
        const sql = repositoryOverviewSql(10);

        expect(sql).toContain("FROM repository");
        expect(sql).toContain("LIMIT 10");
        expect(sql).toContain("->has_checkout");
    });

    test("recent friction query uses friction_event table", () => {
        const sql = recentFrictionSql(20);

        expect(sql).toContain("FROM friction_event");
        expect(sql).toContain("ORDER BY ts DESC");
        expect(sql).toContain("LIMIT 20");
    });

    test("tool failures query groups tool calls", () => {
        const sql = toolFailuresSql(15);

        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("WHERE has_error = true");
        expect(sql).toContain("GROUP BY tool, command_norm");
        expect(sql).toContain("LIMIT 15");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/queries/insights.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement query builders**

Create `src/queries/insights.ts`:

```ts
export function repositoryOverviewSql(limit: number): string {
    return `
SELECT
    id,
    identity_kind,
    remote_url_normalized,
    initial_commit,
    array::len(->has_checkout->checkout) AS checkout_count
FROM repository
ORDER BY last_seen_at DESC
LIMIT ${limit};`;
}

export function recentFrictionSql(limit: number): string {
    return `
SELECT
    id,
    session,
    repository,
    kind,
    raw_kind,
    severity,
    source,
    confidence,
    evidence_text,
    ts
FROM friction_event
ORDER BY ts DESC
LIMIT ${limit};`;
}

export function toolFailuresSql(limit: number): string {
    return `
SELECT
    tool.name AS tool,
    command_norm,
    count() AS failures,
    math::max(ts) AS last_seen
FROM tool_call
WHERE has_error = true
GROUP BY tool, command_norm
ORDER BY failures DESC
LIMIT ${limit};`;
}
```

- [ ] **Step 4: Add CLI `insights` command**

In `src/cli/index.ts`, import query builders:

```ts
import { recentFrictionSql, repositoryOverviewSql, toolFailuresSql } from "../queries/insights.ts";
```

Add help line:

```text
  agentctl insights [repositories|friction|tools] [--limit=N]
```

Add command handler:

```ts
const cmdInsights = (args: string[]) =>
    Effect.gen(function* () {
        const view = args.find((arg) => !arg.startsWith("--")) ?? "repositories";
        const limit = parsePositiveIntFlag("insights", "limit", args, 10);
        const db = yield* SurrealClient;
        const sql =
            view === "friction"
                ? recentFrictionSql(limit)
                : view === "tools"
                  ? toolFailuresSql(limit)
                  : repositoryOverviewSql(limit);
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        console.log(JSON.stringify(rows[0] ?? [], null, 2));
    });
```

Add branch:

```ts
if (cmd === "insights") {
    await Effect.runPromise(
        cmdInsights(rest).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>,
    );
    return;
}
```

- [ ] **Step 5: Run query tests and typecheck**

Run:

```bash
bun test src/queries/insights.test.ts
bun run typecheck
```

Expected: tests PASS and typecheck exits 0.

- [ ] **Step 6: Add example queries to design doc**

Append to `docs/repo-file-change-graph-design.md` under the query examples section:

```md
### Prototype Query Adapter Examples

- `agentctl insights repositories --limit=10`
- `agentctl insights friction --limit=20`
- `agentctl insights tools --limit=15`

These commands call query builders in `src/queries/insights.ts`. Dashboard code
must reuse these builders or a typed wrapper around them rather than embedding
ad hoc SurrealQL.
```

- [ ] **Step 7: Commit**

```bash
git add src/queries/insights.ts src/queries/insights.test.ts src/cli/index.ts docs/repo-file-change-graph-design.md
git commit -m "feat: add insight query adapter"
```

## Task 11: Derived Diagnostics, Friction, And Recommendations

**Files:**
- Modify: `src/ingest/derive-signals.ts`
- Create: `src/ingest/evidence-derivation.test.ts`

- [ ] **Step 1: Write pure derivation tests**

Create `src/ingest/evidence-derivation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    deriveFrictionFromToolCalls,
    deriveRecommendationFromFriction,
} from "./derive-signals.ts";

describe("evidence derivation", () => {
    test("derives tool_error friction from failed command", () => {
        const events = deriveFrictionFromToolCalls([
            {
                id: "tool_call:a",
                session: "session:s1",
                repository: "repository:r1",
                tool: "tool:bash",
                command_norm: "bun test",
                has_error: true,
                error_text: "Expected 1 but got 2",
                ts: "2026-05-09T10:00:00.000Z",
            },
        ]);

        expect(events).toEqual([
            expect.objectContaining({
                kind: "tool_error",
                targetType: "tool",
                targetName: "bun test",
            }),
        ]);
    });

    test("recommends hook from repeated checkout friction", () => {
        const recommendation = deriveRecommendationFromFriction([
            { kind: "user_correction", targetType: "checkout", repository: "repository:r1" },
            { kind: "user_correction", targetType: "checkout", repository: "repository:r1" },
            { kind: "user_correction", targetType: "checkout", repository: "repository:r1" },
        ]);

        expect(recommendation).toEqual(
            expect.objectContaining({
                kind: "hook",
                scope: "repository",
                title: "Add just-in-time checkout guidance",
            }),
        );
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ingest/evidence-derivation.test.ts`

Expected: FAIL because exported functions do not exist.

- [ ] **Step 3: Add pure derivation exports**

Append to `src/ingest/derive-signals.ts`:

```ts
export interface ToolCallSignal {
    readonly id: string;
    readonly session: string;
    readonly repository: string | null;
    readonly tool: string;
    readonly command_norm: string | null;
    readonly has_error: boolean;
    readonly error_text: string | null;
    readonly ts: string;
}

export function deriveFrictionFromToolCalls(calls: readonly ToolCallSignal[]) {
    return calls
        .filter((call) => call.has_error)
        .map((call) => ({
            key: `${String(call.id).replace(/[^a-zA-Z0-9]/g, "_")}__tool_error`,
            session: call.session,
            repository: call.repository,
            toolCall: call.id,
            kind: "tool_error",
            targetType: "tool",
            targetName: call.command_norm ?? call.tool,
            severity: "medium",
            source: "detector",
            confidence: "observed",
            evidenceText: call.error_text,
            ts: call.ts,
        }));
}

export interface FrictionSignal {
    readonly kind: string;
    readonly targetType: string;
    readonly repository: string | null;
}

export function deriveRecommendationFromFriction(events: readonly FrictionSignal[]) {
    const checkoutCorrections = events.filter(
        (event) => event.kind === "user_correction" && event.targetType === "checkout",
    );
    if (checkoutCorrections.length >= 3) {
        return {
            kind: "hook",
            scope: "repository",
            repository: checkoutCorrections[0]?.repository ?? null,
            title: "Add just-in-time checkout guidance",
            rationale: "Multiple checkout-related user corrections were observed.",
            status: "open",
            source: "detector",
            confidence: "observed",
        };
    }
    return null;
}
```

- [ ] **Step 4: Run derivation tests**

Run: `bun test src/ingest/evidence-derivation.test.ts`

Expected: PASS all 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/derive-signals.ts src/ingest/evidence-derivation.test.ts
git commit -m "feat: derive evidence graph signals"
```

## Task 12: End-To-End Prototype Smoke

**Files:**
- Modify: `docs/repo-file-change-graph-design.md`

- [ ] **Step 1: Apply schema**

Run:

```bash
bun run db:schema
```

Expected: exits 0.

- [ ] **Step 2: Ingest recent data**

Run:

```bash
bun src/cli/index.ts ingest --since=1
bun src/cli/index.ts ingest-insights
```

Expected: both commands exit 0.

- [ ] **Step 3: Verify new tables have data**

Run:

```bash
surreal sql --conn ws://127.0.0.1:8521 --user root --pass root --ns agentctl --db main --pretty --multi --hide-welcome <<'SQL'
SELECT count() AS count FROM tool_call GROUP ALL;
SELECT count() AS count FROM plan_snapshot GROUP ALL;
SELECT count() AS count FROM insight GROUP ALL;
SELECT count() AS count FROM friction_event GROUP ALL;
SQL
```

Expected: `tool_call.count` is greater than 0. `plan_snapshot.count`, `insight.count`, and `friction_event.count` may be 0 on a machine with no recent plans/Claude insights, but the queries must succeed.

- [ ] **Step 4: Run query adapter commands**

Run:

```bash
bun src/cli/index.ts insights repositories --limit=5
bun src/cli/index.ts insights friction --limit=5
bun src/cli/index.ts insights tools --limit=5
```

Expected: each command prints a JSON array.

- [ ] **Step 5: Run full local verification**

Run:

```bash
bun test
bun run typecheck
bun run agentctl project verify --json
```

Expected: tests PASS, typecheck exits 0, project verify exits 0.

- [ ] **Step 6: Record prototype notes**

Append this section to `docs/repo-file-change-graph-design.md`:

```md
## Prototype Verification Notes

The prototype implementation writes the new evidence graph alongside the legacy
taste graph. Existing commands continue to read legacy edges while new insight
commands read through `src/queries/insights.ts`.

Verification commands:

- `bun run db:schema`
- `bun src/cli/index.ts ingest --since=1`
- `bun src/cli/index.ts ingest-insights`
- `bun src/cli/index.ts insights repositories --limit=5`
- `bun src/cli/index.ts insights friction --limit=5`
- `bun src/cli/index.ts insights tools --limit=5`
- `bun test`
- `bun run typecheck`
```

- [ ] **Step 7: Commit**

```bash
git add docs/repo-file-change-graph-design.md
git commit -m "docs: record evidence graph prototype verification"
```

## Concerns Listed, Not Solved In Prototype

- Raw transcript, tool output, screenshot, and report retention/redaction.
- Full migration away from legacy `turn -> invoked` and `turn -> edited` edges.
- Materialized current views for `changeset` and `file_memory`.
- Full LLM enrichment pipeline for `insight`, `file_memory`, and `recommendation`.
- Code tracer/static dependency graph.
- Dashboard UI.
- Paid/sync privacy posture.
- High-volume backfill performance for all historical sessions.

## Self-Review

Spec coverage:

- Repository/checkout/file identity: Tasks 1, 2, 3.
- Tool/CLI/MCP first-class tracking: Tasks 2, 4, 6, 7, 8.
- Plans from Claude and Codex: Tasks 5, 7, 8.
- Claude `/insights` import: Task 9.
- Friction/feedback/diagnostics/recommendations: Tasks 2, 9, 11.
- Query examples for integration tests and dashboard reuse: Task 10.
- Prototype verification: Task 12.

Placeholder scan:

- No placeholder markers are present.
- Every code-changing step names exact files and includes concrete code or SQL snippets.
- Deferred areas are listed under concerns and are not required for prototype completion.

Type consistency:

- `tool_call`, `plan_snapshot`, `friction_event`, `insight`, `recommendation`, `guidance`, and `guidance_version` names match `CONTEXT.md` and `docs/repo-file-change-graph-design.md`.
- Status vocabulary uses `pending | in_progress | completed | abandoned` for plan items and `current | superseded` for change memory.
- `tool_call` is canonical execution evidence; legacy turn-level edges remain compatibility surfaces.
