# Graph Explorer Delivery Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a graph explorer that shows ask-to-outcome patterns across sessions, including file evidence, PR review pain, mainline promotion, phase timing, and interaction rhythm.

**Architecture:** Keep raw transcript/git/PR facts separate from derived signals. Ingestion writes normalized graph nodes and relations; derivation modules compute session phases, delivery outcomes, review pain, and pattern candidates; the dashboard consumes a stable graph payload that can power multiple modes.

**Tech Stack:** Bun, TypeScript strict mode, Effect service layer, SurrealDB 3 schemafull tables, React 19, TanStack Query, TanStack Router, SVG dashboard visualizations.

---

## Scope

This plan has six independently shippable slices:

1. Delivery outcome schema and local git promotion detection.
2. PR/review/check ingestion model and GitHub enrichment hook.
3. Session phase timing and interaction rhythm derivation.
4. Ask/outcome and feedback classification.
5. Graph explorer API with file, ask/outcome, phase, and delivery modes.
6. Dashboard UI upgrade from `Skill graph` to `Graph explorer`.

The first production milestone is useful after Tasks 1-3: `axctl` can answer whether local work reached `main`, how large the work was, and how much planning/implementation/verification time it consumed.

## File Structure

- Modify `schema/schema.surql`: add `branch`, `pull_request`, `review_event`, `check_run`, `delivery_outcome`, `phase_span`, `ask_outcome`, `pattern_candidate`, and relation tables.
- Create `src/ingest/git-promotion.ts`: local git ancestry and merge/squash/cherry-pick detection helpers.
- Create `src/ingest/git-promotion.test.ts`: table-driven tests using temporary git repos.
- Create `src/ingest/delivery.ts`: upsert delivery outcome records from session/commit/checkout state.
- Create `src/ingest/delivery.test.ts`: unit tests with mocked records and temp git repos.
- Create `src/ingest/github-pr.ts`: pure parser/normalizer for GitHub PR, review, comment, and check payloads.
- Create `src/ingest/github-pr.test.ts`: tests for review pain, PR size, bot/human reviewer classification, and closed-unmerged outcomes.
- Create `src/ingest/phase-spans.ts`: derive phase spans and interaction rhythm from `turn`, `tool_call`, `plan_snapshot`, `feedback_event`, and `command_outcome`.
- Create `src/ingest/phase-spans.test.ts`: timeline tests for planning, hands-free work, interruptions, and verification.
- Create `src/ingest/ask-outcome.ts`: classify user asks, feedback labels, and link asks to outcomes.
- Create `src/ingest/ask-outcome.test.ts`: tests for approval/correction/friction/exploration labels and ask-to-outcome linking.
- Create `src/dashboard/graph-explorer.ts`: backend query/normalization for graph explorer modes.
- Create `src/dashboard/graph-explorer.test.ts`: API payload tests with mocked `SurrealClient`.
- Modify `src/lib/shared/dashboard-types.ts`: add graph explorer wire types.
- Modify `src/dashboard/server.ts`: add `GET /api/graph-explorer`.
- Modify `src/dashboard/web/src/api.ts`: add `api.graphExplorer`.
- Modify `src/dashboard/web/src/router.tsx`: add `/graph`.
- Modify `src/dashboard/web/src/Shell.tsx`: point Graph nav to `/graph`.
- Create `src/dashboard/web/src/routes/graph.tsx`: Graph Explorer route.
- Modify `src/dashboard/web/src/routes/skill-graph.tsx`: either keep compatibility redirect/link or reuse the new route component for skill mode.
- Modify `src/dashboard/web/src/styles.css`: add graph explorer layout, legend, inspector, typed-node, and pattern-card styles.
- Modify `README.md`: document ingestion expansion, graph modes, and example queries.

---

### Task 1: Schema for Delivery, Review, Phase, and Pattern Signals

**Files:**
- Modify: `schema/schema.surql`

- [ ] **Step 1: Add schema tables after `commit_classification`**

Insert the following schema block after the existing `commit_classification` table:

```surql
DEFINE TABLE branch SCHEMAFULL;
DEFINE FIELD repository     ON branch TYPE record<repository>;
DEFINE FIELD name           ON branch TYPE string;
DEFINE FIELD head_sha       ON branch TYPE option<string>;
DEFINE FIELD upstream       ON branch TYPE option<string>;
DEFINE FIELD is_default     ON branch TYPE bool DEFAULT false;
DEFINE FIELD first_seen_at  ON branch TYPE datetime DEFAULT time::now();
DEFINE FIELD last_seen_at   ON branch TYPE option<datetime>;
DEFINE INDEX branch_repo_name ON branch FIELDS repository, name UNIQUE;

DEFINE TABLE pull_request SCHEMAFULL;
DEFINE FIELD repository     ON pull_request TYPE record<repository>;
DEFINE FIELD provider       ON pull_request TYPE string DEFAULT 'github';
DEFINE FIELD number         ON pull_request TYPE int;
DEFINE FIELD title          ON pull_request TYPE string;
DEFINE FIELD state          ON pull_request TYPE string;
DEFINE FIELD base_branch    ON pull_request TYPE option<string>;
DEFINE FIELD head_branch    ON pull_request TYPE option<string>;
DEFINE FIELD head_sha       ON pull_request TYPE option<string>;
DEFINE FIELD merge_sha      ON pull_request TYPE option<string>;
DEFINE FIELD author         ON pull_request TYPE option<string>;
DEFINE FIELD url            ON pull_request TYPE option<string>;
DEFINE FIELD opened_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD closed_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD merged_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD additions      ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD deletions      ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD changed_files  ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD commit_count   ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD labels         ON pull_request TYPE option<string>;
DEFINE FIELD raw            ON pull_request TYPE option<string>;
DEFINE FIELD updated_at     ON pull_request TYPE option<datetime>;
DEFINE INDEX pull_request_repo_number ON pull_request FIELDS repository, number UNIQUE;
DEFINE INDEX pull_request_state ON pull_request FIELDS repository, state, updated_at;

DEFINE TABLE review_event SCHEMAFULL;
DEFINE FIELD pull_request   ON review_event TYPE record<pull_request>;
DEFINE FIELD repository     ON review_event TYPE record<repository>;
DEFINE FIELD reviewer       ON review_event TYPE option<string>;
DEFINE FIELD reviewer_kind  ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD state          ON review_event TYPE string;
DEFINE FIELD body_excerpt   ON review_event TYPE option<string>;
DEFINE FIELD severity       ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD category       ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD unresolved     ON review_event TYPE bool DEFAULT false;
DEFINE FIELD raw            ON review_event TYPE option<string>;
DEFINE FIELD ts             ON review_event TYPE datetime;
DEFINE INDEX review_event_pr_ts ON review_event FIELDS pull_request, ts;
DEFINE INDEX review_event_severity ON review_event FIELDS repository, severity, ts;

DEFINE TABLE check_run SCHEMAFULL;
DEFINE FIELD pull_request   ON check_run TYPE option<record<pull_request>>;
DEFINE FIELD commit         ON check_run TYPE option<record<commit>>;
DEFINE FIELD repository     ON check_run TYPE record<repository>;
DEFINE FIELD provider       ON check_run TYPE string DEFAULT 'github';
DEFINE FIELD name           ON check_run TYPE string;
DEFINE FIELD status         ON check_run TYPE string;
DEFINE FIELD conclusion     ON check_run TYPE option<string>;
DEFINE FIELD url            ON check_run TYPE option<string>;
DEFINE FIELD raw            ON check_run TYPE option<string>;
DEFINE FIELD started_at     ON check_run TYPE option<datetime>;
DEFINE FIELD completed_at   ON check_run TYPE option<datetime>;
DEFINE INDEX check_run_pr ON check_run FIELDS pull_request, status, conclusion;
DEFINE INDEX check_run_commit ON check_run FIELDS commit, status, conclusion;

DEFINE TABLE delivery_outcome SCHEMAFULL;
DEFINE FIELD session        ON delivery_outcome TYPE option<record<session>>;
DEFINE FIELD repository     ON delivery_outcome TYPE option<record<repository>>;
DEFINE FIELD checkout       ON delivery_outcome TYPE option<record<checkout>>;
DEFINE FIELD pull_request   ON delivery_outcome TYPE option<record<pull_request>>;
DEFINE FIELD status         ON delivery_outcome TYPE string;
DEFINE FIELD promotion_path ON delivery_outcome TYPE string DEFAULT 'unknown';
DEFINE FIELD main_branch    ON delivery_outcome TYPE option<string>;
DEFINE FIELD produced_commits ON delivery_outcome TYPE option<string>;
DEFINE FIELD promoted_commits ON delivery_outcome TYPE option<string>;
DEFINE FIELD pr_size        ON delivery_outcome TYPE option<string>;
DEFINE FIELD review_pain    ON delivery_outcome TYPE option<string>;
DEFINE FIELD phase_metrics  ON delivery_outcome TYPE option<string>;
DEFINE FIELD confidence     ON delivery_outcome TYPE string DEFAULT 'medium';
DEFINE FIELD evidence       ON delivery_outcome TYPE option<string>;
DEFINE FIELD created_at     ON delivery_outcome TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON delivery_outcome TYPE option<datetime>;
DEFINE INDEX delivery_session ON delivery_outcome FIELDS session UNIQUE;
DEFINE INDEX delivery_pr ON delivery_outcome FIELDS pull_request;
DEFINE INDEX delivery_status ON delivery_outcome FIELDS repository, status, updated_at;

DEFINE TABLE phase_span SCHEMAFULL;
DEFINE FIELD session        ON phase_span TYPE record<session>;
DEFINE FIELD phase          ON phase_span TYPE string;
DEFINE FIELD start_turn     ON phase_span TYPE option<record<turn>>;
DEFINE FIELD end_turn       ON phase_span TYPE option<record<turn>>;
DEFINE FIELD start_ts       ON phase_span TYPE datetime;
DEFINE FIELD end_ts         ON phase_span TYPE datetime;
DEFINE FIELD duration_ms    ON phase_span TYPE int;
DEFINE FIELD user_turns     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD assistant_turns ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD tool_calls     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD files_read     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD files_touched  ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD tests_run      ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD interruptions  ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD corrections    ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD metrics        ON phase_span TYPE option<string>;
DEFINE FIELD evidence       ON phase_span TYPE option<string>;
DEFINE INDEX phase_span_session_phase ON phase_span FIELDS session, phase;

DEFINE TABLE ask_outcome SCHEMAFULL;
DEFINE FIELD session        ON ask_outcome TYPE record<session>;
DEFINE FIELD ask_turn       ON ask_outcome TYPE record<turn>;
DEFINE FIELD intent_kind    ON ask_outcome TYPE string;
DEFINE FIELD feedback_kind  ON ask_outcome TYPE option<string>;
DEFINE FIELD outcome_status ON ask_outcome TYPE string DEFAULT 'unknown';
DEFINE FIELD delivery       ON ask_outcome TYPE option<record<delivery_outcome>>;
DEFINE FIELD text_excerpt   ON ask_outcome TYPE option<string>;
DEFINE FIELD metrics        ON ask_outcome TYPE option<string>;
DEFINE FIELD evidence       ON ask_outcome TYPE option<string>;
DEFINE FIELD ts             ON ask_outcome TYPE datetime;
DEFINE INDEX ask_outcome_session ON ask_outcome FIELDS session, ts;
DEFINE INDEX ask_outcome_intent ON ask_outcome FIELDS intent_kind, outcome_status, ts;

DEFINE TABLE pattern_candidate SCHEMAFULL;
DEFINE FIELD kind           ON pattern_candidate TYPE string;
DEFINE FIELD title          ON pattern_candidate TYPE string;
DEFINE FIELD summary        ON pattern_candidate TYPE string;
DEFINE FIELD score          ON pattern_candidate TYPE float DEFAULT 0;
DEFINE FIELD status         ON pattern_candidate TYPE string DEFAULT 'candidate';
DEFINE FIELD sessions       ON pattern_candidate TYPE option<string>;
DEFINE FIELD files          ON pattern_candidate TYPE option<string>;
DEFINE FIELD messages       ON pattern_candidate TYPE option<string>;
DEFINE FIELD metrics        ON pattern_candidate TYPE option<string>;
DEFINE FIELD evidence       ON pattern_candidate TYPE option<string>;
DEFINE FIELD created_at     ON pattern_candidate TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON pattern_candidate TYPE option<datetime>;
DEFINE INDEX pattern_candidate_kind_score ON pattern_candidate FIELDS kind, score;
DEFINE INDEX pattern_candidate_status ON pattern_candidate FIELDS status, updated_at;
```

- [ ] **Step 2: Apply schema**

Run: `bun run db:schema`

Expected: command exits `0` and SurrealDB accepts all `DEFINE TABLE` and `DEFINE FIELD` statements.

- [ ] **Step 3: Commit**

```bash
git add schema/schema.surql
git commit -m "feat: add delivery telemetry schema"
```

---

### Task 2: Local Git Mainline Promotion Detection

