# Grounded Agent Files v0 - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v0 slice of grounded agent files - inline provenance markers (guidance + skill forms), `.ax/tasks/<id>.md` handoff envelope, and `axctl improve recommend / accept / lint / show` commands that wire it all together.

**Architecture:** ax derives proposals (already shipped) → user runs `axctl improve recommend` (filtered, print + clipboard) → `axctl improve accept <id>` upserts an `experiment` row and emits a self-contained task file → user's primary agent reads the task and edits the target file, leaving a provenance marker (paired HTML comments for markdown; YAML frontmatter for skill files) → `axctl improve lint` scans for markers, transitions the experiment from `task_emitted` to `scaffolded`, and removes the consumed task file.

**Tech Stack:** bun ≥ 1.3, TypeScript (strict, `module: preserve`), Effect 4.0.0-beta, SurrealDB v3 (ns=`ax`, db=`main`), `effect-cli` (`Command.make`). All tests use `bun:test`.

**Spec reference:** `docs/superpowers/specs/2026-05-27-grounded-agent-files-design.md`

**File map (v0):**

| File | Responsibility | Action |
|---|---|---|
| `schema/schema.surql` | DB schema | Modify - add `experiment.status`, `experiment.task_path` |
| `src/improve/markers.ts` | Parse paired HTML-comment markers + skill frontmatter `ax_id` | Create |
| `src/improve/markers.test.ts` | Unit tests for marker parser | Create |
| `src/improve/task-template.ts` | Render `.ax/tasks/<id>.md` content per form | Create |
| `src/improve/task-template.test.ts` | Snapshot tests for task templates | Create |
| `src/improve/actions.ts` | Existing `acceptProposal` - extend to emit tasks for all forms; `--auto-scaffold` retains skill direct path | Modify |
| `src/improve/agent-accept.test.ts` | Extend to cover guidance task emission + skill task vs auto-scaffold paths | Modify |
| `src/improve/lint.ts` | File discovery, marker scan, DB reconcile, task cleanup | Create |
| `src/improve/lint.test.ts` | Lint rules + DB transitions | Create |
| `src/improve/recommend.ts` | Query + rank `open` proposals, format for print | Create |
| `src/improve/recommend.test.ts` | Ranking + formatting | Create |
| `src/improve/show.ts` | Pretty-print one experiment incl. evidence + marker locations | Create |
| `src/improve/show.test.ts` | Render snapshot | Create |
| `src/cli/index.ts` | Wire `improve recommend`, `improve lint`; extend `improve accept` w/ `--auto-scaffold`; extend `improve show` to surface markers | Modify |
| `src/cli/recommend.test.ts` | CLI flag parity (filters, `--json`, clipboard) | Create |
| `src/cli/lint.test.ts` | CLI exit codes + output | Create |
| `tests/fixtures/agent-files/` | Marker fixtures (clean, orphan, duplicate, stale-task, multi-id, frontmatter) | Create |
| `src/improve/grounded-files.e2e.test.ts` | End-to-end: derive → accept → emit task → apply marker → lint reconciles | Create |

**Out of scope (v0):**
- Hook form (`echo 'ax:<id>'`) - v2.
- Subagent form - v1.
- Automation form - v3.
- `--apply` interactive picker UX - task 14 ships a minimal version; richer TUI deferred.
- `--patch` mode - deferred to v0.1.
- Dashboard `/improve` marker rendering - task 17 ships read-only experiment.status surface; richer marker view deferred.

---

## Task 1: Schema additions

**Files:**
- Modify: `schema/schema.surql` (the `experiment` table block; locate by searching for `DEFINE TABLE experiment SCHEMAFULL`)

- [ ] **Step 1: Locate the `experiment` table definition**

Run: `rg -n "^DEFINE TABLE experiment" schema/schema.surql`

Expected: one line, somewhere around 1280+.

- [ ] **Step 2: Add `status` and `task_path` fields**

Insert after the existing `DEFINE FIELD locked_verdict ON experiment ...` line:

```surql
DEFINE FIELD status     ON experiment TYPE string  DEFAULT 'task_emitted';
-- task_emitted | scaffolded | regressed | retired
DEFINE FIELD task_path  ON experiment TYPE option<string>;
-- absolute path to .ax/tasks/<id>.md while pending
DEFINE INDEX experiment_status_idx ON experiment FIELDS status;
```

- [ ] **Step 3: Apply schema to local DB**

Run: `bun scripts/apply-schema.ts` (if it exists) or `surreal import --conn http://127.0.0.1:8521 --user root --pass root --ns ax --db main schema/schema.surql`

Confirm via: `surreal sql --conn http://127.0.0.1:8521 --user root --pass root --ns ax --db main --pretty "INFO FOR TABLE experiment;"`

Expected: `status` and `task_path` appear under `fields`.

- [ ] **Step 4: Backfill existing rows**

Run:

```sql
UPDATE experiment SET status = 'scaffolded' WHERE status NONE AND artifact_path IS NOT NONE;
UPDATE experiment SET status = 'task_emitted' WHERE status NONE;
```

Verify: `SELECT status, count() FROM experiment GROUP BY status;` returns at least one row.

- [ ] **Step 5: Commit**

```bash
git add schema/schema.surql
git commit -m "schema(experiment): add status + task_path for grounded files"
```

---

## Task 2: Marker parser - paired HTML comments

**Files:**
- Create: `src/improve/markers.ts`
- Create: `src/improve/markers.test.ts`

- [ ] **Step 1: Write the failing test for the paired-comment parser**

`src/improve/markers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseInlineMarkers, type InlineMarker } from "./markers.ts";

describe("parseInlineMarkers", () => {
    test("returns empty array for content with no markers", () => {
        expect(parseInlineMarkers("hello world")).toEqual([]);
    });

    test("extracts a single paired marker", () => {
        const input = `prefix <!--ax:e7f3-->body<!--/ax:e7f3--> suffix`;
        const out = parseInlineMarkers(input);
        expect(out).toEqual([
            { id: "e7f3", body: "body", openIndex: 7, closeIndex: 27 } as InlineMarker,
        ]);
    });

    test("extracts multiline body", () => {
        const input = `<!--ax:9a21-->\n- one\n- two\n<!--/ax:9a21-->`;
        const out = parseInlineMarkers(input);
        expect(out).toHaveLength(1);
        expect(out[0]!.id).toBe("9a21");
        expect(out[0]!.body).toBe("\n- one\n- two\n");
    });

    test("extracts multiple markers with different ids", () => {
        const input = `<!--ax:aa-->one<!--/ax:aa--> mid <!--ax:bb-->two<!--/ax:bb-->`;
        const out = parseInlineMarkers(input);
        expect(out.map((m) => m.id)).toEqual(["aa", "bb"]);
    });

    test("reports unmatched open as error", () => {
        const input = `<!--ax:e7f3-->dangling`;
        expect(() => parseInlineMarkers(input)).toThrow(/unmatched open/i);
    });

    test("reports duplicate id within one document as error", () => {
        const input = `<!--ax:aa-->one<!--/ax:aa--> <!--ax:aa-->two<!--/ax:aa-->`;
        expect(() => parseInlineMarkers(input)).toThrow(/duplicate id/i);
    });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `bun test src/improve/markers.test.ts`

Expected: FAIL - `Cannot find module './markers.ts'`.

- [ ] **Step 3: Implement the parser**

`src/improve/markers.ts`:

```ts
/**
 * Provenance marker parser. Recognizes paired HTML-comment markers
 *   <!--ax:ID-->body<!--/ax:ID-->
 * used by guidance-form experiments grounded in user-owned markdown files
 * (AGENTS.md / CLAUDE.md). Body may span multiple lines and contain any
 * characters except a matching close tag for the same id.
 *
 * The parser is intentionally strict: a missing close tag or a duplicate
 * id is a structural error worth surfacing to the user (via `ax lint`).
 */

export interface InlineMarker {
    readonly id: string;
    readonly body: string;
    readonly openIndex: number;
    readonly closeIndex: number;
}

const OPEN = /<!--ax:([a-z0-9_-]+)-->/g;

export const parseInlineMarkers = (source: string): InlineMarker[] => {
    const markers: InlineMarker[] = [];
    const seen = new Set<string>();
    OPEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OPEN.exec(source)) !== null) {
        const id = match[1]!;
        const openIndex = match.index;
        const bodyStart = openIndex + match[0].length;
        const closeTag = `<!--/ax:${id}-->`;
        const closeIndex = source.indexOf(closeTag, bodyStart);
        if (closeIndex === -1) {
            throw new Error(`marker ${id}: unmatched open tag at offset ${openIndex}`);
        }
        if (seen.has(id)) {
            throw new Error(`marker ${id}: duplicate id within document`);
        }
        seen.add(id);
        markers.push({
            id,
            body: source.slice(bodyStart, closeIndex),
            openIndex,
            closeIndex: closeIndex + closeTag.length,
        });
        OPEN.lastIndex = closeIndex + closeTag.length;
    }
    return markers;
};
```

- [ ] **Step 4: Run the test and confirm pass**

Run: `bun test src/improve/markers.test.ts`

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/markers.ts src/improve/markers.test.ts
git commit -m "feat(improve): paired-comment marker parser for grounded files"
```

---

## Task 3: Marker parser - skill frontmatter `ax_id`

**Files:**
- Modify: `src/improve/markers.ts` (add `parseFrontmatterMarker`)
- Modify: `src/improve/markers.test.ts` (add describe block)

- [ ] **Step 1: Write the failing test**

Append to `src/improve/markers.test.ts`:

```ts
import { parseFrontmatterMarker } from "./markers.ts";

describe("parseFrontmatterMarker", () => {
    test("returns null when there is no frontmatter", () => {
        expect(parseFrontmatterMarker("# heading\nbody")).toBeNull();
    });

    test("returns null when frontmatter has no ax_id", () => {
        const input = `---\nname: foo\n---\nbody`;
        expect(parseFrontmatterMarker(input)).toBeNull();
    });

    test("extracts ax_id and ax_experiment", () => {
        const input = `---\nname: foo\nax_id: e7f3\nax_experiment: experiment:guid_e7f3__lk9\n---\nbody`;
        expect(parseFrontmatterMarker(input)).toEqual({
            id: "e7f3",
            experiment: "experiment:guid_e7f3__lk9",
        });
    });

    test("tolerates quoted values", () => {
        const input = `---\nax_id: "e7f3"\nax_experiment: 'experiment:abc'\n---\n`;
        expect(parseFrontmatterMarker(input)).toEqual({
            id: "e7f3",
            experiment: "experiment:abc",
        });
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/markers.test.ts -t parseFrontmatterMarker`

Expected: FAIL - function not exported.

- [ ] **Step 3: Implement**

Append to `src/improve/markers.ts`:

```ts
export interface FrontmatterMarker {
    readonly id: string;
    readonly experiment?: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;
const QUOTED = /^["'](.*)["']$/;

const stripQuotes = (raw: string): string => {
    const m = raw.match(QUOTED);
    return m ? m[1]! : raw;
};

export const parseFrontmatterMarker = (source: string): FrontmatterMarker | null => {
    const fm = source.match(FM);
    if (!fm) return null;
    const body = fm[1]!;
    let id: string | undefined;
    let experiment: string | undefined;
    for (const line of body.split(/\r?\n/)) {
        const eq = line.indexOf(":");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = stripQuotes(line.slice(eq + 1).trim());
        if (key === "ax_id") id = val;
        else if (key === "ax_experiment") experiment = val;
    }
    if (!id) return null;
    return experiment ? { id, experiment } : { id };
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/markers.test.ts`

Expected: 10 passing (6 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/improve/markers.ts src/improve/markers.test.ts
git commit -m "feat(improve): parse ax_id/ax_experiment from skill frontmatter"
```

---

## Task 4: Task template renderer

**Files:**
- Create: `src/improve/task-template.ts`
- Create: `src/improve/task-template.test.ts`

- [ ] **Step 1: Write the failing test**

`src/improve/task-template.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { renderTaskFile, type TaskInput } from "./task-template.ts";

const baseInput = (): TaskInput => ({
    form: "guidance",
    experimentId: "experiment:guid_e7f3__lk9",
    proposalId: "proposal:guid_e7f3",
    shortId: "e7f3",
    title: "Use ripgrep instead of grep",
    targetPath: "~/.claude/CLAUDE.md",
    section: "Terminal Optimization",
    suggestedBody: "Use ripgrep instead of grep. Faster and respects gitignore.",
    confidence: "high",
    frequency: 3,
    evidence: "12 corrections across 4 sessions",
    proposedBehavior: null,
});

describe("renderTaskFile", () => {
    test("guidance: includes marker pair around suggested body", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("<!--ax:e7f3-->");
        expect(out).toContain("<!--/ax:e7f3-->");
        expect(out).toContain("Use ripgrep instead of grep");
    });

    test("guidance: includes target path and section", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("~/.claude/CLAUDE.md");
        expect(out).toContain("Terminal Optimization");
    });

    test("guidance: references experiment + proposal ids", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("experiment:guid_e7f3__lk9");
        expect(out).toContain("proposal:guid_e7f3");
    });

    test("skill: instructs creating ~/.claude/skills/<slug>/SKILL.md", () => {
        const out = renderTaskFile({
            ...baseInput(),
            form: "skill",
            proposedBehavior: "Validate Bash preconditions before invocation.",
            targetPath: "~/.claude/skills/pre-bash-guard/SKILL.md",
            section: null,
            suggestedBody: "",
        });
        expect(out).toContain("Create");
        expect(out).toContain("~/.claude/skills/pre-bash-guard/SKILL.md");
        expect(out).toContain("ax_id: e7f3");
        expect(out).toContain("Validate Bash preconditions");
    });

    test("includes a Lint section referencing `axctl improve lint`", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("axctl improve lint");
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/task-template.test.ts`

Expected: FAIL - module missing.

- [ ] **Step 3: Implement**

`src/improve/task-template.ts`:

```ts
/**
 * Render a self-contained `.ax/tasks/<shortId>.md` brief that the user's
 * primary agent can act on. v0 covers guidance + skill forms; subagent /
 * hook / automation are stubs that throw until their phase lands.
 */

export type TaskForm = "guidance" | "skill" | "subagent" | "hook" | "automation";

export interface TaskInput {
    readonly form: TaskForm;
    readonly experimentId: string;
    readonly proposalId: string;
    readonly shortId: string;
    readonly title: string;
    readonly targetPath: string;
    readonly section: string | null;
    readonly suggestedBody: string;
    readonly proposedBehavior: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly evidence: string;
}

const guidance = (i: TaskInput): string => `# ax task: ${i.shortId} (form=guidance)

**Action:** insert guidance block
**Target:** \`${i.targetPath}\`${i.section ? ` → \`## ${i.section}\`` : ""}
**Marker:** \`<!--ax:${i.shortId}-->...<!--/ax:${i.shortId}-->\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Open \`${i.targetPath}\`.${i.section ? ` Locate \`## ${i.section}\`. If the section does not exist, create it near related content.` : ""}
2. Insert the marker block below. You may reword the body but keep the
   \`<!--ax:${i.shortId}-->\` and \`<!--/ax:${i.shortId}-->\` tags untouched.
3. Run \`axctl improve lint ${i.targetPath}\`. Resolve any warnings.
4. Commit. This task file is removed automatically by \`axctl improve lint\`
   once it sees the marker land in the target.

## Suggested block

\`\`\`md
<!--ax:${i.shortId}-->
${i.suggestedBody}
<!--/ax:${i.shortId}-->
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;

const skill = (i: TaskInput): string => {
    const body = (i.proposedBehavior ?? i.suggestedBody).trim();
    return `# ax task: ${i.shortId} (form=skill)

**Action:** create skill file
**Target:** \`${i.targetPath}\`
**Provenance:** YAML frontmatter \`ax_id: ${i.shortId}\`

## Why
${i.evidence}.
Proposal: ${i.proposalId}
Experiment: ${i.experimentId}
Confidence: ${i.confidence}. Frequency: ${i.frequency}/wk.

## Apply
1. Create \`${i.targetPath}\`. The frontmatter MUST contain \`ax_id\` and
   \`ax_experiment\` exactly as shown below - \`axctl improve lint\` keys
   off them to reconcile the experiment.
2. Edit the body freely; the trigger pattern and behavior below are a
   starting point.
3. Run \`axctl improve lint\`. The task file is removed automatically
   once the lint pass sees the frontmatter.

## Suggested content

\`\`\`md
---
name: ${i.title}
description: ${i.title}
ax_id: ${i.shortId}
ax_experiment: ${i.experimentId}
---

# ${i.title}

${body}
\`\`\`

## References
- proposal: ${i.proposalId}
- experiment: ${i.experimentId}
- evidence-cmd: \`axctl improve show ${i.shortId}\`
`;
};

