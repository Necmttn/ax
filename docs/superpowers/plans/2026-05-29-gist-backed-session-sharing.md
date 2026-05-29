# Gist-Backed Session Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `axctl share <session-id>` so users can publish a sanitized session artifact to GitHub Gist and share it through `ax.necmttn.com/s/<owner>/<gist-id>`.

**Architecture:** The local CLI owns export, redaction, preview, and Gist publishing. The site owns rendering only: it fetches `ax-session.json` from GitHub Gist and displays a stable public session view. The share artifact is a versioned DTO, separate from SurrealDB rows and dashboard wire types.

**Tech Stack:** Bun, TypeScript, Effect 4 beta, SurrealDB query helpers, TanStack Router/React Start site, GitHub CLI (`gh`) for V1 publishing.

---

## File Structure

- Create `src/share/artifact.ts`: share DTO types, schema-version constant, fixture helpers.
- Create `src/share/redact.ts`: deterministic redaction rules and report.
- Create `src/share/exporter.ts`: maps existing session detail plus new query rows into `AxSessionShare`.
- Create `src/share/gist.ts`: wraps `gh gist create` and parses the resulting Gist URL.
- Create `src/share/format.ts`: CLI preview and success formatting.
- Create tests beside each module: `src/share/*.test.ts`.
- Modify `src/queries/session-detail.ts`: add bounded timeline and file queries for share export.
- Modify `src/dashboard/session-detail.ts`: fetch the new query rows for exporter reuse only if a shared helper is useful. Prefer keeping dashboard payload stable unless necessary.
- Modify `src/cli/index.ts`: register `axctl share <session-id>`.
- Create `site/app/lib/session-share.ts`: browser/server-safe artifact validation and Gist URL helpers.
- Create `site/app/routes/s.$owner.$gistId.tsx`: public share renderer route.
- Create `site/app/routes/s.$owner.$gistId.test.tsx` or `site/app/lib/session-share.test.ts`: renderer helper tests. If route-component tests are awkward in this repo, test the loader/helper layer and keep component rendering simple.

## Scope Boundaries

- V1 creates new Gists only. It does not update existing Gists.
- V1 defaults to secret/unlisted Gists. `--public` is explicit opt-in.
- V1 does not include raw full transcript text.
- V1 can render a static graph preview. No force graph or canvas dependency.
- V1 uses `gh gist create`; GitHub API fallback is deferred unless implementation discovers `gh` cannot support required behavior.

---

### Task 1: Share Artifact Types

**Files:**
- Create: `src/share/artifact.ts`
- Test: `src/share/artifact.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import {
    AX_SESSION_SHARE_SCHEMA_VERSION,
    isAxSessionShare,
    minimalShareArtifact,
} from "./artifact.ts";

describe("share artifact", () => {
    it("recognizes the minimal V1 artifact", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });

        expect(artifact.schema_version).toBe(AX_SESSION_SHARE_SCHEMA_VERSION);
        expect(isAxSessionShare(artifact)).toBe(true);
    });

    it("rejects unsupported schema versions", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });

        expect(isAxSessionShare({ ...artifact, schema_version: 999 })).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/share/artifact.test.ts
```

Expected: FAIL because `src/share/artifact.ts` does not exist.

- [ ] **Step 3: Implement artifact types and guard**

```ts
export const AX_SESSION_SHARE_SCHEMA_VERSION = 1 as const;

export type ShareSource = "claude" | "codex" | "pi" | "opencode" | "cursor" | string;

export interface AxSessionShare {
    readonly schema_version: typeof AX_SESSION_SHARE_SCHEMA_VERSION;
    readonly exported_at: string;
    readonly ax_version: string;
    readonly session: {
        readonly id: string;
        readonly source: ShareSource;
        readonly model?: string;
        readonly project?: string;
        readonly repository?: string;
        readonly started_at?: string;
        readonly ended_at?: string;
        readonly summary?: string;
    };
    readonly stats: {
        readonly turns: number;
        readonly tool_calls: number;
        readonly files_changed: number;
        readonly skills_used: number;
        readonly failures: number;
    };
    readonly timeline: ReadonlyArray<ShareEvent>;
    readonly files: ReadonlyArray<ShareFile>;
    readonly graph: ShareGraph;
    readonly derived: {
        readonly working_style?: ReadonlyArray<string>;
        readonly decisions?: ReadonlyArray<string>;
        readonly call_graphs?: ReadonlyArray<{ readonly label: string; readonly body: string }>;
        readonly outcome?: string;
    };
    readonly redactions: {
        readonly applied: boolean;
        readonly rules: ReadonlyArray<string>;
    };
}

export interface ShareEvent {
    readonly id: string;
    readonly ts?: string;
    readonly kind:
        | "message"
        | "tool_call"
        | "file_edit"
        | "skill_invocation"
        | "decision"
        | "checkpoint"
        | "failure"
        | "outcome";
    readonly actor?: string;
    readonly title: string;
    readonly summary?: string;
    readonly refs?: ReadonlyArray<{ readonly type: "file" | "tool" | "skill" | "turn"; readonly id: string }>;
}

export interface ShareFile {
    readonly path: string;
    readonly lang?: string;
    readonly role?: "read" | "edited" | "touched";
    readonly additions?: number;
    readonly deletions?: number;
}

export interface ShareGraph {
    readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly kind: "session" | "actor" | "tool" | "skill" | "file" | "decision" | "artifact";
        readonly label: string;
    }>;
    readonly edges: ReadonlyArray<{
        readonly from: string;
        readonly to: string;
        readonly label: string;
    }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

export function isAxSessionShare(value: unknown): value is AxSessionShare {
    if (!isRecord(value)) return false;
    if (value.schema_version !== AX_SESSION_SHARE_SCHEMA_VERSION) return false;
    if (!isRecord(value.session)) return false;
    if (typeof value.session.id !== "string") return false;
    if (typeof value.session.source !== "string") return false;
    if (!isRecord(value.stats)) return false;
    return Array.isArray(value.timeline) && Array.isArray(value.files) && isRecord(value.graph);
}

export function minimalShareArtifact(input: {
    readonly id: string;
    readonly source: ShareSource;
    readonly exported_at?: string;
    readonly ax_version?: string;
}): AxSessionShare {
    return {
        schema_version: AX_SESSION_SHARE_SCHEMA_VERSION,
        exported_at: input.exported_at ?? "2026-05-29T00:00:00.000Z",
        ax_version: input.ax_version ?? "0.0.0-test",
        session: {
            id: input.id,
            source: input.source,
        },
        stats: {
            turns: 0,
            tool_calls: 0,
            files_changed: 0,
            skills_used: 0,
            failures: 0,
        },
        timeline: [],
        files: [],
        graph: {
            nodes: [],
            edges: [],
        },
        derived: {},
        redactions: {
            applied: false,
            rules: [],
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/share/artifact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/share/artifact.ts src/share/artifact.test.ts
git commit -m "feat: define session share artifact"
```