**Files:**
- Create: `src/ingest/git-promotion.ts`
- Create: `src/ingest/git-promotion.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingest/git-promotion.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { detectPromotionPath } from "./git-promotion.ts";

const dirs: string[] = [];

async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ax-promotion-"));
    dirs.push(dir);
    await $`git init -b main`.cwd(dir).quiet();
    await $`git config user.email ax@example.com`.cwd(dir).quiet();
    await $`git config user.name Ax`.cwd(dir).quiet();
    await writeFile(join(dir, "README.md"), "root\n");
    await $`git add README.md`.cwd(dir).quiet();
    await $`git commit -m init`.cwd(dir).quiet();
    return dir;
}

async function commitFile(dir: string, path: string, text: string, message: string): Promise<string> {
    await writeFile(join(dir, path), text);
    await $`git add ${path}`.cwd(dir).quiet();
    await $`git commit -m ${message}`.cwd(dir).quiet();
    return (await $`git rev-parse HEAD`.cwd(dir).text()).trim();
}

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("detectPromotionPath", () => {
    test("marks an ancestor commit as direct_or_merge", async () => {
        const dir = await repo();
        const sha = await commitFile(dir, "a.txt", "a\n", "add a");
        const result = await detectPromotionPath({ repoPath: dir, commitSha: sha, mainBranch: "main" });
        expect(result.reachedMain).toBe(true);
        expect(result.path).toBe("direct_or_merge");
        expect(result.confidence).toBe("high");
    });

    test("marks branch commit not in main as not_promoted", async () => {
        const dir = await repo();
        await $`git checkout -b feature`.cwd(dir).quiet();
        const sha = await commitFile(dir, "b.txt", "b\n", "add b");
        await $`git checkout main`.cwd(dir).quiet();
        const result = await detectPromotionPath({ repoPath: dir, commitSha: sha, mainBranch: "main" });
        expect(result.reachedMain).toBe(false);
        expect(result.path).toBe("not_promoted");
    });

    test("detects squash-equivalent patch content", async () => {
        const dir = await repo();
        await $`git checkout -b feature`.cwd(dir).quiet();
        const sha = await commitFile(dir, "c.txt", "c\n", "feature c");
        await $`git checkout main`.cwd(dir).quiet();
        await writeFile(join(dir, "c.txt"), "c\n");
        await $`git add c.txt`.cwd(dir).quiet();
        await $`git commit -m "squash feature"`.cwd(dir).quiet();
        const result = await detectPromotionPath({ repoPath: dir, commitSha: sha, mainBranch: "main" });
        expect(result.reachedMain).toBe(true);
        expect(result.path).toBe("squash_or_cherry_pick");
        expect(result.confidence).toBe("medium");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test src/ingest/git-promotion.test.ts`

Expected: FAIL because `src/ingest/git-promotion.ts` does not exist.

- [ ] **Step 3: Implement git promotion helper**

Create `src/ingest/git-promotion.ts`:

```ts
import { $ } from "bun";

export type PromotionPath = "direct_or_merge" | "squash_or_cherry_pick" | "not_promoted" | "unknown";

export interface DetectPromotionInput {
    readonly repoPath: string;
    readonly commitSha: string;
    readonly mainBranch?: string;
}

export interface PromotionDetection {
    readonly reachedMain: boolean;
    readonly path: PromotionPath;
    readonly confidence: "high" | "medium" | "low";
    readonly mainBranch: string;
    readonly evidence: ReadonlyArray<string>;
}

async function gitOk(repoPath: string, args: ReadonlyArray<string>): Promise<boolean> {
    const result = await $`git ${args}`.cwd(repoPath).quiet().nothrow();
    return result.exitCode === 0;
}

async function gitText(repoPath: string, args: ReadonlyArray<string>): Promise<string> {
    const result = await $`git ${args}`.cwd(repoPath).quiet().nothrow();
    if (result.exitCode !== 0) return "";
    return result.stdout.toString().trim();
}

export async function detectPromotionPath(input: DetectPromotionInput): Promise<PromotionDetection> {
    const mainBranch = input.mainBranch ?? "main";
    const mainRef = await gitOk(input.repoPath, ["rev-parse", "--verify", mainBranch])
        ? mainBranch
        : `origin/${mainBranch}`;

    if (await gitOk(input.repoPath, ["merge-base", "--is-ancestor", input.commitSha, mainRef])) {
        return {
            reachedMain: true,
            path: "direct_or_merge",
            confidence: "high",
            mainBranch,
            evidence: [`${input.commitSha} is ancestor of ${mainRef}`],
        };
    }

    const patchId = await gitText(input.repoPath, ["show", input.commitSha, "--pretty=format:", "--patch"]);
    if (!patchId) {
        return {
            reachedMain: false,
            path: "unknown",
            confidence: "low",
            mainBranch,
            evidence: [`could not read patch for ${input.commitSha}`],
        };
    }

    const cherry = await $`git cherry ${mainRef} ${input.commitSha}`.cwd(input.repoPath).quiet().nothrow();
    const cherryText = cherry.stdout.toString();
    if (cherry.exitCode === 0 && cherryText.startsWith("-")) {
        return {
            reachedMain: true,
            path: "squash_or_cherry_pick",
            confidence: "medium",
            mainBranch,
            evidence: [`git cherry reports equivalent patch for ${input.commitSha} on ${mainRef}`],
        };
    }

    return {
        reachedMain: false,
        path: "not_promoted",
        confidence: "high",
        mainBranch,
        evidence: [`${input.commitSha} is not reachable or patch-equivalent on ${mainRef}`],
    };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/git-promotion.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/git-promotion.ts src/ingest/git-promotion.test.ts
git commit -m "feat: detect git mainline promotion"
```

---

### Task 3: Delivery Outcome Derivation

**Files:**
- Create: `src/ingest/delivery.ts`
- Create: `src/ingest/delivery.test.ts`

- [ ] **Step 1: Write tests for PR size and status derivation**

Create `src/ingest/delivery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyDeliveryStatus, scorePrSize, scoreReviewPain } from "./delivery.ts";

describe("scorePrSize", () => {
    test("scores tiny PRs as small", () => {
        expect(scorePrSize({ additions: 30, deletions: 5, changedFiles: 2, commitCount: 1 }).label).toBe("small");
    });

    test("scores broad PRs as large", () => {
        const score = scorePrSize({ additions: 900, deletions: 300, changedFiles: 42, commitCount: 9 });
        expect(score.label).toBe("large");
        expect(score.score).toBeGreaterThanOrEqual(80);
    });
});

describe("scoreReviewPain", () => {
    test("detects roasted PRs from changes requested and critical comments", () => {
        const score = scoreReviewPain({
            approvals: 0,
            changesRequested: 2,
            comments: 18,
            criticalComments: 6,
            failedChecks: 3,
            unresolvedThreads: 4,
        });
        expect(score.label).toBe("roasted");
        expect(score.score).toBeGreaterThanOrEqual(80);
    });
});

describe("classifyDeliveryStatus", () => {
    test("prefers merged status when PR merged and promoted", () => {
        expect(classifyDeliveryStatus({ prState: "merged", reachedMain: true })).toBe("merged_to_main");
    });

    test("marks closed unmerged as rejected", () => {
        expect(classifyDeliveryStatus({ prState: "closed", reachedMain: false })).toBe("closed_unmerged");
    });

    test("marks local-only work with no PR and no promotion", () => {
        expect(classifyDeliveryStatus({ reachedMain: false })).toBe("local_only");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test src/ingest/delivery.test.ts`

Expected: FAIL because `src/ingest/delivery.ts` does not exist.

- [ ] **Step 3: Implement pure delivery scoring**

Create `src/ingest/delivery.ts`:

```ts
export interface PrSizeInput {
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly commitCount: number;
}

export interface ReviewPainInput {
    readonly approvals: number;
    readonly changesRequested: number;
    readonly comments: number;
    readonly criticalComments: number;
    readonly failedChecks: number;
    readonly unresolvedThreads: number;
}

export interface ScoreLabel {
    readonly label: "small" | "medium" | "large" | "low" | "moderate" | "high" | "roasted";
    readonly score: number;
    readonly reasons: ReadonlyArray<string>;
}

export function scorePrSize(input: PrSizeInput): ScoreLabel {
    const diffLines = input.additions + input.deletions;
    const score = Math.min(
        100,
        Math.round(diffLines / 15) + input.changedFiles * 2 + input.commitCount * 4,
    );
    const label = score >= 70 ? "large" : score >= 30 ? "medium" : "small";
    return {
        label,
        score,
        reasons: [
            `${diffLines} changed lines`,
            `${input.changedFiles} changed files`,
            `${input.commitCount} commits`,
        ],
    };
}

export function scoreReviewPain(input: ReviewPainInput): ScoreLabel {
    const score = Math.min(
        100,
        input.changesRequested * 25 +
            input.criticalComments * 8 +
            input.failedChecks * 10 +
            input.unresolvedThreads * 6 +
            Math.max(0, input.comments - input.approvals * 3),
    );
    const label = score >= 80 ? "roasted" : score >= 55 ? "high" : score >= 25 ? "moderate" : "low";
    return {
        label,
        score,
        reasons: [
            `${input.changesRequested} changes-requested reviews`,
            `${input.criticalComments} critical comments`,
            `${input.failedChecks} failed checks`,
            `${input.unresolvedThreads} unresolved threads`,
        ],
    };
}

export function classifyDeliveryStatus(input: {
    readonly prState?: string | null;
    readonly reachedMain: boolean;
}): "merged_to_main" | "promoted_without_pr" | "closed_unmerged" | "open_pr" | "local_only" {
    if (input.reachedMain && input.prState === "merged") return "merged_to_main";
    if (input.reachedMain) return "promoted_without_pr";
    if (input.prState === "closed") return "closed_unmerged";
    if (input.prState === "open") return "open_pr";
    return "local_only";
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/delivery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/delivery.ts src/ingest/delivery.test.ts
git commit -m "feat: derive delivery outcome scores"
```

---

### Task 4: GitHub PR and Review Normalization

**Files:**
- Create: `src/ingest/github-pr.ts`
- Create: `src/ingest/github-pr.test.ts`

- [ ] **Step 1: Write parser tests**

Create `src/ingest/github-pr.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyReviewerKind, normalizeReviewEvent, normalizePullRequest } from "./github-pr.ts";

describe("normalizePullRequest", () => {
    test("maps GitHub PR fields to stable payload", () => {
        const pr = normalizePullRequest({
            number: 42,
            title: "Graph explorer",
            state: "closed",
            merged_at: "2026-05-15T10:00:00Z",
            base: { ref: "main" },
            head: { ref: "feature/graph", sha: "abc123" },
            merge_commit_sha: "def456",
            user: { login: "necmttn" },
            html_url: "https://github.com/org/repo/pull/42",
            created_at: "2026-05-14T10:00:00Z",
            closed_at: "2026-05-15T10:00:00Z",
            additions: 100,
            deletions: 20,
            changed_files: 5,
            commits: 3,
            labels: [{ name: "feature" }],
        });
        expect(pr.state).toBe("merged");
        expect(pr.baseBranch).toBe("main");
        expect(pr.changedFiles).toBe(5);
    });
});

describe("normalizeReviewEvent", () => {
    test("classifies AI reviewer and critical category", () => {
        const event = normalizeReviewEvent({
            user: { login: "coderabbitai[bot]", type: "Bot" },
            state: "CHANGES_REQUESTED",
            body: "This can race and lacks test coverage.",
            submitted_at: "2026-05-15T11:00:00Z",
        });
        expect(event.reviewerKind).toBe("ai_reviewer");
        expect(event.severity).toBe("critical");
        expect(event.category).toBe("test_gap");
    });
});

describe("classifyReviewerKind", () => {
    test("distinguishes human, bot, and ai reviewer", () => {
        expect(classifyReviewerKind("alice", "User")).toBe("human");
        expect(classifyReviewerKind("github-actions[bot]", "Bot")).toBe("bot");
        expect(classifyReviewerKind("coderabbitai[bot]", "Bot")).toBe("ai_reviewer");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test src/ingest/github-pr.test.ts`

Expected: FAIL because `src/ingest/github-pr.ts` does not exist.

- [ ] **Step 3: Implement normalizers**

Create `src/ingest/github-pr.ts`:

```ts
type Json = Record<string, unknown>;

const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number => typeof value === "number" ? value : 0;
const obj = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};

export function classifyReviewerKind(login: string | null, type: string | null): "human" | "bot" | "ai_reviewer" | "unknown" {
    const normalized = (login ?? "").toLowerCase();
    if (!login) return "unknown";
    if (normalized.includes("coderabbit") || normalized.includes("copilot") || normalized.includes("sourcery")) return "ai_reviewer";
    if (type === "Bot" || normalized.endsWith("[bot]")) return "bot";
    return "human";
}

export function normalizePullRequest(raw: Json) {
    const base = obj(raw.base);
    const head = obj(raw.head);
    const user = obj(raw.user);
    const labels = Array.isArray(raw.labels)
        ? raw.labels.map((label) => str(obj(label).name)).filter((name): name is string => !!name)
        : [];
    const mergedAt = str(raw.merged_at);
    return {
        number: num(raw.number),
        title: str(raw.title) ?? "",
        state: mergedAt ? "merged" : str(raw.state) ?? "unknown",
        baseBranch: str(base.ref),
        headBranch: str(head.ref),
        headSha: str(head.sha),
        mergeSha: str(raw.merge_commit_sha),
        author: str(user.login),
        url: str(raw.html_url),
        openedAt: str(raw.created_at),
        closedAt: str(raw.closed_at),
        mergedAt,
        additions: num(raw.additions),
        deletions: num(raw.deletions),
        changedFiles: num(raw.changed_files),
        commitCount: num(raw.commits),
        labels,
        raw,
    };
}

export function normalizeReviewEvent(raw: Json) {
    const user = obj(raw.user);
    const login = str(user.login);
    const body = str(raw.body) ?? "";
    const lowered = body.toLowerCase();
    const state = str(raw.state) ?? "UNKNOWN";
    const severity =
        state === "CHANGES_REQUESTED" || lowered.includes("race") || lowered.includes("security")
            ? "critical"
            : lowered.includes("nit") ? "minor" : "moderate";
    const category =
        lowered.includes("test") ? "test_gap" :
        lowered.includes("security") ? "security" :
        lowered.includes("race") || lowered.includes("bug") ? "correctness" :
        lowered.includes("style") ? "style" :
        "unknown";
    return {
        reviewer: login,
        reviewerKind: classifyReviewerKind(login, str(user.type)),
        state,
        bodyExcerpt: body.slice(0, 500),
        severity,
        category,
        unresolved: false,
        ts: str(raw.submitted_at) ?? new Date(0).toISOString(),
        raw,
    };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/github-pr.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/github-pr.ts src/ingest/github-pr.test.ts
git commit -m "feat: normalize pull request review signals"
```

---

### Task 5: Phase Timing and Interaction Rhythm

**Files:**
- Create: `src/ingest/phase-spans.ts`
- Create: `src/ingest/phase-spans.test.ts`

- [ ] **Step 1: Write phase derivation tests**