export const renderTaskFile = (input: TaskInput): string => {
    switch (input.form) {
        case "guidance":
            return guidance(input);
        case "skill":
            return skill(input);
        case "subagent":
        case "hook":
        case "automation":
            throw new Error(`task template for form=${input.form} not yet implemented (v1+)`);
    }
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/task-template.test.ts`

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/task-template.ts src/improve/task-template.test.ts
git commit -m "feat(improve): task-template renderer for guidance + skill forms"
```

---

## Task 5: Refactor `acceptProposal` to emit task files

**Files:**
- Modify: `src/improve/actions.ts`
- Modify: `src/improve/agent-accept.test.ts` (also rename the file is NOT needed; just extend)

- [ ] **Step 1: Read current `acceptProposal` end-to-end**

Run: `bun --bun cat src/improve/actions.ts | wc -l`

Familiarize w/ the existing skill-only path before touching it. The new behavior must NOT regress the existing `--auto-scaffold` flow.

- [ ] **Step 2: Write the failing test**

Append to `src/improve/agent-accept.test.ts` (under a new describe block; if the file's existing tests need the `runAgentAccept` import, leave them alone):

```ts
// new tests appended to existing file
import { describe as describeAccept, expect as expectAccept, test as testAccept } from "bun:test";
import { Effect, Layer } from "effect";
import { acceptProposal } from "./actions.ts";
import { SurrealClient } from "../lib/db.ts";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeRowsLayer = (fixtures: ReadonlyArray<unknown[]>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed(fixtures as unknown as T),
    } as never);

describeAccept("acceptProposal - task emission", () => {
    testAccept("guidance form emits .ax/tasks/<id>.md (no direct file scaffold)", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: { tb: "proposal", id: "guid_e7f3" },
            form: "guidance",
            title: "Use ripgrep instead of grep",
            hypothesis: "12 corrections across 4 sessions",
            dedupe_sig: "e7f3",
            status: "open",
            skill_payload: null,
            guidance_payload: {
                file_target: "~/.claude/CLAUDE.md",
                section: "Terminal Optimization",
                suggested_text: "Use ripgrep, not grep.",
            },
        };
        const program = acceptProposal({ sigOrId: "e7f3", taskDir });
        const result = await Effect.runPromise(
            program.pipe(Effect.provide(fakeRowsLayer([[proposalRow], []]))),
        );
        expectAccept(result.status).toBe("ok");
        expectAccept(result.task_path).toBeDefined();
        expectAccept(existsSync(result.task_path!)).toBe(true);
        const body = readFileSync(result.task_path!, "utf-8");
        expectAccept(body).toContain("form=guidance");
        expectAccept(body).toContain("<!--ax:e7f3-->");
    });

    testAccept("skill form defaults to task emission (no auto-scaffold)", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: { tb: "proposal", id: "guid_skill1" },
            form: "skill",
            title: "Pre-Bash guard",
            hypothesis: "Bash failed 7×",
            dedupe_sig: "skill1",
            status: "open",
            skill_payload: { proposed_behavior: "validate" },
        };
        const program = acceptProposal({ sigOrId: "skill1", taskDir });
        const result = await Effect.runPromise(
            program.pipe(Effect.provide(fakeRowsLayer([[proposalRow], []]))),
        );
        expectAccept(result.status).toBe("ok");
        expectAccept(result.task_path).toBeDefined();
        expectAccept(result.artifact_path).toBeUndefined();
        const body = readFileSync(result.task_path!, "utf-8");
        expectAccept(body).toContain("form=skill");
        expectAccept(body).toContain("ax_id: skill1");
    });

    testAccept("skill form with autoScaffold=true preserves existing direct-write path", async () => {
        const scaffoldDir = mkdtempSync(join(tmpdir(), "ax-skills-"));
        const proposalRow = {
            id: { tb: "proposal", id: "guid_skill2" },
            form: "skill",
            title: "Some other skill",
            hypothesis: "h",
            dedupe_sig: "skill2",
            status: "open",
            skill_payload: { proposed_behavior: "do thing" },
        };
        const program = acceptProposal({
            sigOrId: "skill2",
            autoScaffold: true,
            scaffoldBaseDir: scaffoldDir,
        });
        const result = await Effect.runPromise(
            program.pipe(Effect.provide(fakeRowsLayer([[proposalRow], []]))),
        );
        expectAccept(result.status).toBe("ok");
        expectAccept(result.artifact_path).toBeDefined();
        expectAccept(existsSync(result.artifact_path!)).toBe(true);
    });
});
```

- [ ] **Step 3: Run, confirm fail**

Run: `bun test src/improve/agent-accept.test.ts -t "task emission"`

Expected: FAIL - `acceptProposal` either returns `unsupported_form` for guidance or doesn't expose `task_path`.

- [ ] **Step 4: Refactor `acceptProposal`**

Modify `src/improve/actions.ts`. Replace the existing `AcceptOptions` interface and `acceptProposal` export with:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTaskFile, type TaskForm, type TaskInput } from "./task-template.ts";

export interface AcceptOptions {
    readonly sigOrId: string;
    readonly force?: boolean;
    readonly autoScaffold?: boolean;
    readonly scaffoldBaseDir?: string;
    readonly taskDir?: string;
}

const VALID_FORMS = new Set<TaskForm>(["guidance", "skill", "subagent", "hook", "automation"]);
const V0_FORMS = new Set<TaskForm>(["guidance", "skill"]);

const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? join(process.cwd(), ".ax", "tasks");

interface FullProposalRow extends ProposalRow {
    readonly guidance_payload?: {
        readonly file_target: string;
        readonly section?: string | null;
        readonly suggested_text: string;
    } | null;
}

const fetchFullProposal = (idLiteral: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[FullProposalRow[]]>(`
            SELECT *,
                (SELECT * FROM skill_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
                (SELECT * FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload
            FROM proposal WHERE dedupe_sig = ${idLiteral} OR id = ${idLiteral} LIMIT 1;
        `);
        return (result?.[0] ?? [])[0] ?? null;
    });

const buildTaskInput = (
    row: FullProposalRow,
    experimentId: string,
): TaskInput => {
    const form = row.form as TaskForm;
    const targetPath = form === "guidance"
        ? row.guidance_payload?.file_target ?? "~/.claude/CLAUDE.md"
        : `~/.claude/skills/${row.dedupe_sig}/SKILL.md`;
    const suggestedBody = form === "guidance"
        ? row.guidance_payload?.suggested_text ?? row.hypothesis
        : "";
    const proposedBehavior = form === "skill"
        ? String((row.skill_payload as Record<string, unknown> | null)?.proposed_behavior ?? "")
        : null;
    return {
        form,
        experimentId,
        proposalId: `proposal:${recordKeyPart(row.id, "proposal") ?? ""}`,
        shortId: row.dedupe_sig,
        title: row.title,
        targetPath,
        section: form === "guidance" ? row.guidance_payload?.section ?? null : null,
        suggestedBody,
        proposedBehavior,
        confidence: row.confidence ?? "medium",
        frequency: row.frequency ?? 0,
        evidence: row.hypothesis,
    };
};

export const acceptProposal = (
    opts: AcceptOptions,
): Effect.Effect<AcceptResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const idLiteral = surrealLiteral(opts.sigOrId);
        const row = yield* fetchFullProposal(idLiteral);
        if (!row) return { status: "not_found", message: `no proposal matched ${opts.sigOrId}` };
        const proposalKey = recordKeyPart(row.id, "proposal");
        if (!proposalKey) return { status: "not_found", message: "proposal.id unexpected" };

        const form = row.form as TaskForm;
        if (!VALID_FORMS.has(form)) {
            return { status: "unsupported_form", message: `unknown form: ${row.form}` };
        }
        if (!V0_FORMS.has(form)) {
            return {
                status: "unsupported_form",
                message: `accept supports guidance + skill in v0 (got ${row.form}); subagent/hook/automation land in v1-v3`,
            };
        }

        if (row.status !== "open") {
            return { status: "wrong_status", message: `proposal already ${row.status}` };
        }

        const db = yield* SurrealClient;
        const experimentKey = `${proposalKey}__${Date.now().toString(36)}`;
        const experimentId = `experiment:${experimentKey}`;

        // Auto-scaffold path (skill only, opt-in)
        if (opts.autoScaffold && form === "skill") {
            const payload = (row.skill_payload as Record<string, unknown> | null) ?? null;
            if (!payload) return { status: "missing_payload", message: "skill_proposal payload missing" };
            const scaffold = scaffoldSkill({
                input: {
                    title: row.title,
                    hypothesis: row.hypothesis,
                    proposedBehavior: String(payload.proposed_behavior ?? ""),
                    triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
                    expectedImpact: payload.expected_impact == null ? null : String(payload.expected_impact),
                    dedupeSig: row.dedupe_sig,
                    nowIso: new Date().toISOString(),
                },
                ...(opts.scaffoldBaseDir === undefined ? {} : { baseDir: opts.scaffoldBaseDir }),
                ...(opts.force === undefined ? {} : { force: opts.force }),
            });
            if (scaffold.skipped) {
                return {
                    status: "scaffold_exists",
                    message: `existing scaffold at ${scaffold.path} (pass force=true to overwrite)`,
                    artifact_path: scaffold.path,
                };
            }
            yield* db.query(`
                UPDATE ${recordRef("proposal", proposalKey)} SET status = 'accepted', updated_at = time::now();
                UPSERT ${recordRef("experiment", experimentKey)} MERGE {
                    proposal: ${recordRef("proposal", proposalKey)},
                    artifact_path: ${surrealLiteral(scaffold.path)},
                    status: 'scaffolded',
                    scaffolded_at: time::now()
                };
            `);
            return {
                status: "ok",
                proposal_id: `proposal:${proposalKey}`,
                experiment_id: experimentId,
                artifact_path: scaffold.path,
            };
        }

        // Task-emission path (default for all forms)
        const taskDir = opts.taskDir ?? defaultTaskDir();
        mkdirSync(taskDir, { recursive: true });
        const taskPath = join(taskDir, `${row.dedupe_sig}.md`);
        if (existsSync(taskPath) && !opts.force) {
            return {
                status: "scaffold_exists",
                message: `task file already at ${taskPath} (pass force=true to overwrite)`,
                task_path: taskPath,
            };
        }
        const taskInput = buildTaskInput(row, experimentId);
        writeFileSync(taskPath, renderTaskFile(taskInput), { encoding: "utf-8" });

        yield* db.query(`
            UPDATE ${recordRef("proposal", proposalKey)} SET status = 'accepted', updated_at = time::now();
            UPSERT ${recordRef("experiment", experimentKey)} MERGE {
                proposal: ${recordRef("proposal", proposalKey)},
                status: 'task_emitted',
                task_path: ${surrealLiteral(taskPath)}
            };
        `);
        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            experiment_id: experimentId,
            task_path: taskPath,
        };
    });
```

Also extend the `AcceptResult` interface (top of file) with `task_path?: string`.

Add the missing import:

```ts
import { existsSync } from "node:fs";
```

- [ ] **Step 5: Run all impacted tests and confirm pass**

Run: `bun test src/improve/`

Expected: every existing test still passes + 3 new "task emission" tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/improve/actions.ts src/improve/agent-accept.test.ts
git commit -m "feat(improve): acceptProposal emits .ax/tasks/<id>.md by default"
```

---

## Task 6: Wire `--auto-scaffold` flag into `axctl improve accept`

**Files:**
- Modify: `src/cli/index.ts` (the `improveAcceptCommand` block near line 1995)

- [ ] **Step 1: Locate the command**

Run: `rg -n "const improveAcceptCommand" src/cli/index.ts`

- [ ] **Step 2: Add the flag + plumb through**