---

### Task 2: Redaction Module

**Files:**
- Create: `src/share/redact.ts`
- Test: `src/share/redact.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { redactShareText, redactShareArtifact } from "./redact.ts";
import { minimalShareArtifact } from "./artifact.ts";

describe("share redaction", () => {
    it("redacts common secrets and home paths", () => {
        const result = redactShareText(
            "OPENAI_API_KEY=sk-test123 /Users/necmttn/Projects/ax Authorization: Bearer abc.def",
        );

        expect(result.text).toContain("[REDACTED_SECRET]");
        expect(result.text).toContain("~/Projects/ax");
        expect(result.rules).toContain("openai-api-key");
        expect(result.rules).toContain("home-path");
        expect(result.rules).toContain("authorization-bearer");
    });

    it("redacts string fields inside share artifacts", () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "codex" });
        const redacted = redactShareArtifact({
            ...artifact,
            session: {
                ...artifact.session,
                project: "/Users/necmttn/Projects/ax",
                summary: "Authorization: Bearer secret-token",
            },
        });

        expect(redacted.artifact.session.project).toBe("~/Projects/ax");
        expect(redacted.artifact.session.summary).toBe("Authorization: Bearer [REDACTED_SECRET]");
        expect(redacted.artifact.redactions.applied).toBe(true);
        expect(redacted.artifact.redactions.rules).toContain("authorization-bearer");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/share/redact.test.ts
```

Expected: FAIL because `redact.ts` does not exist.

- [ ] **Step 3: Implement deterministic redaction**

```ts
import { homedir } from "node:os";
import type { AxSessionShare } from "./artifact.ts";

export interface RedactionResult {
    readonly text: string;
    readonly rules: ReadonlyArray<string>;
}

const SECRET_RULES: ReadonlyArray<{
    readonly name: string;
    readonly pattern: RegExp;
    readonly replace: string;
}> = [
    {
        name: "openai-api-key",
        pattern: /\b(sk-[A-Za-z0-9_-]{6,})\b/g,
        replace: "[REDACTED_SECRET]",
    },
    {
        name: "authorization-bearer",
        pattern: /(Authorization:\s*Bearer\s+)[^\s"'`]+/gi,
        replace: "$1[REDACTED_SECRET]",
    },
    {
        name: "env-secret-assignment",
        pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=)[^\s"'`]+/g,
        replace: "$1[REDACTED_SECRET]",
    },
];

export function redactShareText(input: string): RedactionResult {
    let text = input;
    const rules = new Set<string>();

    const home = homedir();
    if (home && text.includes(home)) {
        text = text.split(home).join("~");
        rules.add("home-path");
    }

    for (const rule of SECRET_RULES) {
        const next = text.replace(rule.pattern, rule.replace);
        if (next !== text) rules.add(rule.name);
        text = next;
    }

    return { text, rules: [...rules].sort() };
}

function redactUnknown(value: unknown, rules: Set<string>): unknown {
    if (typeof value === "string") {
        const result = redactShareText(value);
        for (const rule of result.rules) rules.add(rule);
        return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => redactUnknown(item, rules));
    if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) out[key] = redactUnknown(child, rules);
        return out;
    }
    return value;
}