Create `src/ingest/phase-spans.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { derivePhaseSpans, summarizeInteractionRhythm } from "./phase-spans.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 4, 15, 10, minute)).toISOString();

describe("derivePhaseSpans", () => {
    test("separates interview, implementation, and verification", () => {
        const spans = derivePhaseSpans([
            { seq: 1, role: "user", ts: at(0), text: "can we plan this?" },
            { seq: 2, role: "assistant", ts: at(2), text: "question and plan" },
            { seq: 3, role: "user", ts: at(8), text: "yes" },
            { seq: 4, role: "assistant", ts: at(10), text: "editing files", hasToolUse: true, toolNames: ["apply_patch"] },
            { seq: 5, role: "assistant", ts: at(20), text: "running tests", hasToolUse: true, toolNames: ["bun test"] },
            { seq: 6, role: "assistant", ts: at(25), text: "final" },
        ]);
        expect(spans.map((span) => span.phase)).toEqual(["planning", "implementation", "verification", "finalization"]);
        expect(spans[0]?.durationMs).toBe(8 * 60_000);
    });

    test("counts hands-free agent work until next user turn", () => {
        const rhythm = summarizeInteractionRhythm([
            { seq: 1, role: "user", ts: at(0), text: "fix bug" },
            { seq: 2, role: "assistant", ts: at(2), text: "inspect", hasToolUse: true, toolNames: ["rg"] },
            { seq: 3, role: "assistant", ts: at(12), text: "patch", hasToolUse: true, toolNames: ["apply_patch"] },
            { seq: 4, role: "user", ts: at(30), text: "did you test?" },
        ]);
        expect(rhythm.longestHandsFreeMs).toBe(28 * 60_000);
        expect(rhythm.userTurns).toBe(2);
        expect(rhythm.corrections).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test src/ingest/phase-spans.test.ts`

Expected: FAIL because `src/ingest/phase-spans.ts` does not exist.

- [ ] **Step 3: Implement phase/rhythm pure derivation**

Create `src/ingest/phase-spans.ts`:

```ts
export interface TimelineTurn {
    readonly seq: number;
    readonly role: string;
    readonly ts: string;
    readonly text?: string | null;
    readonly hasToolUse?: boolean;
    readonly toolNames?: ReadonlyArray<string>;
}

export interface DerivedPhaseSpan {
    readonly phase: "planning" | "context_gathering" | "implementation" | "verification" | "finalization";
    readonly startSeq: number;
    readonly endSeq: number;
    readonly startTs: string;
    readonly endTs: string;
    readonly durationMs: number;
    readonly userTurns: number;
    readonly assistantTurns: number;
    readonly toolCalls: number;
}

export interface InteractionRhythm {
    readonly totalDurationMs: number;
    readonly userTurns: number;
    readonly assistantTurns: number;
    readonly longestHandsFreeMs: number;
    readonly corrections: number;
}

function phaseFor(turn: TimelineTurn): DerivedPhaseSpan["phase"] {
    const text = (turn.text ?? "").toLowerCase();
    const tools = (turn.toolNames ?? []).join(" ").toLowerCase();
    if (text.includes("final") || text.includes("done")) return "finalization";
    if (text.includes("test") || tools.includes("test") || tools.includes("typecheck")) return "verification";
    if (tools.includes("apply_patch") || text.includes("editing") || text.includes("patch")) return "implementation";
    if (turn.hasToolUse || tools.includes("rg") || tools.includes("sed")) return "context_gathering";
    return "planning";
}

function durationMs(a: string, b: string): number {
    return Math.max(0, new Date(b).getTime() - new Date(a).getTime());
}

export function derivePhaseSpans(turns: ReadonlyArray<TimelineTurn>): ReadonlyArray<DerivedPhaseSpan> {
    if (turns.length === 0) return [];
    const spans: DerivedPhaseSpan[] = [];
    let currentPhase = phaseFor(turns[0]!);
    let start = turns[0]!;
    let bucket: TimelineTurn[] = [start];

    const flush = (end: TimelineTurn) => {
        spans.push({
            phase: currentPhase,
            startSeq: start.seq,
            endSeq: end.seq,
            startTs: start.ts,
            endTs: end.ts,
            durationMs: durationMs(start.ts, end.ts),
            userTurns: bucket.filter((t) => t.role === "user").length,
            assistantTurns: bucket.filter((t) => t.role === "assistant").length,
            toolCalls: bucket.reduce((sum, t) => sum + (t.toolNames?.length ?? 0), 0),
        });
    };

    for (const turn of turns.slice(1)) {
        const nextPhase = phaseFor(turn);
        if (nextPhase !== currentPhase) {
            flush(bucket[bucket.length - 1]!);
            currentPhase = nextPhase;
            start = turn;
            bucket = [turn];
        } else {
            bucket.push(turn);
        }
    }
    flush(bucket[bucket.length - 1]!);
    return spans;
}

export function summarizeInteractionRhythm(turns: ReadonlyArray<TimelineTurn>): InteractionRhythm {
    if (turns.length === 0) {
        return { totalDurationMs: 0, userTurns: 0, assistantTurns: 0, longestHandsFreeMs: 0, corrections: 0 };
    }
    let longestHandsFreeMs = 0;
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        if (turn.role !== "assistant") continue;
        const previousUser = [...turns.slice(0, i)].reverse().find((t) => t.role === "user");
        const nextUser = turns.slice(i + 1).find((t) => t.role === "user");
        if (previousUser && nextUser) {
            longestHandsFreeMs = Math.max(longestHandsFreeMs, durationMs(previousUser.ts, nextUser.ts));
        }
    }
    return {
        totalDurationMs: durationMs(turns[0]!.ts, turns[turns.length - 1]!.ts),
        userTurns: turns.filter((t) => t.role === "user").length,
        assistantTurns: turns.filter((t) => t.role === "assistant").length,
        longestHandsFreeMs,
        corrections: turns.filter((t) => /did you test|no\b|not that|i meant|actually/i.test(t.text ?? "")).length,
    };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/phase-spans.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/phase-spans.ts src/ingest/phase-spans.test.ts
git commit -m "feat: derive session phase timing"
```

---

### Task 6: Ask/Outcome and Feedback Classification

**Files:**
- Create: `src/ingest/ask-outcome.ts`
- Create: `src/ingest/ask-outcome.test.ts`

- [ ] **Step 1: Write classifier tests**

Create `src/ingest/ask-outcome.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyFeedback, classifyUserAsk } from "./ask-outcome.ts";

describe("classifyUserAsk", () => {
    test("labels UI improvement asks", () => {
        expect(classifyUserAsk("i also wanna improve the visuals")).toBe("ui_improvement");
    });

    test("labels verification asks", () => {
        expect(classifyUserAsk("did you test the query?")).toBe("verification_request");
    });

    test("labels planning asks", () => {
        expect(classifyUserAsk("alright lets share a plan")).toBe("planning");
    });
});

describe("classifyFeedback", () => {
    test("detects correction and friction", () => {
        expect(classifyFeedback("no more like scenario where there's bug message in file")).toBe("correction");
        expect(classifyFeedback("can you please do")).toBe("friction");
    });

    test("detects approval and exploration", () => {
        expect(classifyFeedback("yes")).toBe("approval");
        expect(classifyFeedback("i wonder can we do sentiment analysis")).toBe("exploration");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test src/ingest/ask-outcome.test.ts`

Expected: FAIL because `src/ingest/ask-outcome.ts` does not exist.