Inside the Effect-CLI `Command.make("accept", { ... })`, add an `autoScaffold` option:

```ts
const autoScaffoldOption = Options.boolean("auto-scaffold").pipe(
    Options.withDescription("Skip task emission and directly scaffold the SKILL.md (skill form only)"),
    Options.withDefault(false),
);
```

(If the CLI does not already import `Options`, add `import { Options } from "@effect/cli";` near the other Effect-CLI imports.)

Then in the handler that calls `acceptProposal({...})`, pass `autoScaffold` through. After the call, if `result.task_path` is set, print:

```ts
console.log(`task emitted at ${result.task_path}`);
console.log(`apply with your agent: \`claude "do ${result.task_path}"\``);
console.log(`reconcile after edit: \`axctl improve lint\``);
```

If `result.artifact_path` is set (auto-scaffold), retain the existing log line.

- [ ] **Step 3: Manual smoke**

Run:

```bash
bun src/cli/index.ts improve accept some-sig --auto-scaffold --help
```

Expected: help output includes `--auto-scaffold`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): axctl improve accept --auto-scaffold (skill direct-write)"
```

---

## Task 7: Lint core - file discovery

**Files:**
- Create: `src/improve/lint.ts`
- Create: `src/improve/lint.test.ts`

- [ ] **Step 1: Write the failing test**

`src/improve/lint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles, type LintTarget } from "./lint.ts";

const make = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# user file");
    writeFileSync(join(root, "AGENTS.md"), "# agents file");
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\n---\nbody");
    writeFileSync(join(root, "agents", "bar.md"), "---\n---\nprompt");
    return root;
};

describe("discoverFiles", () => {
    test("walks the given roots and returns categorized targets", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const paths = out.map((t: LintTarget) => t.path).sort();
        expect(paths).toContain(join(root, "CLAUDE.md"));
        expect(paths).toContain(join(root, "AGENTS.md"));
        expect(paths).toContain(join(root, "skills", "foo", "SKILL.md"));
    });

    test("tags each target with form=guidance/skill/subagent", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const claude = out.find((t) => t.path.endsWith("CLAUDE.md"));
        expect(claude?.form).toBe("guidance");
        const skill = out.find((t) => t.path.endsWith("SKILL.md"));
        expect(skill?.form).toBe("skill");
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/lint.test.ts`

Expected: FAIL - module missing.

- [ ] **Step 3: Implement file discovery**

`src/improve/lint.ts`:

```ts
/**
 * Lint walker for grounded agent files. v0 discovers:
 *   - <root>/AGENTS.md, <root>/CLAUDE.md       → form=guidance
 *   - <root>/skills/<slug>/SKILL.md            → form=skill
 *   - <root>/agents/<slug>.md                  → form=subagent  (v1 reads only)
 *
 * The default roots are `process.cwd()` (walking up to the git root) and
 * `~/.claude`. Override via `discoverFiles({ roots: [...] })`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LintForm = "guidance" | "skill" | "subagent";

export interface LintTarget {
    readonly path: string;
    readonly form: LintForm;
}

export interface DiscoverOptions {
    readonly roots?: ReadonlyArray<string>;
}

const tryAddFile = (out: LintTarget[], path: string, form: LintForm): void => {
    if (existsSync(path)) out.push({ path, form });
};

const walkSkillsDir = (out: LintTarget[], skillsDir: string): void => {
    if (!existsSync(skillsDir)) return;
    for (const entry of readdirSync(skillsDir)) {
        const full = join(skillsDir, entry);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch { continue; }
        tryAddFile(out, join(full, "SKILL.md"), "skill");
    }
};

const walkAgentsDir = (out: LintTarget[], agentsDir: string): void => {
    if (!existsSync(agentsDir)) return;
    for (const entry of readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) continue;
        tryAddFile(out, join(agentsDir, entry), "subagent");
    }
};

export const defaultRoots = (): string[] => [
    process.cwd(),
    join(homedir(), ".claude"),
];

export const discoverFiles = (opts: DiscoverOptions = {}): LintTarget[] => {
    const roots = opts.roots ?? defaultRoots();
    const out: LintTarget[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            tryAddFile(out, join(root, name), "guidance");
        }
        walkSkillsDir(out, join(root, "skills"));
        walkAgentsDir(out, join(root, "agents"));
    }
    return out.filter((t) => {
        if (seen.has(t.path)) return false;
        seen.add(t.path);
        return true;
    });
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/lint.test.ts`

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/lint.ts src/improve/lint.test.ts
git commit -m "feat(improve): lint file discovery (CLAUDE.md, AGENTS.md, skills/, agents/)"
```

---

## Task 8: Lint - marker scan + DB reconcile + task cleanup

**Files:**
- Modify: `src/improve/lint.ts` (add `lintFiles`)
- Modify: `src/improve/lint.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/improve/lint.test.ts`:

```ts
import { Effect, Layer } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { lintFiles, type LintReport } from "./lint.ts";
import { existsSync as fsExists } from "node:fs";

interface QueryRecorder { calls: string[]; }
const recordingLayer = (recorder: QueryRecorder, fixtures: ReadonlyArray<unknown[]>) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => Effect.sync(() => {
            recorder.calls.push(sql);
            return (fixtures[i++] ?? []) as unknown as T;
        }),
    } as never);
};

describe("lintFiles", () => {
    test("clean file → no findings", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "no markers here");
        const rec: QueryRecorder = { calls: [] };
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, []))),
        );
        expect(report.errors).toHaveLength(0);
        expect(report.warnings).toHaveLength(0);
    });

    test("orphan marker → warning", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:orphan-->body<!--/ax:orphan-->");
        const rec: QueryRecorder = { calls: [] };
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [[]]))),
            // DB returns no matching experiment
        );
        expect(report.warnings.some((w) => w.rule === "orphan_id")).toBe(true);
    });

    test("marker matches pending task → cleanup deletes task, DB updates status", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        const taskDir = join(root, ".ax", "tasks");
        mkdirSync(taskDir, { recursive: true });
        const taskFile = join(taskDir, "e7f3.md");
        writeFileSync(taskFile, "# pending task");
        writeFileSync(
            join(root, "CLAUDE.md"),
            "<!--ax:e7f3-->Use ripgrep, not grep.<!--/ax:e7f3-->",
        );
        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:abc",
            short_id: "e7f3",
            status: "task_emitted",
            task_path: taskFile,
            locked_verdict: null,
        }];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture, []]))),
        );
        expect(report.reconciled.some((r) => r.shortId === "e7f3")).toBe(true);
        expect(fsExists(taskFile)).toBe(false);
        expect(rec.calls.some((c) => /status\s*=\s*'scaffolded'/.test(c))).toBe(true);
    });

    test("regressed verdict → info-level note (not error)", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(
            join(root, "CLAUDE.md"),
            "<!--ax:abc-->stale rule<!--/ax:abc-->",
        );
        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:abc",
            short_id: "abc",
            status: "scaffolded",
            task_path: null,
            locked_verdict: "regressed",
        }];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture]))),
        );
        expect(report.infos.some((i) => i.rule === "regressed_verdict")).toBe(true);
        expect(report.errors).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/lint.test.ts`

Expected: FAIL - `lintFiles` not exported.

- [ ] **Step 3: Implement `lintFiles`**

Append to `src/improve/lint.ts`:

```ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { surrealLiteral } from "../lib/json.ts";
import { parseInlineMarkers, parseFrontmatterMarker } from "./markers.ts";
import type { DbError } from "../lib/errors.ts";

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
    readonly rule: string;
    readonly severity: LintSeverity;
    readonly path: string;
    readonly id?: string;
    readonly message: string;
}

export interface LintReconciliation {
    readonly shortId: string;
    readonly experimentId: string;
    readonly previousStatus: string;
    readonly nextStatus: string;
    readonly taskDeleted: string | null;
}

export interface LintReport {
    readonly errors: LintFinding[];
    readonly warnings: LintFinding[];
    readonly infos: LintFinding[];
    readonly reconciled: LintReconciliation[];
}

interface ExperimentRow {
    readonly id: string;
    readonly short_id: string;
    readonly status: string;
    readonly task_path: string | null;
    readonly locked_verdict: string | null;
}

const collectIds = (target: LintTarget, errors: LintFinding[]): Map<string, string> => {
    const found = new Map<string, string>();
    let content: string;
    try {
        content = readFileSync(target.path, "utf-8");
    } catch {
        return found;
    }
    if (target.form === "guidance") {
        try {
            for (const m of parseInlineMarkers(content)) found.set(m.id, target.path);
        } catch (err) {
            errors.push({
                rule: "marker_parse_error",
                severity: "error",
                path: target.path,
                message: (err as Error).message,
            });
        }
    } else {
        const fm = parseFrontmatterMarker(content);
        if (fm) found.set(fm.id, target.path);
    }
    return found;
};