export function redactShareArtifact(artifact: AxSessionShare): {
    readonly artifact: AxSessionShare;
    readonly rules: ReadonlyArray<string>;
} {
    const rules = new Set<string>();
    const redacted = redactUnknown(artifact, rules) as AxSessionShare;
    const mergedRules = [...new Set([...artifact.redactions.rules, ...rules])].sort();
    return {
        artifact: {
            ...redacted,
            redactions: {
                applied: mergedRules.length > 0,
                rules: mergedRules,
            },
        },
        rules: mergedRules,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/share/redact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/share/redact.ts src/share/redact.test.ts
git commit -m "feat: redact session share artifacts"
```

---

### Task 3: Share Export Queries

**Files:**
- Modify: `src/queries/session-detail.ts`
- Test: `src/queries/session-detail.test.ts` or create `src/share/exporter.test.ts` with mocked rows if existing query tests are not SQL-focused.

- [ ] **Step 1: Write the failing SQL mapping tests**

Add tests that exercise row mappers for share timeline and files. If `src/queries/session-detail.test.ts` already has query mapper patterns, follow them. Otherwise create a focused test:

```ts
import { describe, expect, it } from "bun:test";
import {
    sessionShareFilesQuery,
    sessionShareTimelineQuery,
} from "../queries/session-detail.ts";

describe("session share query mappers", () => {
    it("maps tool call rows into share timeline rows", () => {
        const mapped = sessionShareTimelineQuery.mapRowForTest({
            id: "tool_call:abc",
            ts: "2026-05-29T00:00:00.000Z",
            kind: "tool_call",
            title: "exec_command",
            summary: "bun test",
        });

        expect(mapped).toEqual({
            id: "tool_call:abc",
            ts: "2026-05-29T00:00:00.000Z",
            kind: "tool_call",
            actor: "agent",
            title: "exec_command",
            summary: "bun test",
        });
    });

    it("maps edited file rows into share files", () => {
        const mapped = sessionShareFilesQuery.mapRowForTest({
            path: "src/share/exporter.ts",
            role: "edited",
            lang: "ts",
            additions: 12,
            deletions: 3,
        });

        expect(mapped).toEqual({
            path: "src/share/exporter.ts",
            role: "edited",
            lang: "ts",
            additions: 12,
            deletions: 3,
        });
    });
});
```

If `defineQuery` does not expose `mapRowForTest`, export pure mapper functions instead:

```ts
export const mapSessionShareTimelineRow = (raw: Record<string, unknown>): ShareEvent | null => { ... };
export const mapSessionShareFileRow = (raw: Record<string, unknown>): ShareFile | null => { ... };
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/queries/session-detail.test.ts src/share/exporter.test.ts
```

Expected: FAIL because share query exports do not exist.

- [ ] **Step 3: Add query DTOs and mappers**

Add imports:

```ts
import type { ShareEvent, ShareFile } from "../share/artifact.ts";
```

Add SQL and mappers:

```ts
export const SESSION_SHARE_TIMELINE_SQL = `
SELECT
    id,
    ts,
    "tool_call" AS kind,
    (command_norm ?? name) AS title,
    output_excerpt AS summary
FROM tool_call
WHERE session = $sessionId
ORDER BY ts ASC
LIMIT 200;`;

export const SESSION_SHARE_FILES_SQL = `
SELECT
    out.path AS path,
    out.lang AS lang,
    "edited" AS role,
    additions,
    deletions
FROM edited
WHERE in.session = $sessionId
ORDER BY ts ASC
LIMIT 200;`;

export const mapSessionShareTimelineRow = (raw: Record<string, unknown>): ShareEvent | null => {
    const id = recordIdString(raw.id) ?? stringField(raw, "id");
    const title = stringField(raw, "title");
    if (!id || !title) return null;
    return {
        id,
        ts: dateField(raw, "ts") ?? undefined,
        kind: "tool_call",
        actor: "agent",
        title,
        summary: stringField(raw, "summary") ?? undefined,
    };
};

export const mapSessionShareFileRow = (raw: Record<string, unknown>): ShareFile | null => {
    const path = stringField(raw, "path");
    if (!path) return null;
    return {
        path,
        lang: stringField(raw, "lang") ?? undefined,
        role: "edited",
        additions: numericField(raw, "additions"),
        deletions: numericField(raw, "deletions"),
    };
};

export const sessionShareTimelineQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareEvent | null
>({
    name: "session-detail.share-timeline",
    sql: (p) => subst(SESSION_SHARE_TIMELINE_SQL, p.recordRef),
    mapRow: (raw) => isRecord(raw) ? mapSessionShareTimelineRow(raw) : null,
});

export const sessionShareFilesQuery = defineQuery<
    SessionDetailParams,
    Record<string, unknown>,
    ShareFile | null
>({
    name: "session-detail.share-files",
    sql: (p) => subst(SESSION_SHARE_FILES_SQL, p.recordRef),
    mapRow: (raw) => isRecord(raw) ? mapSessionShareFileRow(raw) : null,
});
```

Adjust field names if the actual `edited` relation stores path evidence differently. Keep the mapper tests aligned with the real row shape.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test src/queries/session-detail.test.ts src/share/exporter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/queries/session-detail.ts src/queries/session-detail.test.ts src/share/exporter.test.ts
git commit -m "feat: add session share query rows"
```

---

### Task 4: Session Share Exporter

**Files:**
- Create: `src/share/exporter.ts`
- Test: `src/share/exporter.test.ts`
- Modify only if needed: `src/dashboard/session-detail.ts`

- [ ] **Step 1: Write the failing exporter test**

```ts
import { describe, expect, it } from "bun:test";
import { buildShareArtifactFromParts } from "./exporter.ts";

describe("buildShareArtifactFromParts", () => {
    it("builds a V1 artifact from session rows", () => {
        const artifact = buildShareArtifactFromParts({
            axVersion: "0.2.0",
            exportedAt: "2026-05-29T00:00:00.000Z",
            overview: {
                id: "abc123",
                project: "ax",
                cwd: "/Users/necmttn/Projects/ax",
                model: "gpt-5",
                source: "codex",
                started_at: "2026-05-29T00:00:00.000Z",
                ended_at: "2026-05-29T00:10:00.000Z",
            },
            topSkills: [{ skill: "superpowers:writing-plans", count: 1, last_used: "2026-05-29T00:01:00.000Z" }],
            toolCalls: [{ label: "exec_command", count: 2, failures: 1, last_used: "2026-05-29T00:02:00.000Z" }],
            timeline: [{ id: "tool_call:abc", kind: "tool_call", title: "exec_command", actor: "agent" }],
            files: [{ path: "src/share/exporter.ts", role: "edited" }],
        });

        expect(artifact.session.id).toBe("abc123");
        expect(artifact.stats.tool_calls).toBe(2);
        expect(artifact.stats.skills_used).toBe(1);
        expect(artifact.stats.failures).toBe(1);
        expect(artifact.files).toHaveLength(1);
        expect(artifact.graph.nodes.some((n) => n.id === "session:abc123")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/share/exporter.test.ts
```

Expected: FAIL because exporter does not exist.

- [ ] **Step 3: Implement pure artifact builder**

```ts
import type {
    AxSessionShare,
    ShareEvent,
    ShareFile,
    ShareGraph,
} from "./artifact.ts";
import { AX_SESSION_SHARE_SCHEMA_VERSION } from "./artifact.ts";
import type {
    SessionOverview,
    SessionToolCall,
    SessionTopSkill,
} from "../lib/shared/dashboard-types.ts";

export interface ShareArtifactParts {
    readonly axVersion: string;
    readonly exportedAt: string;
    readonly overview: SessionOverview;
    readonly topSkills: ReadonlyArray<SessionTopSkill>;
    readonly toolCalls: ReadonlyArray<SessionToolCall>;
    readonly timeline: ReadonlyArray<ShareEvent>;
    readonly files: ReadonlyArray<ShareFile>;
}

const compact = <T>(items: ReadonlyArray<T | null | undefined>): T[] =>
    items.filter((item): item is T => item !== null && item !== undefined);

function buildGraph(parts: ShareArtifactParts): ShareGraph {
    const sessionId = `session:${parts.overview.id}`;
    return {
        nodes: compact([
            { id: sessionId, kind: "session" as const, label: parts.overview.project ?? parts.overview.id },
            ...parts.topSkills.map((s) => ({ id: `skill:${s.skill}`, kind: "skill" as const, label: s.skill })),
            ...parts.toolCalls.map((t) => ({ id: `tool:${t.label}`, kind: "tool" as const, label: t.label })),
            ...parts.files.map((f) => ({ id: `file:${f.path}`, kind: "file" as const, label: f.path })),
        ]),
        edges: [
            ...parts.topSkills.map((s) => ({ from: sessionId, to: `skill:${s.skill}`, label: "used" })),
            ...parts.toolCalls.map((t) => ({ from: sessionId, to: `tool:${t.label}`, label: "called" })),
            ...parts.files.map((f) => ({ from: sessionId, to: `file:${f.path}`, label: f.role ?? "referenced" })),
        ],
    };
}

export function buildShareArtifactFromParts(parts: ShareArtifactParts): AxSessionShare {
    return {
        schema_version: AX_SESSION_SHARE_SCHEMA_VERSION,
        exported_at: parts.exportedAt,
        ax_version: parts.axVersion,
        session: {
            id: parts.overview.id,
            source: parts.overview.source,
            model: parts.overview.model ?? undefined,
            project: parts.overview.project ?? undefined,
            started_at: parts.overview.started_at ?? undefined,
            ended_at: parts.overview.ended_at ?? undefined,
        },
        stats: {
            turns: parts.timeline.length,
            tool_calls: parts.toolCalls.reduce((sum, t) => sum + t.count, 0),
            files_changed: parts.files.length,
            skills_used: parts.topSkills.length,
            failures: parts.toolCalls.reduce((sum, t) => sum + t.failures, 0),
        },
        timeline: parts.timeline,
        files: parts.files,
        graph: buildGraph(parts),
        derived: {
            working_style: parts.topSkills.length > 0
                ? [`Used ${parts.topSkills.length} skill${parts.topSkills.length === 1 ? "" : "s"} during the session.`]
                : undefined,
        },
        redactions: {
            applied: false,
            rules: [],
        },
    };
}
```

- [ ] **Step 4: Add Effect wrapper for DB export**

In `src/share/exporter.ts`, add:

```ts
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { runQuery, runSingleQuery } from "../lib/shared/graph-query.ts";
import {
    sessionOverviewQuery,
    sessionShareFilesQuery,
    sessionShareTimelineQuery,
    sessionToolCallsQuery,
    sessionTopSkillsQuery,
} from "../queries/session-detail.ts";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

export const normalizeSessionRecordRef = (sessionId: string): string | null => {
    const bare = sessionId
        .replace(/^session:⟨/, "")
        .replace(/⟩$/, "")
        .replace(/^session:/, "");
    return SESSION_ID_RE.test(bare) ? `session:⟨${bare}⟩` : null;
};

export const exportSessionShare = (
    sessionId: string,
    axVersion: string,
): Effect.Effect<AxSessionShare | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const recordRef = normalizeSessionRecordRef(sessionId);
        if (!recordRef) return null;
        const params = { recordRef };
        const [overview, topSkillsRaw, toolCallsRaw, timelineRaw, filesRaw] = yield* Effect.all([
            runSingleQuery(sessionOverviewQuery, params),
            runQuery(sessionTopSkillsQuery, params),
            runQuery(sessionToolCallsQuery, params),
            runQuery(sessionShareTimelineQuery, params),
            runQuery(sessionShareFilesQuery, params),
        ]);
        if (!overview) return null;
        return buildShareArtifactFromParts({
            axVersion,
            exportedAt: new Date().toISOString(),
            overview,
            topSkills: topSkillsRaw.filter((s) => s !== null),
            toolCalls: toolCallsRaw.filter((t) => t !== null),
            timeline: timelineRaw.filter((e) => e !== null),
            files: filesRaw.filter((f) => f !== null),
        });
    });
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test src/share/exporter.test.ts src/queries/session-detail.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/share/exporter.ts src/share/exporter.test.ts src/queries/session-detail.ts src/queries/session-detail.test.ts
git commit -m "feat: export sessions as share artifacts"
```

---

### Task 5: Gist Publisher And CLI Formatting

**Files:**
- Create: `src/share/gist.ts`
- Create: `src/share/format.ts`
- Test: `src/share/gist.test.ts`
- Test: `src/share/format.test.ts`

- [ ] **Step 1: Write failing Gist parser test**

```ts
import { describe, expect, it } from "bun:test";
import { parseGistCreateOutput, shareUrlForGist } from "./gist.ts";

describe("gist helpers", () => {
    it("parses owner and gist id from gh output", () => {
        const parsed = parseGistCreateOutput("https://gist.github.com/necmttn/abc123def456\n");
        expect(parsed).toEqual({ owner: "necmttn", gistId: "abc123def456" });
    });

    it("builds canonical ax share URLs", () => {
        expect(shareUrlForGist({ owner: "necmttn", gistId: "abc123" })).toBe(
            "https://ax.necmttn.com/s/necmttn/abc123",
        );
    });
});
```

- [ ] **Step 2: Write failing formatter test**

```ts
import { describe, expect, it } from "bun:test";
import { formatSharePreview } from "./format.ts";
import { minimalShareArtifact } from "./artifact.ts";

describe("share formatter", () => {
    it("prints a concise preview", () => {
        const artifact = {
            ...minimalShareArtifact({ id: "abc123", source: "codex" }),
            stats: { turns: 3, tool_calls: 2, files_changed: 1, skills_used: 1, failures: 0 },
        };

        const text = formatSharePreview(artifact);
        expect(text).toContain("Session abc123");
        expect(text).toContain("source: codex");
        expect(text).toContain("turns: 3");
        expect(text).toContain("secret/unlisted Gist");
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
bun test src/share/gist.test.ts src/share/format.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement Gist helpers**

```ts
import { Effect } from "effect";
import type { AxSessionShare } from "./artifact.ts";

export interface GistRef {
    readonly owner: string;
    readonly gistId: string;
}

export function parseGistCreateOutput(output: string): GistRef | null {
    const match = output.match(/https:\/\/gist\.github\.com\/([^/\s]+)\/([A-Za-z0-9]+)/);
    if (!match) return null;
    return { owner: match[1], gistId: match[2] };
}

export function shareUrlForGist(ref: GistRef): string {
    return `https://ax.necmttn.com/s/${ref.owner}/${ref.gistId}`;
}

export const createSessionGist = (input: {
    readonly artifact: AxSessionShare;
    readonly public: boolean;
}): Effect.Effect<GistRef, Error> =>
    Effect.tryPromise(async () => {
        const proc = Bun.spawn([
            "gh",
            "gist",
            "create",
            input.public ? "--public" : "--secret",
            "--filename",
            "ax-session.json",
            "-",
        ], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        proc.stdin.write(JSON.stringify(input.artifact, null, 2));
        proc.stdin.end();
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (exitCode !== 0) throw new Error(stderr.trim() || `gh gist create exited ${exitCode}`);
        const parsed = parseGistCreateOutput(stdout);
        if (!parsed) throw new Error(`could not parse gist URL from gh output: ${stdout.trim()}`);
        return parsed;
    });
```

- [ ] **Step 5: Implement format helpers**

```ts
import type { AxSessionShare } from "./artifact.ts";
import type { GistRef } from "./gist.ts";
import { shareUrlForGist } from "./gist.ts";

export function formatSharePreview(artifact: AxSessionShare): string {
    const lines = [
        `Session ${artifact.session.id}`,
        `source: ${artifact.session.source}`,
        artifact.session.model ? `model: ${artifact.session.model}` : null,
        artifact.session.project ? `project: ${artifact.session.project}` : null,
        `turns: ${artifact.stats.turns}`,
        `tool calls: ${artifact.stats.tool_calls}`,
        `files changed: ${artifact.stats.files_changed}`,
        `skills used: ${artifact.stats.skills_used}`,
        `failures: ${artifact.stats.failures}`,
        `redactions: ${artifact.redactions.applied ? artifact.redactions.rules.join(", ") : "none"}`,
        "publish target: secret/unlisted Gist",
    ].filter((line): line is string => line !== null);
    return lines.join("\n");
}

export function formatShareSuccess(ref: GistRef): string {
    return `Published session share:\n${shareUrlForGist(ref)}`;
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test src/share/gist.test.ts src/share/format.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/share/gist.ts src/share/gist.test.ts src/share/format.ts src/share/format.test.ts
git commit -m "feat: publish session shares to gist"
```

---

### Task 6: `axctl share` Command

**Files:**
- Modify: `src/cli/index.ts`
- Test: `src/cli/share.test.ts`

- [ ] **Step 1: Write CLI command tests**

If current CLI tests shell out to `bun src/cli/index.ts`, follow that pattern. Otherwise create focused tests for argument parsing helpers exported from a new small module. Prefer extracting command execution into `src/cli/share.ts` if `index.ts` gets too large.

```ts
import { describe, expect, it } from "bun:test";
import { parseShareArgs } from "./share.ts";

describe("parseShareArgs", () => {
    it("parses dry-run share args", () => {
        expect(parseShareArgs(["abc123", "--dry-run"])).toEqual({
            sessionId: "abc123",
            dryRun: true,
            open: false,
            public: false,
            yes: false,
        });
    });

    it("requires a session id", () => {
        expect(() => parseShareArgs(["--dry-run"])).toThrow("missing <session-id>");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/cli/share.test.ts
```

Expected: FAIL because `src/cli/share.ts` does not exist.

- [ ] **Step 3: Create `src/cli/share.ts`**

```ts
import { Effect } from "effect";
import { exportSessionShare } from "../share/exporter.ts";
import { redactShareArtifact } from "../share/redact.ts";
import { createSessionGist, shareUrlForGist } from "../share/gist.ts";
import { formatSharePreview, formatShareSuccess } from "../share/format.ts";
import { AX_VERSION } from "./version.ts";
import { AppLayer } from "../lib/layers.ts";
import { catchDbErrorAndExit } from "./output.ts";

export interface ShareArgs {
    readonly sessionId: string;
    readonly dryRun: boolean;
    readonly open: boolean;
    readonly public: boolean;
    readonly yes: boolean;
}

export function parseShareArgs(args: ReadonlyArray<string>): ShareArgs {
    const flags = new Set(args.filter((arg) => arg.startsWith("--")));
    const sessionId = args.find((arg) => !arg.startsWith("--"));
    if (!sessionId) throw new Error("missing <session-id>");
    return {
        sessionId,
        dryRun: flags.has("--dry-run"),
        open: flags.has("--open"),
        public: flags.has("--public"),
        yes: flags.has("--yes"),
    };
}

export function cmdShare(args: string[]): Promise<void> {
    let parsed: ShareArgs;
    try {
        parsed = parseShareArgs(args);
    } catch (err) {
        console.error(`axctl share: ${(err as Error).message}`);
        console.error("  usage: axctl share <session-id> [--dry-run] [--public] [--open] [--yes]");
        process.exitCode = 2;
        return Promise.resolve();
    }

    const program = Effect.gen(function* () {
        const raw = yield* exportSessionShare(parsed.sessionId, AX_VERSION);
        if (!raw) {
            yield* Effect.sync(() => {
                console.error(`axctl share: session ${parsed.sessionId} not found`);
                process.exitCode = 1;
            });
            return;
        }
        const { artifact } = redactShareArtifact(raw);
        if (parsed.dryRun) {
            yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`));
            return;
        }
        yield* Effect.sync(() => process.stderr.write(`${formatSharePreview(artifact)}\n\n`));
        if (!parsed.yes) {
            yield* Effect.sync(() => {
                process.stderr.write("Re-run with --yes to publish this secret/unlisted Gist.\n");
                process.exitCode = 2;
            });
            return;
        }
        const ref = yield* createSessionGist({ artifact, public: parsed.public });
        const url = shareUrlForGist(ref);
        yield* Effect.sync(() => process.stdout.write(`${formatShareSuccess(ref)}\n`));
        if (parsed.open) {
            yield* Effect.tryPromise(() => Bun.spawn(["open", url]).exited).pipe(Effect.ignore);
        }
    }).pipe(
        Effect.provide(AppLayer),
        catchDbErrorAndExit("axctl share"),
    );

    return Effect.runPromise(program);
}
```

- [ ] **Step 4: Register command in `src/cli/index.ts`**

Add import near other CLI command imports:

```ts
import { cmdShare } from "./share.ts";
```

Add a simple command near the session commands:

```ts
const shareCommand = Command.make("share", {}, () =>
    Effect.promise(() => cmdShare(process.argv.slice(3)))
).pipe(Command.withDescription("Publish a sanitized session artifact to GitHub Gist and print an ax.necmttn.com share URL"));
```

Add `shareCommand` to the top-level subcommands array. Use the existing `Command.withSubcommands([...])` block near the end of `src/cli/index.ts`.

- [ ] **Step 5: Run CLI tests and dry-run manually**

Run:

```bash
bun test src/cli/share.test.ts
bun run typecheck
bun src/cli/index.ts share --help
```

Expected:

- tests PASS
- typecheck PASS
- help lists `share`

If a real local session exists, also run:

```bash
bun src/cli/index.ts share <known-session-id> --dry-run
```

Expected: valid JSON with `"schema_version": 1`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/share.ts src/cli/share.test.ts
git commit -m "feat: add axctl share command"
```

---

### Task 7: Site Gist Fetch Helpers

**Files:**
- Create: `site/app/lib/session-share.ts`
- Test: `site/app/lib/session-share.test.ts`

- [ ] **Step 1: Write failing helper tests**

```ts
import { describe, expect, it } from "bun:test";
import {
    gistApiUrl,
    rawSessionFileUrlFromGist,
    validateShareArtifact,
} from "./session-share.ts";

describe("site session share helpers", () => {
    it("builds GitHub API URLs", () => {
        expect(gistApiUrl("abc123")).toBe("https://api.github.com/gists/abc123");
    });

    it("selects ax-session.json raw URL from a Gist response", () => {
        const raw = rawSessionFileUrlFromGist({
            owner: { login: "necmttn" },
            files: {
                "ax-session.json": {
                    raw_url: "https://gist.githubusercontent.com/necmttn/abc/raw/ax-session.json",
                },
            },
        });

        expect(raw).toBe("https://gist.githubusercontent.com/necmttn/abc/raw/ax-session.json");
    });

    it("validates schema version", () => {
        expect(() => validateShareArtifact({ schema_version: 999 })).toThrow("Unsupported session share schema");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd site && bun test app/lib/session-share.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement site helpers**

```ts
export const SUPPORTED_SHARE_SCHEMA_VERSION = 1;

export function gistApiUrl(gistId: string): string {
    return `https://api.github.com/gists/${encodeURIComponent(gistId)}`;
}

export function rawSessionFileUrlFromGist(value: unknown): string {
    if (typeof value !== "object" || value === null) {
        throw new Error("Invalid Gist response");
    }
    const files = (value as { files?: unknown }).files;
    if (typeof files !== "object" || files === null) {
        throw new Error("Gist response has no files");
    }
    const sessionFile = (files as Record<string, unknown>)["ax-session.json"];
    if (typeof sessionFile !== "object" || sessionFile === null) {
        throw new Error("Gist does not contain ax-session.json");
    }
    const rawUrl = (sessionFile as { raw_url?: unknown }).raw_url;
    if (typeof rawUrl !== "string") {
        throw new Error("ax-session.json has no raw_url");
    }
    return rawUrl;
}

export function validateShareArtifact(value: unknown): any {
    if (typeof value !== "object" || value === null) {
        throw new Error("Invalid session share artifact");
    }
    const schemaVersion = (value as { schema_version?: unknown }).schema_version;
    if (schemaVersion !== SUPPORTED_SHARE_SCHEMA_VERSION) {
        throw new Error(`Unsupported session share schema: ${String(schemaVersion)}`);
    }
    return value;
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
cd site && bun test app/lib/session-share.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add site/app/lib/session-share.ts site/app/lib/session-share.test.ts
git commit -m "feat: fetch gist session share artifacts"
```

---

### Task 8: Public Share Route Renderer

**Files:**
- Create: `site/app/routes/s.$owner.$gistId.tsx`
- Modify if generated by router tooling: `site/app/routeTree.gen.ts`

- [ ] **Step 1: Create the route with loader and basic renderer**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import {
    gistApiUrl,
    rawSessionFileUrlFromGist,
    validateShareArtifact,
} from "~/lib/session-share";

export const Route = createFileRoute("/s/$owner/$gistId")({
    loader: async ({ params }) => {
        const gistResponse = await fetch(gistApiUrl(params.gistId), {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!gistResponse.ok) {
            throw new Error(`Could not fetch Gist ${params.owner}/${params.gistId}`);
        }
        const gist = await gistResponse.json();
        const rawUrl = rawSessionFileUrlFromGist(gist);
        const artifactResponse = await fetch(rawUrl);
        if (!artifactResponse.ok) {
            throw new Error("Could not fetch ax-session.json");
        }
        return validateShareArtifact(await artifactResponse.json());
    },
    component: ShareRoute,
});

function ShareRoute() {
    const artifact = Route.useLoaderData() as any;
    return (
        <main className="min-h-screen bg-[#f7f7f4] text-[#151515]">
            <section className="mx-auto max-w-6xl px-6 py-10">
                <div className="mb-8 border-b border-black/15 pb-6">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-black/55">
                        Shared agent session
                    </p>
                    <h1 className="text-4xl font-semibold tracking-normal">
                        {artifact.session.summary ?? artifact.session.project ?? artifact.session.id}
                    </h1>
                    <div className="mt-4 flex flex-wrap gap-2 text-sm">
                        <span className="rounded border border-black/15 px-2 py-1">{artifact.session.source}</span>
                        {artifact.session.model ? <span className="rounded border border-black/15 px-2 py-1">{artifact.session.model}</span> : null}
                        <span className="rounded border border-black/15 px-2 py-1">{artifact.stats.turns} events</span>
                        <span className="rounded border border-black/15 px-2 py-1">{artifact.stats.files_changed} files</span>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1.4fr_.8fr]">
                    <section className="space-y-6">
                        <Panel title="Timeline">
                            <ol className="space-y-3">
                                {artifact.timeline.map((event: any) => (
                                    <li key={event.id} className="border-l border-black/20 pl-4">
                                        <div className="text-sm font-semibold">{event.title}</div>
                                        {event.summary ? <p className="mt-1 text-sm text-black/65">{event.summary}</p> : null}
                                    </li>
                                ))}
                            </ol>
                        </Panel>

                        <Panel title="Working Style">
                            {artifact.derived?.working_style?.length ? (
                                <ul className="list-disc space-y-2 pl-5 text-sm text-black/70">
                                    {artifact.derived.working_style.map((item: string) => <li key={item}>{item}</li>)}
                                </ul>
                            ) : (
                                <p className="text-sm text-black/55">No working-style summary in this artifact.</p>
                            )}
                        </Panel>
                    </section>

                    <aside className="space-y-6">
                        <Panel title="Files">
                            <ul className="space-y-2 font-mono text-xs">
                                {artifact.files.map((file: any) => (
                                    <li key={file.path} className="break-all">{file.path}</li>
                                ))}
                            </ul>
                        </Panel>

                        <Panel title="Graph">
                            <div className="space-y-2 text-sm text-black/70">
                                <p>{artifact.graph.nodes.length} nodes</p>
                                <p>{artifact.graph.edges.length} edges</p>
                            </div>
                        </Panel>

                        <Panel title="Provenance">
                            <p className="text-sm text-black/65">Stored in GitHub Gist. Rendered by ax.necmttn.com.</p>
                            <p className="mt-2 text-xs text-black/50">Exported {artifact.exported_at}</p>
                        </Panel>
                    </aside>
                </div>
            </section>
        </main>
    );
}

function Panel(props: { readonly title: string; readonly children: React.ReactNode }) {
    return (
        <section className="border border-black/15 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-black/55">{props.title}</h2>
            {props.children}
        </section>
    );
}
```

- [ ] **Step 2: Regenerate route tree if needed**

Run:

```bash
cd site && bun run typecheck
```

Expected: If TanStack route generation complains, run the repo's established route generation command or `bun run build` and commit generated `routeTree.gen.ts`.

- [ ] **Step 3: Build site**

Run:

```bash
cd site && bun run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add site/app/routes/s.\$owner.\$gistId.tsx site/app/routeTree.gen.ts
git commit -m "feat: render shared session gist pages"
```

If `routeTree.gen.ts` was not modified, omit it from `git add`.

---

### Task 9: End-to-End Verification And Docs

**Files:**
- Modify: `docs/insights-cli-reference.md` or another CLI reference source if this repo generates docs from source.
- Modify: `README.md` only if current README has CLI feature bullets that should mention share.
- Test: no new test file unless documentation checker requires one.

- [ ] **Step 1: Add concise docs**

Add a section:

```md
### Share a Session

`axctl share <session-id>` exports a sanitized session artifact, creates a
secret GitHub Gist containing `ax-session.json`, and prints an
`https://ax.necmttn.com/s/<owner>/<gist-id>` renderer URL.

Use `--dry-run` to inspect the artifact before publishing:

```bash
axctl share <session-id> --dry-run > session-share.json
```

Secret Gists are unlisted links, not private storage. Do not share sessions that
contain secrets or proprietary data without reviewing the dry-run artifact first.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
bun test src/share/*.test.ts src/cli/share.test.ts
bun run typecheck
cd site && bun test app/lib/session-share.test.ts && bun run typecheck && bun run build
```

Expected: all PASS.

- [ ] **Step 3: Manual smoke test with a real session**

Run:

```bash
bun src/cli/index.ts sessions here --days=30
bun src/cli/index.ts share <real-session-id> --dry-run > /tmp/ax-session-share.json
head -40 /tmp/ax-session-share.json
```

Expected:

- JSON starts with `"schema_version": 1`
- no raw full transcript
- no absolute `/Users/necmttn` paths
- `redactions.rules` is present

If GitHub CLI is authenticated and the artifact is safe to publish:

```bash
bun src/cli/index.ts share <real-session-id> --yes
```

Expected:

- command prints `https://ax.necmttn.com/s/<owner>/<gist-id>`
- opening URL renders the session page

- [ ] **Step 4: Commit docs and final verification fixes**

```bash
git add README.md docs/insights-cli-reference.md
git commit -m "docs: document session sharing"
```

If only one doc changed, add only that file.

---

## Self-Review

- Spec coverage: The plan covers artifact schema, redaction, CLI preview/dry-run/publish, Gist storage, `/s/<owner>/<gist-id>` rendering, error paths, and tests.
- Scope check: The plan keeps Gist create-only, static graph, no hosted DB, no accounts, no raw transcript by default.
- Red-flag scan: No deferred implementation markers. The only conditional instructions are for generated route files and existing doc source location.
- Type consistency: Artifact names are consistent: `AxSessionShare`, `ShareEvent`, `ShareFile`, `ShareGraph`, `schema_version`, `ax-session.json`, `/s/<owner>/<gist-id>`.