- [ ] **Step 3: Implement classifiers**

Create `src/ingest/ask-outcome.ts`:

```ts
export type AskIntent =
    | "ui_improvement"
    | "verification_request"
    | "planning"
    | "data_ingestion"
    | "query_request"
    | "debug_fix"
    | "product_brainstorm"
    | "unknown";

export type FeedbackKind = "approval" | "correction" | "friction" | "exploration" | "uncertainty" | "neutral";

export function classifyUserAsk(text: string): AskIntent {
    const t = text.toLowerCase();
    if (/\bvisual|ui|ux|dashboard|graph route|html format/.test(t)) return "ui_improvement";
    if (/did you test|test it|verify|real transcripts|tracer test/.test(t)) return "verification_request";
    if (/plan|roadmap|implementation/.test(t)) return "planning";
    if (/ingest|transcript|extract/.test(t)) return "data_ingestion";
    if (/query|surreal|select|graph query/.test(t)) return "query_request";
    if (/bug|fix|broken|error/.test(t)) return "debug_fix";
    if (/brainstorm|wonder|product|value/.test(t)) return "product_brainstorm";
    return "unknown";
}

export function classifyFeedback(text: string): FeedbackKind {
    const t = text.trim().toLowerCase();
    if (/^(yes|yep|sure|ok|okay|yres)\b|not bad|sounds about right/.test(t)) return "approval";
    if (/^no\b|i meant|more like|false positives|actually/.test(t)) return "correction";
    if (/can you please|did you test|why\b|please do/.test(t)) return "friction";
    if (/wonder|curious|what can|how can|brainstorm/.test(t)) return "exploration";
    if (/maybe|hm\b|not sure/.test(t)) return "uncertainty";
    return "neutral";
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ingest/ask-outcome.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/ask-outcome.ts src/ingest/ask-outcome.test.ts
git commit -m "feat: classify ask and feedback signals"
```

---

### Task 7: Graph Explorer API Types and Backend

**Files:**
- Modify: `src/lib/shared/dashboard-types.ts`
- Create: `src/dashboard/graph-explorer.ts`
- Create: `src/dashboard/graph-explorer.test.ts`
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Add shared wire types**

Append to `src/lib/shared/dashboard-types.ts`:

```ts
export type GraphExplorerMode =
    | "skill-pairs"
    | "file-attention"
    | "ask-outcome"
    | "phase-balance"
    | "delivery"
    | "patterns";

export type GraphNodeKind =
    | "skill"
    | "file"
    | "session"
    | "message"
    | "commit"
    | "pull_request"
    | "pattern"
    | "phase";

export interface GraphExplorerNode {
    readonly id: string;
    readonly label: string;
    readonly kind: GraphNodeKind;
    readonly weight: number;
    readonly tone: "blue" | "green" | "gold" | "red" | "ink" | "muted";
    readonly subtitle?: string | null;
    readonly metrics?: Record<string, number | string | null>;
}

export interface GraphExplorerEdge {
    readonly source: string;
    readonly target: string;
    readonly relation: string;
    readonly weight: number;
    readonly tone: "blue" | "green" | "gold" | "red" | "ink" | "muted";
    readonly dashed?: boolean;
    readonly label?: string | null;
    readonly metrics?: Record<string, number | string | null>;
}

export interface GraphExplorerPanel {
    readonly title: string;
    readonly kind: "summary" | "evidence" | "timeline" | "pattern";
    readonly rows: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly detail?: string | null;
    }>;
}

export interface GraphExplorerPayload {
    readonly generatedAt: string;
    readonly mode: GraphExplorerMode;
    readonly query: string | null;
    readonly nodes: ReadonlyArray<GraphExplorerNode>;
    readonly edges: ReadonlyArray<GraphExplorerEdge>;
    readonly panels: ReadonlyArray<GraphExplorerPanel>;
    readonly warnings: ReadonlyArray<string>;
}
```

- [ ] **Step 2: Write backend payload test**

Create `src/dashboard/graph-explorer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeGraphMode, rowsToGraphPayload } from "./graph-explorer.ts";

describe("normalizeGraphMode", () => {
    test("defaults unknown modes to file-attention", () => {
        expect(normalizeGraphMode("wat")).toBe("file-attention");
    });
});

describe("rowsToGraphPayload", () => {
    test("builds typed graph payload with inspector panel", () => {
        const payload = rowsToGraphPayload({
            mode: "delivery",
            query: "graph",
            rows: [
                { source_id: "session:1", source_label: "session 1", source_kind: "session", target_id: "pr:1", target_label: "PR #1", target_kind: "pull_request", relation: "produced_pr", weight: 5 },
            ],
            panels: [{ title: "Outcome", kind: "summary", rows: [{ label: "status", value: "merged_to_main" }] }],
            warnings: [],
        });
        expect(payload.nodes.map((node) => node.kind)).toEqual(["session", "pull_request"]);
        expect(payload.edges[0]?.relation).toBe("produced_pr");
        expect(payload.panels[0]?.title).toBe("Outcome");
    });
});
```

- [ ] **Step 3: Implement graph explorer backend helpers**