export const lintFiles = (
    opts: DiscoverOptions = {},
): Effect.Effect<LintReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const targets = discoverFiles(opts);
        const errors: LintFinding[] = [];
        const warnings: LintFinding[] = [];
        const infos: LintFinding[] = [];
        const reconciled: LintReconciliation[] = [];

        const idToPath = new Map<string, string>();
        for (const t of targets) {
            const found = collectIds(t, errors);
            for (const [id, path] of found) {
                if (idToPath.has(id)) {
                    warnings.push({
                        rule: "id_collision",
                        severity: "warning",
                        path,
                        id,
                        message: `id ${id} also in ${idToPath.get(id)}`,
                    });
                } else {
                    idToPath.set(id, path);
                }
            }
        }

        if (idToPath.size === 0) {
            return { errors, warnings, infos, reconciled };
        }

        const db = yield* SurrealClient;
        const idList = [...idToPath.keys()].map(surrealLiteral).join(",");
        const result = yield* db.query<[ExperimentRow[]]>(`
            SELECT
                type::string(id) AS id,
                proposal.dedupe_sig AS short_id,
                status,
                task_path,
                locked_verdict
            FROM experiment WHERE proposal.dedupe_sig IN [${idList}];
        `);
        const rows = result?.[0] ?? [];
        const byShortId = new Map(rows.map((r) => [r.short_id, r]));

        const updates: string[] = [];
        for (const [id, path] of idToPath) {
            const row = byShortId.get(id);
            if (!row) {
                warnings.push({
                    rule: "orphan_id",
                    severity: "warning",
                    path,
                    id,
                    message: `marker ${id} has no experiment row (consider \`axctl improve forget ${id}\`)`,
                });
                continue;
            }
            if (row.locked_verdict === "regressed") {
                infos.push({
                    rule: "regressed_verdict",
                    severity: "info",
                    path,
                    id,
                    message: `experiment ${id} locked as regressed - consider removing the marker`,
                });
            }
            if (row.status === "task_emitted") {
                let taskDeleted: string | null = null;
                if (row.task_path && existsSync(row.task_path)) {
                    try {
                        unlinkSync(row.task_path);
                        taskDeleted = row.task_path;
                    } catch { /* leave it */ }
                }
                updates.push(
                    `UPDATE ${row.id} SET status = 'scaffolded', scaffolded_at = time::now(), artifact_path = ${surrealLiteral(path)};`,
                );
                reconciled.push({
                    shortId: id,
                    experimentId: row.id,
                    previousStatus: row.status,
                    nextStatus: "scaffolded",
                    taskDeleted,
                });
            }
        }

        if (updates.length > 0) {
            yield* db.query(updates.join("\n"));
        }

        return { errors, warnings, infos, reconciled };
    });
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/lint.test.ts`

Expected: 6 passing (2 from task 7 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/improve/lint.ts src/improve/lint.test.ts
git commit -m "feat(improve): lintFiles reconciles markers with experiment table"
```

---

## Task 9: Lint - stale-task detection

**Files:**
- Modify: `src/improve/lint.ts`
- Modify: `src/improve/lint.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/improve/lint.test.ts`:

```ts
test("stale task (no marker found, task file >7 days old) → warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    const taskDir = join(root, ".ax", "tasks");
    mkdirSync(taskDir, { recursive: true });
    const taskFile = join(taskDir, "stale.md");
    writeFileSync(taskFile, "# old task");
    // backdate
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    require("node:fs").utimesSync(taskFile, eightDaysAgo, eightDaysAgo);

    const rec: QueryRecorder = { calls: [] };
    const experimentFixture = [{
        id: "experiment:stale",
        short_id: "stale",
        status: "task_emitted",
        task_path: taskFile,
        locked_verdict: null,
    }];
    const program = lintFiles({ roots: [root], staleDays: 7 });
    const report = await Effect.runPromise(
        program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture]))),
    );
    expect(report.warnings.some((w) => w.rule === "stale_task")).toBe(true);
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/lint.test.ts -t "stale task"`

Expected: FAIL - `lintFiles` rejects unknown option `staleDays`, or no warning emitted.

- [ ] **Step 3: Extend `LintOptions` + implementation**

Modify the `DiscoverOptions` import in `lint.ts` to declare a richer options shape, OR add a new `LintOptions` interface that extends it:

```ts
export interface LintOptions extends DiscoverOptions {
    readonly staleDays?: number;
}
```

Update the `lintFiles` signature to accept `LintOptions`. Then add this block immediately before the final `return` in `lintFiles`:

```ts
import { statSync } from "node:fs";

// stale-task scan: experiments still `task_emitted` whose task file is
// older than the cutoff and whose marker is absent from disk.
const staleCutoffDays = opts.staleDays ?? 7;
const cutoffMs = Date.now() - staleCutoffDays * 86_400_000;
const staleResult = yield* db.query<[ExperimentRow[]]>(`
    SELECT
        type::string(id) AS id,
        proposal.dedupe_sig AS short_id,
        status,
        task_path,
        locked_verdict
    FROM experiment
    WHERE status = 'task_emitted' AND task_path IS NOT NONE;
`);
for (const row of staleResult?.[0] ?? []) {
    if (idToPath.has(row.short_id)) continue;
    if (!row.task_path || !existsSync(row.task_path)) continue;
    let mtimeMs: number;
    try {
        mtimeMs = statSync(row.task_path).mtimeMs;
    } catch { continue; }
    if (mtimeMs < cutoffMs) {
        warnings.push({
            rule: "stale_task",
            severity: "warning",
            path: row.task_path,
            id: row.short_id,
            message: `task file >${staleCutoffDays}d old with no marker (consider \`axctl improve reject ${row.short_id}\`)`,
        });
    }
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/lint.test.ts`

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/lint.ts src/improve/lint.test.ts
git commit -m "feat(improve): lint warns on stale .ax/tasks/*.md (>7d, no marker)"
```

---

## Task 10: Wire `axctl improve lint` CLI command

**Files:**
- Modify: `src/cli/index.ts`
- Create: `src/cli/lint.test.ts`

- [ ] **Step 1: Write the failing test**

`src/cli/lint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("axctl improve lint", () => {
    test("--help mentions --json and --stale-days", () => {
        const cli = spawnSync("bun", ["src/cli/index.ts", "improve", "lint", "--help"], {
            encoding: "utf-8",
        });
        expect(cli.stdout + cli.stderr).toContain("--json");
        expect(cli.stdout + cli.stderr).toContain("--stale-days");
    });

    test("clean run on an empty dir exits 0", () => {
        const root = mkdtempSync(join(tmpdir(), "ax-cli-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "no markers");
        const cli = spawnSync("bun", [
            "src/cli/index.ts", "improve", "lint", "--root", root, "--json",
        ], { encoding: "utf-8" });
        expect(cli.status).toBe(0);
        const out = JSON.parse(cli.stdout);
        expect(out.errors).toEqual([]);
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/cli/lint.test.ts`

Expected: FAIL - `improve lint` subcommand does not exist.

- [ ] **Step 3: Register the command**

In `src/cli/index.ts`, near the other `improve*` commands, add:

```ts
const lintRootOption = Options.text("root").pipe(
    Options.withDescription("Root directory to scan (repeatable)"),
    Options.repeated,
    Options.optional,
);

const lintJsonOption = Options.boolean("json").pipe(
    Options.withDescription("Emit JSON report"),
    Options.withDefault(false),
);

const lintStaleDaysOption = Options.integer("stale-days").pipe(
    Options.withDescription("Days after which an unreconciled task file is flagged stale"),
    Options.withDefault(7),
);

const improveLintCommand = Command.make(
    "lint",
    { roots: lintRootOption, json: lintJsonOption, staleDays: lintStaleDaysOption },
    ({ roots, json, staleDays }) =>
        Effect.gen(function* () {
            const rootList = roots._tag === "Some" ? roots.value : undefined;
            const report = yield* lintFiles({
                ...(rootList ? { roots: rootList } : {}),
                staleDays,
            });
            if (json) {
                console.log(JSON.stringify(report, null, 2));
            } else {
                for (const e of report.errors) console.error(`error  ${e.rule}: ${e.message} (${e.path})`);
                for (const w of report.warnings) console.warn(`warn   ${w.rule}: ${w.message} (${w.path})`);
                for (const i of report.infos) console.log(`info   ${i.rule}: ${i.message} (${i.path})`);
                for (const r of report.reconciled) {
                    console.log(`reconciled ${r.shortId}: ${r.previousStatus} -> ${r.nextStatus}` +
                        (r.taskDeleted ? ` (removed ${r.taskDeleted})` : ""));
                }
                if (
                    report.errors.length === 0 &&
                    report.warnings.length === 0 &&
                    report.infos.length === 0 &&
                    report.reconciled.length === 0
                ) {
                    console.log("clean.");
                }
            }
            if (report.errors.length > 0) yield* Effect.fail(new Error("lint errors") as never);
            else if (report.warnings.length > 0) process.exitCode = 1;
        }),
).pipe(Command.withDescription("Scan agent files, reconcile markers with experiments"));
```

Add `improveLintCommand` to the `improveCommand.pipe(Command.withSubcommands(...))` list.

Add the import: `import { lintFiles } from "../improve/lint.ts";`

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/cli/lint.test.ts`

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/lint.test.ts
git commit -m "feat(cli): axctl improve lint (scan + reconcile + cleanup)"
```

---

## Task 11: Recommend - query + rank `open` proposals

**Files:**
- Create: `src/improve/recommend.ts`
- Create: `src/improve/recommend.test.ts`

- [ ] **Step 1: Write the failing test**

`src/improve/recommend.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { recommend, type RecommendInput, type RecommendItem } from "./recommend.ts";
import { SurrealClient } from "../lib/db.ts";

const layerWith = (rows: ReadonlyArray<unknown>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed([rows] as unknown as T),
    } as never);

describe("recommend", () => {
    test("ranks by confidence × recency × frequency", async () => {
        const rows = [
            { dedupe_sig: "lowfreq", title: "x", form: "guidance", hypothesis: "h", confidence: "low",
              frequency: 1, updated_at: "2026-01-01T00:00:00Z" },
            { dedupe_sig: "hot", title: "y", form: "guidance", hypothesis: "h", confidence: "high",
              frequency: 10, updated_at: "2026-05-20T00:00:00Z" },
            { dedupe_sig: "old", title: "z", form: "guidance", hypothesis: "h", confidence: "medium",
              frequency: 5, updated_at: "2025-12-01T00:00:00Z" },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5 }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.map((r: RecommendItem) => r.shortId)).toEqual(["hot", "old", "lowfreq"]);
    });

    test("honors --limit", async () => {
        const rows = Array.from({ length: 12 }).map((_, i) => ({
            dedupe_sig: `s${i}`, title: "t", form: "guidance", hypothesis: "h",
            confidence: "medium", frequency: i, updated_at: "2026-05-20T00:00:00Z",
        }));
        const out = await Effect.runPromise(
            recommend({ limit: 3 }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.length).toBe(3);
    });

    test("filters by form", async () => {
        const rows = [
            { dedupe_sig: "a", form: "skill", title: "t", hypothesis: "h", confidence: "high", frequency: 1, updated_at: "2026-05-20T00:00:00Z" },
            { dedupe_sig: "b", form: "guidance", title: "t", hypothesis: "h", confidence: "high", frequency: 1, updated_at: "2026-05-20T00:00:00Z" },
        ];
        const out = await Effect.runPromise(
            recommend({ limit: 5, forms: ["guidance"] }).pipe(Effect.provide(layerWith(rows))),
        );
        expect(out.map((r) => r.shortId)).toEqual(["b"]);
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/recommend.test.ts`

Expected: FAIL - module missing.

- [ ] **Step 3: Implement**

`src/improve/recommend.ts`:

```ts
/**
 * Manual recommendation engine. Pulls `open` proposals from the DB and
 * ranks them by `confidence_weight × recency_weight × log(frequency+1)`.
 * Returns a flat list the CLI/dashboard can render however it likes.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

export interface RecommendInput {
    readonly limit: number;
    readonly forms?: ReadonlyArray<string>;
    readonly project?: string;
    readonly cwd?: string;
    readonly agent?: "claude" | "codex";
    readonly sinceDays?: number;
}

export interface RecommendItem {
    readonly shortId: string;
    readonly title: string;
    readonly form: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly score: number;
    readonly updatedAt: string;
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1,
};

const recency = (iso: string): number => {
    const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    return Math.max(0.1, 1 / Math.log(2 + Math.max(0, days)));
};

const score = (row: { confidence: string; frequency: number; updated_at: string }): number => {
    const c = CONFIDENCE_WEIGHT[row.confidence] ?? 1;
    return c * recency(row.updated_at) * Math.log(row.frequency + 1 + 1e-3);
};

export const recommend = (
    input: RecommendInput,
): Effect.Effect<RecommendItem[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Filtering by project/cwd/agent requires joining sessions; v0 keeps
        // it simple and filters in-memory. Push down later.
        const result = yield* db.query<[ReadonlyArray<{
            dedupe_sig: string; title: string; form: string; hypothesis: string;
            confidence: string; frequency: number; updated_at: string;
        }>]>(`SELECT dedupe_sig, title, form, hypothesis, confidence, frequency,
                type::string(updated_at) AS updated_at
            FROM proposal WHERE status = 'open';`);
        let rows = result?.[0] ?? [];
        if (input.forms && input.forms.length > 0) {
            const set = new Set(input.forms);
            rows = rows.filter((r) => set.has(r.form));
        }
        if (input.sinceDays != null) {
            const cutoff = Date.now() - input.sinceDays * 86_400_000;
            rows = rows.filter((r) => new Date(r.updated_at).getTime() >= cutoff);
        }
        const ranked: RecommendItem[] = rows
            .map((r) => ({
                shortId: r.dedupe_sig,
                title: r.title,
                form: r.form,
                hypothesis: r.hypothesis,
                confidence: r.confidence,
                frequency: r.frequency,
                updatedAt: r.updated_at,
                score: score(r),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, input.limit);
        return ranked;
    });
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/recommend.test.ts`

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/recommend.ts src/improve/recommend.test.ts
git commit -m "feat(improve): recommend (rank open proposals by conf × recency × freq)"
```

---

## Task 12: Recommend - output formatting + clipboard

**Files:**
- Modify: `src/improve/recommend.ts` (add `formatRecommendations`, `copyToClipboard`)
- Modify: `src/improve/recommend.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/improve/recommend.test.ts`:

```ts
import { formatRecommendations } from "./recommend.ts";

describe("formatRecommendations", () => {
    test("guidance items wrap suggested text in marker pair", () => {
        const items: RecommendItem[] = [{
            shortId: "e7f3", title: "Use ripgrep", form: "guidance",
            hypothesis: "12 corrections", confidence: "high", frequency: 3,
            score: 1, updatedAt: "2026-05-20T00:00:00Z",
        }];
        const out = formatRecommendations(items);
        expect(out).toContain("<!--ax:e7f3-->");
        expect(out).toContain("<!--/ax:e7f3-->");
        expect(out).toContain("Use ripgrep");
    });

    test("skill items show frontmatter sketch instead of marker", () => {
        const items: RecommendItem[] = [{
            shortId: "s1", title: "Pre-Bash guard", form: "skill",
            hypothesis: "Bash failed 7×", confidence: "medium", frequency: 7,
            score: 1, updatedAt: "2026-05-20T00:00:00Z",
        }];
        const out = formatRecommendations(items);
        expect(out).toContain("ax_id: s1");
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/recommend.test.ts -t formatRecommendations`

Expected: FAIL - not exported.

- [ ] **Step 3: Implement**

Append to `src/improve/recommend.ts`:

```ts
const guidanceBlock = (item: RecommendItem): string =>
    `${item.score.toFixed(2)}  ${item.shortId}  [${item.confidence}, ${item.frequency}/wk]  ${item.title}
    evidence: ${item.hypothesis}
    suggested:
        <!--ax:${item.shortId}-->
        ${item.title}
        <!--/ax:${item.shortId}-->
    apply: axctl improve accept ${item.shortId}`;

const skillBlock = (item: RecommendItem): string =>
    `${item.score.toFixed(2)}  ${item.shortId}  [${item.confidence}, ${item.frequency}/wk]  ${item.title}
    evidence: ${item.hypothesis}
    suggested frontmatter:
        ---
        name: ${item.title}
        ax_id: ${item.shortId}
        ---
    apply: axctl improve accept ${item.shortId}`;

export const formatRecommendations = (items: ReadonlyArray<RecommendItem>): string => {
    if (items.length === 0) return "(no recommendations - run `axctl ingest --since=1` first?)";
    return items
        .map((i) => (i.form === "skill" ? skillBlock(i) : guidanceBlock(i)))
        .join("\n\n");
};

const clipboardCmd = (): string[] | null => {
    switch (process.platform) {
        case "darwin": return ["pbcopy"];
        case "linux": return ["xclip", "-selection", "clipboard"];
        default: return null;
    }
};

export const copyToClipboard = (text: string): boolean => {
    const cmd = clipboardCmd();
    if (!cmd) return false;
    try {
        const proc = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(text) });
        return proc.exitCode === 0;
    } catch {
        return false;
    }
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/recommend.test.ts`

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/recommend.ts src/improve/recommend.test.ts
git commit -m "feat(improve): recommend formatting + clipboard copy"
```

---

## Task 13: Wire `axctl improve recommend` CLI command

**Files:**
- Modify: `src/cli/index.ts`
- Create: `src/cli/recommend.test.ts`

- [ ] **Step 1: Write the failing test**

`src/cli/recommend.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("axctl improve recommend", () => {
    test("--help lists filter flags", () => {
        const cli = spawnSync("bun", ["src/cli/index.ts", "improve", "recommend", "--help"], { encoding: "utf-8" });
        const merged = cli.stdout + cli.stderr;
        for (const flag of ["--limit", "--form", "--since", "--json", "--no-clipboard"]) {
            expect(merged).toContain(flag);
        }
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/cli/recommend.test.ts`

Expected: FAIL - subcommand missing.

- [ ] **Step 3: Register the command**

In `src/cli/index.ts`, add (near `improveLintCommand`):

```ts
const recommendLimit = Options.integer("limit").pipe(Options.withDefault(5));
const recommendForm = Options.text("form").pipe(Options.repeated, Options.optional);
const recommendSince = Options.integer("since").pipe(Options.optional);
const recommendJson = Options.boolean("json").pipe(Options.withDefault(false));
const recommendNoClip = Options.boolean("no-clipboard").pipe(Options.withDefault(false));

const improveRecommendCommand = Command.make(
    "recommend",
    {
        limit: recommendLimit,
        forms: recommendForm,
        since: recommendSince,
        json: recommendJson,
        noClip: recommendNoClip,
    },
    ({ limit, forms, since, json, noClip }) =>
        Effect.gen(function* () {
            const formList = forms._tag === "Some" ? forms.value.flatMap((f) => f.split(",")) : undefined;
            const sinceDays = since._tag === "Some" ? since.value : undefined;
            const items = yield* recommend({
                limit,
                ...(formList ? { forms: formList } : {}),
                ...(sinceDays != null ? { sinceDays } : {}),
            });
            if (json) {
                console.log(JSON.stringify(items, null, 2));
                return;
            }
            const formatted = formatRecommendations(items);
            console.log(formatted);
            if (!noClip && items.length > 0) {
                if (copyToClipboard(formatted)) {
                    console.log("\n[copied to clipboard]");
                }
            }
        }),
).pipe(Command.withDescription("Print N ranked proposal recommendations"));
```

Add `improveRecommendCommand` to the `improveCommand.withSubcommands(...)` list.
Add imports: `import { recommend, formatRecommendations, copyToClipboard } from "../improve/recommend.ts";`

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/cli/recommend.test.ts`

Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/recommend.test.ts
git commit -m "feat(cli): axctl improve recommend (filtered, print + clipboard)"
```

---

## Task 14: Recommend `--apply` interactive picker

**Files:**
- Modify: `src/improve/recommend.ts` (add `interactiveApply`)
- Modify: `src/cli/index.ts` (wire `--apply`)

- [ ] **Step 1: Write the failing test**

Append to `src/improve/recommend.test.ts`:

```ts
import { selectByIndices } from "./recommend.ts";

describe("selectByIndices", () => {
    test("returns picked items in input order", () => {
        const items: RecommendItem[] = [
            { shortId: "a", title: "A", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
            { shortId: "b", title: "B", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
            { shortId: "c", title: "C", form: "guidance", hypothesis: "h", confidence: "high", frequency: 1, score: 1, updatedAt: "" },
        ];
        expect(selectByIndices(items, [0, 2]).map((i) => i.shortId)).toEqual(["a", "c"]);
        expect(selectByIndices(items, [99])).toEqual([]);
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/recommend.test.ts -t selectByIndices`

Expected: FAIL - not exported.

- [ ] **Step 3: Implement**

Append to `src/improve/recommend.ts`:

```ts
export const selectByIndices = (
    items: ReadonlyArray<RecommendItem>,
    indices: ReadonlyArray<number>,
): RecommendItem[] => {
    const set = new Set(indices);
    return items.filter((_, i) => set.has(i));
};

export const parseIndexInput = (raw: string, max: number): number[] => {
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    const out = new Set<number>();
    for (const tok of tokens) {
        const m = tok.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) continue;
        const lo = parseInt(m[1]!, 10) - 1;
        const hi = m[2] ? parseInt(m[2], 10) - 1 : lo;
        for (let i = lo; i <= hi && i < max; i += 1) {
            if (i >= 0) out.add(i);
        }
    }
    return [...out].sort((a, b) => a - b);
};
```

- [ ] **Step 4: Wire `--apply` flag**

In `src/cli/index.ts`, extend the `improveRecommendCommand` options with:

```ts
const recommendApply = Options.boolean("apply").pipe(Options.withDefault(false));
```

After printing recommendations, if `apply` is true, prompt:

```ts
if (apply && items.length > 0) {
    process.stdout.write("\nPick indices to accept (e.g. `1 3` or `1-3`): ");
    const input = await new Promise<string>((resolve) => {
        process.stdin.once("data", (b) => resolve(b.toString().trim()));
    });
    const picks = selectByIndices(items, parseIndexInput(input, items.length));
    for (const item of picks) {
        const result = yield* acceptProposal({ sigOrId: item.shortId });
        console.log(`${item.shortId}: ${result.status}${result.task_path ? ` -> ${result.task_path}` : ""}`);
    }
}
```

Add imports: `import { acceptProposal } from "../improve/actions.ts"; import { selectByIndices, parseIndexInput } from "../improve/recommend.ts";`

- [ ] **Step 5: Run all impacted tests**

Run: `bun test src/improve/recommend.test.ts src/cli/recommend.test.ts`

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add src/improve/recommend.ts src/cli/index.ts
git commit -m "feat(cli): axctl improve recommend --apply (pick + accept loop)"
```

---

## Task 15: Show - fetch + render

**Files:**
- Create: `src/improve/show.ts`
- Create: `src/improve/show.test.ts`

- [ ] **Step 1: Write the failing test**

`src/improve/show.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { showExperiment, formatShow } from "./show.ts";
import { SurrealClient } from "../lib/db.ts";

const layerWith = (...fixtures: unknown[][]) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed((fixtures[i++] ?? []) as unknown as T),
    } as never);
};