Create `src/dashboard/graph-explorer.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type {
    GraphExplorerMode,
    GraphExplorerNode,
    GraphExplorerPayload,
    GraphNodeKind,
} from "../lib/shared/dashboard-types.ts";

const MODES = new Set<GraphExplorerMode>(["skill-pairs", "file-attention", "ask-outcome", "phase-balance", "delivery", "patterns"]);

export function normalizeGraphMode(value: string | null | undefined): GraphExplorerMode {
    return value && MODES.has(value as GraphExplorerMode) ? value as GraphExplorerMode : "file-attention";
}

function toneFor(kind: GraphNodeKind): GraphExplorerNode["tone"] {
    if (kind === "file" || kind === "skill") return "blue";
    if (kind === "commit" || kind === "pull_request") return "green";
    if (kind === "message" || kind === "pattern") return "gold";
    if (kind === "phase") return "red";
    return "ink";
}

export function rowsToGraphPayload(input: {
    readonly mode: GraphExplorerMode;
    readonly query: string | null;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly panels: GraphExplorerPayload["panels"];
    readonly warnings: ReadonlyArray<string>;
}): GraphExplorerPayload {
    const nodes = new Map<string, GraphExplorerNode>();
    const edges: GraphExplorerPayload["edges"][number][] = [];
    for (const row of input.rows) {
        const sourceId = String(row.source_id ?? "");
        const targetId = String(row.target_id ?? "");
        if (!sourceId || !targetId) continue;
        const sourceKind = String(row.source_kind ?? "session") as GraphNodeKind;
        const targetKind = String(row.target_kind ?? "file") as GraphNodeKind;
        nodes.set(sourceId, {
            id: sourceId,
            label: String(row.source_label ?? sourceId),
            kind: sourceKind,
            weight: Number(row.source_weight ?? row.weight ?? 1),
            tone: toneFor(sourceKind),
        });
        nodes.set(targetId, {
            id: targetId,
            label: String(row.target_label ?? targetId),
            kind: targetKind,
            weight: Number(row.target_weight ?? row.weight ?? 1),
            tone: toneFor(targetKind),
        });
        edges.push({
            source: sourceId,
            target: targetId,
            relation: String(row.relation ?? "related"),
            weight: Number(row.weight ?? 1),
            tone: row.relation === "touched" || row.relation === "promoted" ? "green" : row.relation === "mentioned" ? "gold" : "blue",
            dashed: row.relation === "mentioned" || row.relation === "semantic_match",
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        mode: input.mode,
        query: input.query,
        nodes: [...nodes.values()],
        edges,
        panels: input.panels,
        warnings: input.warnings,
    };
}

export function fetchGraphExplorer(params: {
    readonly mode?: string | null;
    readonly q?: string | null;
    readonly limit?: number;
}) {
    const mode = normalizeGraphMode(params.mode);
    const limit = Math.min(Math.max(params.limit ?? 120, 1), 400);
    const queryText = params.q?.trim() || null;
    return Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT string::concat(id) AS source_id, path AS source_label, 'file' AS source_kind,
       string::concat(<-read_file[0].in) AS target_id, string::concat(<-read_file[0].in) AS target_label, 'message' AS target_kind,
       'read_file' AS relation, count(<-read_file) AS weight
FROM file
WHERE count(<-read_file) > 0
ORDER BY weight DESC
LIMIT ${limit};`);
        return rowsToGraphPayload({
            mode,
            query: queryText,
            rows: rows[0] ?? [],
            panels: [{
                title: "Graph summary",
                kind: "summary",
                rows: [
                    { label: "mode", value: mode },
                    { label: "limit", value: String(limit) },
                ],
            }],
            warnings: mode === "file-attention" ? [] : [`${mode} currently falls back to file attention query until its slice is implemented`],
        });
    });
}
```

- [ ] **Step 4: Add server route**

In `src/dashboard/server.ts`, add import:

```ts
import { fetchGraphExplorer } from "./graph-explorer.ts";
```

Add this block before `/api/skill-graph`:

```ts
    if (url.pathname === "/api/graph-explorer" && req.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;
        try {
            const payload = await Effect.runPromise(
                fetchGraphExplorer({
                    mode: url.searchParams.get("mode"),
                    q: url.searchParams.get("q"),
                    limit: typeof limit === "number" && Number.isFinite(limit) ? limit : undefined,
                }).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
```

- [ ] **Step 5: Run tests**

Run: `bun test src/dashboard/graph-explorer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/dashboard-types.ts src/dashboard/graph-explorer.ts src/dashboard/graph-explorer.test.ts src/dashboard/server.ts
git commit -m "feat: add graph explorer api"
```

---

### Task 8: Graph Explorer UI Route

**Files:**
- Modify: `src/dashboard/web/src/api.ts`
- Modify: `src/dashboard/web/src/router.tsx`
- Modify: `src/dashboard/web/src/Shell.tsx`
- Create: `src/dashboard/web/src/routes/graph.tsx`
- Modify: `src/dashboard/web/src/styles.css`

- [ ] **Step 1: Add API client method**

In `src/dashboard/web/src/api.ts`, import `GraphExplorerPayload` and add:

```ts
    graphExplorer: (params: {
        mode?: string | null;
        q?: string | null;
        limit?: number | null;
    } = {}): Promise<GraphExplorerPayload> => {
        const usp = new URLSearchParams();
        if (params.mode) usp.set("mode", params.mode);
        if (params.q) usp.set("q", params.q);
        if (params.limit != null) usp.set("limit", String(params.limit));
        const qs = usp.toString();
        return jsonFetch(qs ? `/api/graph-explorer?${qs}` : "/api/graph-explorer");
    },
```

- [ ] **Step 2: Create graph route**

Create `src/dashboard/web/src/routes/graph.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { GraphExplorerMode, GraphExplorerNode } from "@shared/dashboard-types.ts";

const MODES: ReadonlyArray<{ mode: GraphExplorerMode; label: string }> = [
    { mode: "file-attention", label: "File attention" },
    { mode: "ask-outcome", label: "Ask → Outcome" },
    { mode: "phase-balance", label: "Phase balance" },
    { mode: "delivery", label: "Delivery" },
    { mode: "patterns", label: "Patterns" },
    { mode: "skill-pairs", label: "Skill pairs" },
];

export function GraphRoute() {
    const [mode, setMode] = useState<GraphExplorerMode>("file-attention");
    const [q, setQ] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const query = useQuery({
        queryKey: ["graph-explorer", mode, q],
        queryFn: () => api.graphExplorer({ mode, q, limit: 160 }),
    });
    const data = query.data;
    const selectedNode = useMemo(
        () => data?.nodes.find((node) => node.id === selected) ?? data?.nodes[0] ?? null,
        [data, selected],
    );

    return (
        <section className="graph-explorer">
            <aside className="graph-rail panel">
                <header><h2>Graph</h2><span className="meta">{data?.mode ?? mode}</span></header>
                <div className="graph-mode-list">
                    {MODES.map((entry) => (
                        <button
                            key={entry.mode}
                            type="button"
                            className={entry.mode === mode ? "is-active" : ""}
                            onClick={() => setMode(entry.mode)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
                <label className="graph-query">
                    <span>Query</span>
                    <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="bug message in file" />
                </label>
                <div className="graph-legend">
                    <b>Legend</b>
                    <span>□ file</span>
                    <span>○ message/session</span>
                    <span>◇ commit/PR</span>
                </div>
            </aside>
            <main className="graph-stage panel">
                <header>
                    <h2>Graph explorer</h2>
                    <span className="meta">
                        {data ? `${data.nodes.length} nodes · ${data.edges.length} edges` : "Loading"}
                    </span>
                </header>
                {query.error ? <div className="error">{String(query.error)}</div> : null}
                {query.isLoading ? <div className="loading">Loading…</div> : null}
                {data ? (
                    <svg className="graph-svg" viewBox="0 0 900 560" role="img" aria-label="Graph explorer">
                        {data.edges.map((edge, index) => {
                            const source = data.nodes.find((node) => node.id === edge.source);
                            const target = data.nodes.find((node) => node.id === edge.target);
                            if (!source || !target) return null;
                            const x1 = 120 + (index % 5) * 130;
                            const y1 = 130 + (index % 4) * 82;
                            const x2 = 250 + (index % 5) * 118;
                            const y2 = 170 + (index % 3) * 104;
                            return <line key={`${edge.source}-${edge.target}-${index}`} x1={x1} y1={y1} x2={x2} y2={y2} className={`edge tone-${edge.tone}`} strokeDasharray={edge.dashed ? "8 6" : undefined} strokeWidth={Math.max(1, Math.min(8, edge.weight))} />;
                        })}
                        {data.nodes.slice(0, 40).map((node, index) => (
                            <GraphNodeMark key={node.id} node={node} index={index} selected={selectedNode?.id === node.id} onSelect={() => setSelected(node.id)} />
                        ))}
                    </svg>
                ) : null}
            </main>
            <aside className="graph-inspector panel">
                <header><h2>Inspector</h2><span className="meta">{selectedNode?.kind ?? "none"}</span></header>
                {selectedNode ? <InspectorNode node={selectedNode} /> : <div className="empty">Select a node.</div>}
                {data?.panels.map((panel) => (
                    <section key={panel.title} className="graph-panel">
                        <h3>{panel.title}</h3>
                        {panel.rows.map((row) => (
                            <p key={`${row.label}-${row.value}`}><b>{row.label}</b><span>{row.value}</span></p>
                        ))}
                    </section>
                ))}
            </aside>
        </section>
    );
}

function GraphNodeMark(props: {
    readonly node: GraphExplorerNode;
    readonly index: number;
    readonly selected: boolean;
    readonly onSelect: () => void;
}) {
    const x = 110 + (props.index % 7) * 112;
    const y = 105 + Math.floor(props.index / 7) * 86;
    const size = Math.max(14, Math.min(34, 10 + props.node.weight));
    if (props.node.kind === "file") {
        return (
            <g transform={`translate(${x}, ${y})`} onClick={props.onSelect} className="graph-node">
                <rect x={-size * 1.4} y={-size * 0.8} width={size * 2.8} height={size * 1.6} className={`node-fill tone-${props.node.tone} ${props.selected ? "selected" : ""}`} />
                <text y={4}>{props.node.label}</text>
            </g>
        );
    }
    return (
        <g transform={`translate(${x}, ${y})`} onClick={props.onSelect} className="graph-node">
            <circle r={size} className={`node-fill tone-${props.node.tone} ${props.selected ? "selected" : ""}`} />
            <text y={4}>{props.node.label}</text>
        </g>
    );
}

function InspectorNode(props: { readonly node: GraphExplorerNode }) {
    return (
        <section className="graph-panel">
            <h3>{props.node.label}</h3>
            <p><b>kind</b><span>{props.node.kind}</span></p>
            <p><b>weight</b><span>{props.node.weight}</span></p>
            {props.node.subtitle ? <p><b>detail</b><span>{props.node.subtitle}</span></p> : null}
        </section>
    );
}
```

- [ ] **Step 3: Add route and nav**

In `src/dashboard/web/src/router.tsx`, import `GraphRoute` and add `/graph` using the same pattern as the existing routes.

In `src/dashboard/web/src/Shell.tsx`, change the Graph tab target from `/skills/graph` to `/graph`.

- [ ] **Step 4: Add CSS**

Append to `src/dashboard/web/src/styles.css`:

```css
.graph-explorer {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr) 320px;
    gap: 12px;
    min-height: 680px;
}

.graph-rail,
.graph-stage,
.graph-inspector {
    min-width: 0;
}

.graph-mode-list {
    display: grid;
    gap: 6px;
}

.graph-mode-list button {
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    padding: 8px;
    text-align: left;
    cursor: pointer;
}

.graph-mode-list button.is-active {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--page);
}

.graph-query {
    display: grid;
    gap: 6px;
    margin-top: 14px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted);
}

.graph-query input {
    border: 1px solid var(--line);
    padding: 8px;
    color: var(--ink);
    background: var(--panel);
}

.graph-legend,
.graph-panel {
    border-top: 1px solid var(--line);
    margin-top: 14px;
    padding-top: 10px;
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
}

.graph-panel h3 {
    margin: 0 0 4px;
    font-size: 13px;
    color: var(--ink);
}

.graph-panel p {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin: 0;
    border-bottom: 1px solid rgba(207, 216, 212, 0.6);
    padding-bottom: 5px;
}

.graph-svg {
    width: 100%;
    height: 600px;
    display: block;
    background:
        linear-gradient(90deg, rgba(20, 22, 21, 0.035) 1px, transparent 1px),
        linear-gradient(180deg, rgba(20, 22, 21, 0.035) 1px, transparent 1px),
        var(--panel);
    background-size: 20px 20px;
}

.graph-node {
    cursor: pointer;
}

.graph-node text {
    font-size: 10px;
    text-anchor: middle;
    fill: var(--ink);
    pointer-events: none;
}

.node-fill {
    fill: var(--panel);
    stroke-width: 3;
}

.node-fill.selected {
    stroke-width: 6;
}

.tone-blue { stroke: var(--blue); }
.tone-green { stroke: var(--green); }
.tone-gold { stroke: var(--gold); }
.tone-red { stroke: var(--red); }
.tone-ink { stroke: var(--ink); }
.tone-muted { stroke: var(--muted); }

.edge {
    fill: none;
    opacity: 0.45;
}

@media (max-width: 980px) {
    .graph-explorer {
        grid-template-columns: 1fr;
    }
}
```

- [ ] **Step 5: Build dashboard**

Run: `bun run dashboard:build`

Expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/web/src/api.ts src/dashboard/web/src/router.tsx src/dashboard/web/src/Shell.tsx src/dashboard/web/src/routes/graph.tsx src/dashboard/web/src/styles.css
git commit -m "feat: add graph explorer dashboard"
```

---

### Task 9: Documentation and Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README section**

Add this section near the dashboard documentation:

```md
### Graph Explorer

`axctl dashboard serve` exposes `/graph`, a typed graph explorer over agent telemetry.

Initial modes:

- `File attention`: files connected to user messages, reads/searches, and touched outcomes.
- `Ask → Outcome`: user asks connected to sessions, phase spans, delivery outcomes, and feedback.
- `Phase balance`: planning, implementation, verification, review, and hands-free work duration.
- `Delivery`: branches, commits, PRs, reviews, checks, and mainline promotion.
- `Patterns`: cross-session pattern candidates backed by messages, files, sessions, and outcomes.
- `Skill pairs`: the existing skill co-occurrence graph as a compatibility mode.

The delivery model distinguishes local-only work, open PRs, closed-unmerged PRs, promoted-without-PR work, and merged-to-main work. PR review signals include size, review rounds, changes requested, failed checks, unresolved threads, and AI reviewer comments.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test \
  src/ingest/git-promotion.test.ts \
  src/ingest/delivery.test.ts \
  src/ingest/github-pr.test.ts \
  src/ingest/phase-spans.test.ts \
  src/ingest/ask-outcome.test.ts \
  src/dashboard/graph-explorer.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full checks**

Run:

```bash
bun run typecheck
bun run dashboard:build
bun run check:cli-reference
git diff --check
```

Expected: all commands exit `0`. If `bun run typecheck` prints the existing Effect JSON advisory, confirm it is the known advisory and no new type errors were introduced.

- [ ] **Step 4: Commit docs**

```bash
git add README.md
git commit -m "docs: document graph explorer telemetry"
```

---

## Follow-On Plan

After this plan lands, write a second plan for production-grade graph derivation:

- durable SurrealQL queries for each graph mode;
- query-backed pattern candidates with noise weighting;
- GitHub connector or `gh` CLI ingestion command;
- real layout algorithm in the React graph canvas;
- Playwright/browser screenshots for `/graph` desktop and mobile;
- “What AI sees” context pack panel wired to `src/context/file-context.ts`.

## Self-Review

- Spec coverage: delivery promotion, PR reviews, PR size, phase size, back-and-forth duration, hands-free work, file noise, ask/outcome, feedback classification, and graph UI modes are each represented by a task.
- Placeholder scan: no task contains unresolved placeholders; follow-on items are explicitly out of this first implementation plan.
- Type consistency: graph explorer modes, node kinds, delivery labels, and phase names are defined before they are used by API and UI tasks.