describe("showExperiment", () => {
    test("returns null when nothing matches", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "missing" })
                .pipe(Effect.provide(layerWith([], [], []))),
        );
        expect(out).toBeNull();
    });

    test("returns proposal + experiment + checkpoints when found", async () => {
        const out = await Effect.runPromise(
            showExperiment({ sigOrId: "e7f3" })
                .pipe(Effect.provide(layerWith(
                    [{ dedupe_sig: "e7f3", title: "T", form: "guidance", hypothesis: "h",
                        status: "accepted", confidence: "high", frequency: 3,
                        updated_at: "2026-05-20T00:00:00Z" }],
                    [{ id: "experiment:abc", status: "scaffolded",
                        artifact_path: "/x/CLAUDE.md", task_path: null, locked_verdict: null }],
                    [{ kind: "early", observed_at: "2026-05-25T00:00:00Z",
                        measured: { ratio: 0.5 }, suggested: "adopted", user_verdict: null }],
                ))),
        );
        expect(out?.proposal.shortId).toBe("e7f3");
        expect(out?.experiment?.id).toBe("experiment:abc");
        expect(out?.checkpoints).toHaveLength(1);
    });

    test("formatShow renders all sections", () => {
        const out = formatShow({
            proposal: {
                shortId: "e7f3", title: "T", form: "guidance", hypothesis: "h",
                status: "accepted", confidence: "high", frequency: 3,
                updatedAt: "2026-05-20T00:00:00Z",
            },
            experiment: {
                id: "experiment:abc", status: "scaffolded",
                artifactPath: "/x/CLAUDE.md", taskPath: null, lockedVerdict: null,
            },
            checkpoints: [],
        });
        expect(out).toContain("e7f3");
        expect(out).toContain("scaffolded");
        expect(out).toContain("CLAUDE.md");
    });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test src/improve/show.test.ts`

Expected: FAIL - module missing.

- [ ] **Step 3: Implement**

`src/improve/show.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { surrealLiteral } from "../lib/json.ts";
import type { DbError } from "../lib/errors.ts";

export interface ShowInput { readonly sigOrId: string; }

export interface ShowProposal {
    readonly shortId: string;
    readonly title: string;
    readonly form: string;
    readonly hypothesis: string;
    readonly status: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly updatedAt: string;
}

export interface ShowExperiment {
    readonly id: string;
    readonly status: string;
    readonly artifactPath: string | null;
    readonly taskPath: string | null;
    readonly lockedVerdict: string | null;
}

export interface ShowCheckpoint {
    readonly kind: string;
    readonly observedAt: string;
    readonly measured: Record<string, unknown>;
    readonly suggested: string | null;
    readonly userVerdict: string | null;
}

export interface ShowResult {
    readonly proposal: ShowProposal;
    readonly experiment: ShowExperiment | null;
    readonly checkpoints: ShowCheckpoint[];
}

export const showExperiment = (
    input: ShowInput,
): Effect.Effect<ShowResult | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const idLit = surrealLiteral(input.sigOrId);
        const db = yield* SurrealClient;
        const pRows = yield* db.query<[ReadonlyArray<{
            dedupe_sig: string; title: string; form: string; hypothesis: string;
            status: string; confidence: string; frequency: number; updated_at: string;
        }>]>(`SELECT dedupe_sig, title, form, hypothesis, status, confidence, frequency,
                type::string(updated_at) AS updated_at
            FROM proposal WHERE dedupe_sig = ${idLit} OR id = ${idLit} LIMIT 1;`);
        const prow = (pRows?.[0] ?? [])[0];
        if (!prow) return null;
        const proposal: ShowProposal = {
            shortId: prow.dedupe_sig, title: prow.title, form: prow.form,
            hypothesis: prow.hypothesis, status: prow.status,
            confidence: prow.confidence, frequency: prow.frequency,
            updatedAt: prow.updated_at,
        };
        const eRows = yield* db.query<[ReadonlyArray<{
            id: string; status: string; artifact_path: string | null;
            task_path: string | null; locked_verdict: string | null;
        }>]>(`SELECT type::string(id) AS id, status, artifact_path, task_path, locked_verdict
            FROM experiment WHERE proposal.dedupe_sig = ${idLit} LIMIT 1;`);
        const erow = (eRows?.[0] ?? [])[0];
        const experiment: ShowExperiment | null = erow ? {
            id: erow.id, status: erow.status,
            artifactPath: erow.artifact_path, taskPath: erow.task_path,
            lockedVerdict: erow.locked_verdict,
        } : null;
        const cRows = experiment ? yield* db.query<[ReadonlyArray<{
            kind: string; observed_at: string; measured: Record<string, unknown>;
            suggested: string | null; user_verdict: string | null;
        }>]>(`SELECT kind, type::string(observed_at) AS observed_at, measured, suggested, user_verdict
            FROM checkpoint WHERE experiment = ${experiment.id}
            ORDER BY observed_at DESC LIMIT 10;`) : null;
        const checkpoints: ShowCheckpoint[] = (cRows?.[0] ?? []).map((r) => ({
            kind: r.kind, observedAt: r.observed_at, measured: r.measured,
            suggested: r.suggested, userVerdict: r.user_verdict,
        }));
        return { proposal, experiment, checkpoints };
    });

export const formatShow = (r: ShowResult): string => {
    const lines: string[] = [];
    lines.push(`# ${r.proposal.shortId}  ${r.proposal.title}`);
    lines.push(`form=${r.proposal.form}  status=${r.proposal.status}  conf=${r.proposal.confidence}  freq=${r.proposal.frequency}/wk`);
    lines.push(`updated ${r.proposal.updatedAt}`);
    lines.push("");
    lines.push("## Evidence");
    lines.push(r.proposal.hypothesis);
    if (r.experiment) {
        lines.push("");
        lines.push("## Experiment");
        lines.push(`id=${r.experiment.id}  status=${r.experiment.status}`);
        if (r.experiment.artifactPath) lines.push(`artifact: ${r.experiment.artifactPath}`);
        if (r.experiment.taskPath) lines.push(`pending task: ${r.experiment.taskPath}`);
        if (r.experiment.lockedVerdict) lines.push(`locked verdict: ${r.experiment.lockedVerdict}`);
    }
    if (r.checkpoints.length > 0) {
        lines.push("");
        lines.push("## Checkpoints");
        for (const c of r.checkpoints) {
            lines.push(`- ${c.observedAt}  kind=${c.kind}  suggested=${c.suggested ?? "-"}  user=${c.userVerdict ?? "-"}`);
        }
    }
    return lines.join("\n");
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test src/improve/show.test.ts`

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/improve/show.ts src/improve/show.test.ts
git commit -m "feat(improve): showExperiment + formatShow (proposal+experiment+checkpoints)"
```

---

## Task 16: Extend `axctl improve show` CLI to use the new renderer

**Files:**
- Modify: `src/cli/index.ts` (the `improveShowCommand` block near line 1816)

- [ ] **Step 1: Locate the existing command**

Run: `rg -n "const improveShowCommand" src/cli/index.ts`

The existing handler likely prints proposal-only data. Replace its body with a call to `showExperiment` + `formatShow`.

- [ ] **Step 2: Rewrite the handler**

```ts
const improveShowCommand = Command.make(
    "show",
    { id: Args.text({ name: "id" }) },
    ({ id }) =>
        Effect.gen(function* () {
            const result = yield* showExperiment({ sigOrId: id });
            if (!result) {
                console.error(`no proposal matched ${id}`);
                yield* Effect.fail(new Error("not_found") as never);
                return;
            }
            console.log(formatShow(result));
        }),
).pipe(Command.withDescription("Show experiment evidence + status for one proposal id"));
```

Add: `import { showExperiment, formatShow } from "../improve/show.ts";`

- [ ] **Step 3: Manual smoke**

Run:

```bash
bun src/cli/index.ts improve show --help
```

Confirm description matches.

- [ ] **Step 4: Run the full suite to confirm nothing regressed**

Run: `bun test src/improve src/cli`

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): improve show uses showExperiment for full context"
```

---

## Task 17: Dashboard read-only surface

**Files:**
- Modify: `src/dashboard/server.ts` (extend the existing `/api/improve/...` endpoints to include `status` + `task_path`)
- Modify: `src/dashboard/web/src/Shell.tsx` or wherever `/improve` is rendered (add `Status` column displaying `task_emitted` / `scaffolded` / `regressed`)

- [ ] **Step 1: Identify the existing endpoint**

Run: `rg -n "/api/improve|/improve" src/dashboard/server.ts`

- [ ] **Step 2: Extend the SQL projection**

Wherever the dashboard fetches experiments today, ensure the SELECT now includes `status`, `task_path`. Example:

```ts
const result = await db.query<[Row[]]>(`
    SELECT
        type::string(id) AS id,
        proposal.dedupe_sig AS short_id,
        status,
        artifact_path,
        task_path,
        locked_verdict
    FROM experiment ORDER BY scaffolded_at DESC LIMIT 50;
`);
```

Pass the new fields through the API shape.

- [ ] **Step 3: Render in the React shell**

In `src/dashboard/web/src/Shell.tsx` (or the `/improve` route component), add a column or badge per experiment row showing `status`. If `status === 'task_emitted' && task_path`, render the path as plain text (clickable copy if cheap). Keep the change minimal - v0 surface only.

- [ ] **Step 4: Smoke**

Run:

```bash
bun run dev # or however the dashboard is launched in this repo
```

Hit `/improve`. Confirm the new column appears and rows that came from `axctl improve accept` show `task_emitted` until lint reconciles them.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts src/dashboard/web/src/Shell.tsx
git commit -m "feat(dashboard): surface experiment.status + task_path on /improve"
```

---

## Task 18: End-to-end test

**Files:**
- Create: `src/improve/grounded-files.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient } from "../lib/db.ts";
import { acceptProposal } from "./actions.ts";
import { lintFiles } from "./lint.ts";

const requireLiveDb = () => {
    if (process.env.AX_E2E_DB !== "1") return null;
    return SurrealClient; // assumes the configured layer hits 127.0.0.1:8521
};

describe("grounded files E2E", () => {
    test("derive → accept → mark → lint reconciles", async () => {
        const dbLayer = requireLiveDb();
        if (!dbLayer) {
            console.log("(skipped - set AX_E2E_DB=1 with a live SurrealDB to run)");
            expect(true).toBe(true);
            return;
        }

        // Seed: insert a proposal + guidance payload + matching experiment shell
        // (Implementation note: reuse the helpers from existing E2E tests under
        // src/ingest/*.e2e.test.ts to set up + tear down.)
        // ... seed code here ...

        // 1. Accept emits a task file
        const root = mkdtempSync(join(tmpdir(), "ax-e2e-"));
        const taskDir = join(root, ".ax", "tasks");
        const acceptResult = await Effect.runPromise(
            acceptProposal({ sigOrId: "e2e-sig-1", taskDir }) /* .pipe(Effect.provide(LiveLayer)) */,
        );
        expect(acceptResult.status).toBe("ok");
        expect(existsSync(acceptResult.task_path!)).toBe(true);

        // 2. Simulate user's agent applying the marker
        const targetFile = join(root, "CLAUDE.md");
        writeFileSync(targetFile, "<!--ax:e2e-sig-1-->Use ripgrep.<!--/ax:e2e-sig-1-->");

        // 3. Lint reconciles
        const report = await Effect.runPromise(
            lintFiles({ roots: [root] }) /* .pipe(Effect.provide(LiveLayer)) */,
        );
        expect(report.reconciled.some((r) => r.shortId === "e2e-sig-1")).toBe(true);
        expect(existsSync(acceptResult.task_path!)).toBe(false);
    });
});
```

- [ ] **Step 2: Set up the live-DB layer**

Inside the test file, build the real `SurrealClient` layer the same way `src/ingest/*.e2e.test.ts` does (look at the existing E2E suite for the pattern). Provide it inside the `Effect.runPromise(...)` calls.

- [ ] **Step 3: Run the gated test**

Run:

```bash
AX_E2E_DB=1 bun test src/improve/grounded-files.e2e.test.ts
```

Expected: PASS against a live SurrealDB. Without the env var, the test logs "skipped" and passes trivially so CI doesn't require the DB.

- [ ] **Step 4: Commit**

```bash
git add src/improve/grounded-files.e2e.test.ts
git commit -m "test(improve): grounded files E2E (accept → marker → lint)"
```

---

## Task 19: Documentation + README pointer

**Files:**
- Modify: `README.md` (add a "Grounded agent files" section)
- Modify: `CLAUDE.md` (note the new `improve recommend` / `improve lint` commands so future Claude sessions know they exist)

- [ ] **Step 1: Append a section to `README.md`**

Under the existing command-reference area, add:

```md
### Grounded agent files

ax can recommend changes to your `AGENTS.md` / `CLAUDE.md` (and skill files)
and track which lines came from it.

- `axctl improve recommend` - print N ranked proposals as ready-to-paste blocks
  (already wrapped in `<!--ax:id-->` provenance markers). Use `--apply` to pick
  and accept inline.
- `axctl improve accept <id>` - emit a `.ax/tasks/<id>.md` brief. Hand it to
  your primary agent (Claude Code, Codex, etc.); the agent edits the target
  file, leaving the marker in place.
- `axctl improve lint` - scan your agent files, reconcile markers with the
  DB, remove consumed task files, warn on orphans or stale tasks.
- `axctl improve show <id>` - full evidence trail for one proposal.
```

- [ ] **Step 2: Append a line to `CLAUDE.md`**

Under the existing "Open issues" or a new "Commands" section:

```md
## Recommend + apply guidance to your own agent files

`axctl improve recommend / accept / lint / show` ship the v0 grounded-files
loop. `accept` emits a `.ax/tasks/<id>.md` brief; act on it like any other
task file, then run `axctl improve lint` to reconcile.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: point at axctl improve recommend / lint (grounded files v0)"
```

---

## Self-review checklist (run before declaring complete)

- [ ] `bun test` passes across the whole repo (no regressions in `src/ingest/`, `src/self-improve/`, etc.).
- [ ] `bun src/cli/index.ts improve --help` lists `recommend`, `accept`, `reject`, `lint`, `show`, `verdict`, `list`, `reset`, `checkpoint`.
- [ ] `.ax/tasks/<id>.md` shows up after `axctl improve accept` against a seeded `open` proposal.
- [ ] After hand-applying a marker, `axctl improve lint` deletes the task file and the experiment row's status flips to `scaffolded`.
- [ ] Re-running `axctl improve lint` on the same file is a no-op (idempotent).
- [ ] `axctl improve recommend --json` is machine-readable.
- [ ] Dashboard `/improve` shows the new `status` column.
- [ ] Spec (`docs/superpowers/specs/2026-05-27-grounded-agent-files-design.md`) requirements covered:
    - inline marker convention (paired HTML comments) - Task 2
    - skill frontmatter `ax_id` - Task 3
    - task envelope - Task 4 + 5
    - `axctl improve recommend` - Tasks 11–13
    - `axctl improve accept` (universal + `--auto-scaffold`) - Tasks 5–6
    - `axctl improve lint` - Tasks 7–10
    - `axctl improve show` - Tasks 15–16
    - `experiment.status`, `experiment.task_path` - Task 1
    - dashboard read-only surface - Task 17
    - E2E - Task 18

If any of these fail, fix in place; do not declare done.
