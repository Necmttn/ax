# Content-Type Classification for Tool Outputs - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify every `tool_call` output by content-type (a small fixed taxonomy) at ingest, write it as a `has_content` graph edge, and thread the content-type facet through existing read paths (context-budget, cost split, recall, insights, profile) - no new CLI command, no new MCP tool.

**Architecture:** A deterministic TS classifier (file-extension from the tool input + lightweight content sniff, `ClassifierKind=heuristic`) runs as a new idempotent ingest derive-stage. It upserts 12 fixed `content_type` nodes and writes one `has_content` edge per tool_call. The edge denormalizes `session` + `bytes` so every downstream rollup is deref-free (the house idiom - stacking record derefs inside aggregates over large edge tables hangs production). Read surfaces gain a content-type dimension via one shared query helper. Magika (the Python probe used in the spike) is intentionally NOT a runtime dependency; it can return later as an optional `local_model` upgrade.

**Tech Stack:** bun >= 1.3, TypeScript (strict), Effect v4 beta, SurrealDB 3.x. Tests: `bun:test`. Internal imports by package name (`@ax/lib/db`, `@ax/lib/shared/surreal`).

**Spike evidence (already run, 4000 recent outputs):** group-level split is trustworthy (text 57.9% / code 41.1%); fine ML labels were noisy (60% < 0.80 confidence, false `clojure` in a TS repo) - hence deterministic categories, not ML. `unknown` outputs errored 42% vs 1-5% baseline; `application`-class blobs were 0.1% of calls but 5.6% of tokens. Those two signals justify the build.

---

## Content-type taxonomy (fixed node set)

Twelve stable categories. Node id = `content_type:<category>`. The set is closed; the classifier always resolves to exactly one.

| category | meaning | primary signal |
|---|---|---|
| `json` | JSON / JSONL | ext `.json/.jsonl` or trimmed starts `{`/`[` |
| `code` | source code | ext in CODE_EXT or shebang |
| `diff` | unified diff / patch | leading `diff --git` / `@@ ` / `--- `+`+++ ` |
| `markdown` | markdown / prose docs | ext `.md/.mdx` |
| `yaml` | YAML | ext `.yaml/.yml` |
| `config` | config / dotfiles | ext `.toml/.ini/.env/.conf` or known dotfile |
| `log` | log output | ext `.log` |
| `filelist` | path lists / search hits | Grep/Glob output shape |
| `text` | plain text fallback | default for textual content |
| `binary` | non-text blobs | ext in BINARY_EXT |
| `empty` | empty / whitespace-only | length 0 after trim |
| `unknown` | could not resolve | classifier abstained |

`method` (on the edge): `"extension"` (conf 0.95) | `"sniff"` (conf 0.6) | `"fallback"` (conf 0.4). `fine_label` (on the edge, optional) keeps the raw extension or sniff reason for drill-down.

---

## File Structure

**Write path**
- Create `apps/axctl/src/ingest/content-type-classify.ts` - pure classifier (no Effect, no DB): `classifyContentType(input) -> {category, method, confidence, fineLabel}`. One responsibility: bytes/path -> category.
- Create `apps/axctl/src/ingest/content-type-classify.test.ts`.
- Create `apps/axctl/src/ingest/derive-content-types.ts` - the ingest stage: query unclassified tool_calls, classify, write nodes + edges.
- Create `apps/axctl/src/ingest/derive-content-types.test.ts`.
- Modify `packages/schema/src/schema.surql` - add `content_type` + `has_content` DDL after the `tool_call` block.
- Modify `apps/axctl/src/ingest/stage/registry.ts` - register `contentTypesStage`.
- Modify `apps/axctl/src/queries/insights.ts` - add two `SCHEMA_TABLES` rows.

**Read path (enhance only)**
- Create `apps/axctl/src/queries/content-types.ts` - shared deref-free rollup helper (global distribution, per-session mix). Used by every surface below.
- Create `apps/axctl/src/queries/content-types.test.ts`.
- Modify `apps/axctl/src/queries/context-budget.ts` - attach content-type breakdown to `ContextBudgetResult`.
- Modify `apps/axctl/src/queries/cost-analytics.ts` - add content-type dimension to cost split.
- Modify `apps/axctl/src/cli/commands/recall.ts` - add `--type=` filter flag.
- Modify the profile builder (`apps/axctl/src/profile/`) - add a `tool-output-mix` taste pattern.

---

## Phasing

- **Phase 1 (write path + core read): Tasks 1-6.** Ships the signal end-to-end and the headline read surface (context-budget). Stop-and-ship point.
- **Phase 2 (remaining read surfaces): Tasks 7-10.** Independent of each other; each rides the Task 5 helper.

---

## Task 1: Pure content-type classifier

**Files:**
- Create: `apps/axctl/src/ingest/content-type-classify.ts`
- Test: `apps/axctl/src/ingest/content-type-classify.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/axctl/src/ingest/content-type-classify.test.ts
import { describe, expect, test } from "bun:test";
import { classifyContentType } from "./content-type-classify.ts";

describe("classifyContentType", () => {
  test("extension wins: .ts -> code, conf 0.95", () => {
    const r = classifyContentType({ filePath: "/a/b.ts", output: "const x = 1;" });
    expect(r.category).toBe("code");
    expect(r.method).toBe("extension");
    expect(r.confidence).toBe(0.95);
    expect(r.fineLabel).toBe("ts");
  });

  test(".json -> json", () => {
    expect(classifyContentType({ filePath: "x.json", output: "{}" }).category).toBe("json");
  });

  test("empty output -> empty regardless of path", () => {
    expect(classifyContentType({ filePath: "x.ts", output: "   \n" }).category).toBe("empty");
  });

  test("no path, JSON-ish body -> json by sniff, conf 0.6", () => {
    const r = classifyContentType({ filePath: null, output: '  [{"a":1}]' });
    expect(r.category).toBe("json");
    expect(r.method).toBe("sniff");
    expect(r.confidence).toBe(0.6);
  });

  test("no path, diff markers -> diff", () => {
    const r = classifyContentType({ filePath: null, output: "diff --git a/x b/x\n@@ -1 +1 @@" });
    expect(r.category).toBe("diff");
  });

  test("grep-style hits -> filelist", () => {
    const out = "src/a.ts:12: foo\nsrc/b.ts:4: bar\nsrc/c.ts:9: baz";
    expect(classifyContentType({ filePath: null, output: out, toolName: "Grep" }).category).toBe("filelist");
  });

  test("plain prose -> text fallback, conf 0.4", () => {
    const r = classifyContentType({ filePath: null, output: "the quick brown fox jumps" });
    expect(r.category).toBe("text");
    expect(r.method).toBe("fallback");
    expect(r.confidence).toBe(0.4);
  });

  test(".png -> binary", () => {
    expect(classifyContentType({ filePath: "x.png", output: "..." }).category).toBe("binary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/ingest/content-type-classify.test.ts`
Expected: FAIL - "Cannot find module './content-type-classify.ts'".

- [ ] **Step 3: Write the implementation**

```typescript
// apps/axctl/src/ingest/content-type-classify.ts
/**
 * Deterministic content-type classifier for tool_call outputs.
 *
 * Pure function - no Effect, no DB. The ingest stage calls this per row.
 * Extension (from the tool input file_path) is the strongest, cheapest signal;
 * a lightweight content sniff handles Bash/exec output that has no path; a text
 * fallback closes the set. Magika (the spike probe) is deliberately absent -
 * group-level categories from ext+sniff were the trustworthy part of the spike.
 */

export type ContentCategory =
  | "json" | "code" | "diff" | "markdown" | "yaml" | "config"
  | "log" | "filelist" | "text" | "binary" | "empty" | "unknown";

export type ClassifyMethod = "extension" | "sniff" | "fallback";

export interface ClassifyInput {
  /** file_path pulled from the tool input_json (Read/Edit/Write/NotebookEdit); null otherwise */
  readonly filePath: string | null;
  /** the output text (output_excerpt is fine - sniff is prefix-tolerant) */
  readonly output: string;
  /** tool name, used only to bias Grep/Glob toward filelist */
  readonly toolName?: string | null;
}

export interface ClassifyResult {
  readonly category: ContentCategory;
  readonly method: ClassifyMethod;
  readonly confidence: number;
  readonly fineLabel: string | null;
}

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "rb",
  "c", "h", "cpp", "hpp", "cc", "cs", "swift", "kt", "scala", "clj", "ex",
  "exs", "php", "sh", "bash", "zsh", "fish", "sql", "surql", "lua", "r",
  "dart", "vue", "svelte", "css", "scss", "sass", "less", "html", "xml",
]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar",
  "wasm", "so", "dylib", "dll", "bin", "exe", "woff", "woff2", "ttf", "mp4", "mov",
]);
const EXT_CATEGORY: ReadonlyArray<[ReadonlyArray<string>, ContentCategory]> = [
  [["json", "jsonl"], "json"],
  [["md", "mdx"], "markdown"],
  [["yaml", "yml"], "yaml"],
  [["toml", "ini", "env", "conf", "cfg"], "config"],
  [["log"], "log"],
  [["csv", "tsv", "txt"], "text"],
];
const DOTFILES = new Set([".gitignore", ".npmignore", ".dockerignore", ".env", ".editorconfig"]);

const extOf = (p: string): string => {
  const base = p.split("/").pop() ?? p;
  if (DOTFILES.has(base)) return "config__dotfile";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

const categoryForExt = (ext: string): ContentCategory | null => {
  if (ext === "config__dotfile") return "config";
  if (CODE_EXT.has(ext)) return "code";
  if (BINARY_EXT.has(ext)) return "binary";
  for (const [list, cat] of EXT_CATEGORY) {
    if (list.includes(ext)) return cat;
  }
  return null;
};

const DIFF_RE = /^(diff --git |@@ |Index: |--- )/m;
const GREP_HIT_RE = /^[^\s:]+:\d+:/;

const sniff = (output: string, toolName: string | null | undefined): ContentCategory | null => {
  const t = output.trimStart();
  if (DIFF_RE.test(t)) return "diff";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("#!")) return "code";
  // grep/glob style: most non-empty lines are path:line: hits
  const lines = output.split("\n").filter((l) => l.length > 0).slice(0, 20);
  if (lines.length >= 2) {
    const hits = lines.filter((l) => GREP_HIT_RE.test(l)).length;
    if (hits / lines.length >= 0.6) return "filelist";
  }
  if ((toolName === "Glob" || toolName === "Grep") && lines.length >= 2) return "filelist";
  return null;
};

export const classifyContentType = (input: ClassifyInput): ClassifyResult => {
  if (input.output.trim().length === 0) {
    return { category: "empty", method: "extension", confidence: 1.0, fineLabel: null };
  }
  if (input.filePath) {
    const ext = extOf(input.filePath);
    const cat = ext ? categoryForExt(ext) : null;
    if (cat) {
      return { category: cat, method: "extension", confidence: 0.95, fineLabel: ext.replace("config__dotfile", "dotfile") };
    }
  }
  const sniffed = sniff(input.output, input.toolName ?? null);
  if (sniffed) {
    return { category: sniffed, method: "sniff", confidence: 0.6, fineLabel: null };
  }
  return { category: "text", method: "fallback", confidence: 0.4, fineLabel: null };
};

/** The closed taxonomy - the derive stage upserts exactly these nodes. */
export const ALL_CONTENT_CATEGORIES: ReadonlyArray<ContentCategory> = [
  "json", "code", "diff", "markdown", "yaml", "config",
  "log", "filelist", "text", "binary", "empty", "unknown",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/ingest/content-type-classify.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/content-type-classify.ts apps/axctl/src/ingest/content-type-classify.test.ts
git commit -m "feat(ingest): deterministic content-type classifier for tool outputs"
```

---

## Task 2: Schema DDL + SCHEMA_TABLES registration

**Files:**
- Modify: `packages/schema/src/schema.surql` (after the `tool_call` table block, around line 368)
- Modify: `apps/axctl/src/queries/insights.ts` (the `SCHEMA_TABLES` array)
- Test: relies on the existing `insights.test.ts` SCHEMA_TABLES guard

- [ ] **Step 1: Add the DDL**

Insert after the last `tool_call` index (`DEFINE INDEX ... tool_call_command_tool_ts ...`, line 368) in `packages/schema/src/schema.surql`:

```surql
-- Content-type classification of tool_call outputs (derive-content-types stage).
-- Closed taxonomy; one node per category. See content-type-classify.ts.
DEFINE TABLE content_type SCHEMAFULL;
DEFINE FIELD category    ON content_type TYPE string;  -- json|code|diff|markdown|yaml|config|log|filelist|text|binary|empty|unknown
DEFINE FIELD label       ON content_type TYPE string;  -- human label (same as category for now)

-- has_content: tool_call -> content_type. Denormalizes session + bytes so every
-- downstream rollup is deref-free (house idiom; derefs in aggregates hang prod).
DEFINE TABLE has_content TYPE RELATION FROM tool_call TO content_type SCHEMAFULL;
DEFINE FIELD method      ON has_content TYPE string;             -- extension|sniff|fallback
DEFINE FIELD confidence  ON has_content TYPE float DEFAULT 1.0;
DEFINE FIELD fine_label  ON has_content TYPE option<string>;     -- raw ext / sniff reason
DEFINE FIELD bytes       ON has_content TYPE int DEFAULT 0;       -- output byte length (token proxy)
DEFINE FIELD session     ON has_content TYPE option<record<session>>;
DEFINE FIELD ts          ON has_content TYPE datetime;
DEFINE INDEX IF NOT EXISTS has_content_in  ON has_content FIELDS in;
DEFINE INDEX IF NOT EXISTS has_content_out ON has_content FIELDS out;
DEFINE INDEX IF NOT EXISTS has_content_session ON has_content FIELDS session;
```

- [ ] **Step 2: Register the tables in SCHEMA_TABLES**

In `apps/axctl/src/queries/insights.ts`, add to the `SCHEMA_TABLES` array (after the `tool_call` entry):

```typescript
{ table: "content_type", stage: "active", note: "Closed content-type taxonomy for tool outputs." },
{ table: "has_content", stage: "active", note: "tool_call -> content_type edge; denormalizes session + bytes." },
```

(Match the exact field names of the existing entries - read one neighbouring entry first; if the property is `name` not `table`, or there is no `stage`, mirror that shape exactly.)

- [ ] **Step 3: Run the schema-mirror guard**

Run: `bun test apps/axctl/src/queries/insights.test.ts`
Expected: PASS - the SCHEMA_TABLES-mirrors-schema test stays green (it fails if the DDL and registry drift).

- [ ] **Step 4: Reset + reload the local DB schema**

Run: check `package.json` for the schema-apply command (`db:push` / `db:reset` / a `scripts/db-*.ts`) and run it. Then verify:

Run: `curl -s -X POST http://127.0.0.1:8521/sql -H "surreal-ns: ax" -H "surreal-db: main" -u root:root --data "INFO FOR TABLE has_content;" | head -c 200`
Expected: JSON describing the `has_content` fields (not an error).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/schema.surql apps/axctl/src/queries/insights.ts
git commit -m "feat(schema): content_type node + has_content edge"
```

---

## Task 3: derive-content-types ingest stage (pure edge builder)

**Files:**
- Create: `apps/axctl/src/ingest/derive-content-types.ts`
- Test: `apps/axctl/src/ingest/derive-content-types.test.ts`

This task builds the pure edge-spec layer + render functions. Task 4 wires the DB query + stage registration. Splitting keeps the pure logic unit-testable without a DB.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/axctl/src/ingest/derive-content-types.test.ts
import { describe, expect, test } from "bun:test";
import { buildContentEdge, renderContentEdge, renderContentTypeNodes } from "./derive-content-types.ts";

describe("buildContentEdge", () => {
  test("derives category + denormalized session/bytes from a tool_call row", () => {
    const e = buildContentEdge({
      id: "tool_call:abc", session: "session:s1", name: "Read",
      inputJson: '{"file_path":"/x/y.ts"}', outputExcerpt: "const a = 1;", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
    expect(e).toEqual({
      toolCallId: "tool_call:abc", category: "code", session: "session:s1",
      method: "extension", confidence: 0.95, fineLabel: "ts", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
  });

  test("falls back to output sniff when input has no file_path", () => {
    const e = buildContentEdge({
      id: "tool_call:b", session: "session:s1", name: "Bash",
      inputJson: '{"command":"ls"}', outputExcerpt: '[{"a":1}]', bytes: 9, ts: "2026-06-17T00:00:00Z",
    });
    expect(e.category).toBe("json");
    expect(e.method).toBe("sniff");
  });
});

describe("renderContentEdge", () => {
  test("emits a deterministic RELATE keyed by tool_call id (idempotent re-runs)", () => {
    const sql = renderContentEdge({
      toolCallId: "tool_call:abc", category: "code", session: "session:s1",
      method: "extension", confidence: 0.95, fineLabel: "ts", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
    expect(sql).toContain("->has_content:");
    expect(sql).toContain("->content_type:");
    expect(sql).toContain("bytes = 12");
    expect(sql).toContain("confidence = 0.95");
  });

  test("returns null on an unkeyable id", () => {
    expect(renderContentEdge({ ...({} as never), toolCallId: "", category: "text" } as never)).toBeNull();
  });
});

describe("renderContentTypeNodes", () => {
  test("upserts all 12 fixed category nodes", () => {
    const stmts = renderContentTypeNodes();
    expect(stmts.length).toBe(12);
    expect(stmts[0]).toContain("UPSERT content_type:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/ingest/derive-content-types.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the pure layer**

```typescript
// apps/axctl/src/ingest/derive-content-types.ts (pure section - DB query added in Task 4)
import {
  recordKeyPart, recordRef, safeKeyPart, surrealDate, surrealString,
} from "@ax/lib/shared/surreal";
import {
  ALL_CONTENT_CATEGORIES, classifyContentType, type ContentCategory,
} from "./content-type-classify.ts";

export interface ToolCallRow {
  readonly id: string;
  readonly session: string | null;
  readonly name: string | null;
  readonly inputJson: string | null;
  readonly outputExcerpt: string | null;
  readonly bytes: number;
  readonly ts: string;
}

export interface ContentEdgeSpec {
  readonly toolCallId: string;
  readonly category: ContentCategory;
  readonly session: string | null;
  readonly method: string;
  readonly confidence: number;
  readonly fineLabel: string | null;
  readonly bytes: number;
  readonly ts: string;
}

const filePathFromInput = (inputJson: string | null): string | null => {
  if (!inputJson) return null;
  try {
    const obj = JSON.parse(inputJson) as Record<string, unknown>;
    const fp = obj["file_path"] ?? obj["path"] ?? obj["notebook_path"];
    return typeof fp === "string" ? fp : null;
  } catch {
    return null;
  }
};

export const buildContentEdge = (row: ToolCallRow): ContentEdgeSpec => {
  const r = classifyContentType({
    filePath: filePathFromInput(row.inputJson),
    output: row.outputExcerpt ?? "",
    toolName: row.name,
  });
  return {
    toolCallId: row.id,
    category: r.category,
    session: row.session,
    method: r.method,
    confidence: r.confidence,
    fineLabel: r.fineLabel,
    bytes: row.bytes,
    ts: row.ts,
  };
};

/** UPSERT the closed taxonomy. Idempotent; safe every run. */
export const renderContentTypeNodes = (): string[] =>
  ALL_CONTENT_CATEGORIES.map(
    (c) => `UPSERT content_type:${c} SET category = ${surrealString(c)}, label = ${surrealString(c)};`,
  );

/** Edge keyed by tool_call id => deterministic => idempotent on re-run. */
export const renderContentEdge = (e: ContentEdgeSpec): string | null => {
  const tcKey = recordKeyPart(e.toolCallId, "tool_call");
  if (!tcKey) return null;
  const edgeKey = safeKeyPart(e.toolCallId);
  const sessionClause = e.session ? `, session = ${e.session}` : "";
  const fineClause = e.fineLabel ? `, fine_label = ${surrealString(e.fineLabel)}` : "";
  return (
    `RELATE ${recordRef("tool_call", tcKey)}->${recordRef("has_content", edgeKey)}->content_type:${e.category} ` +
    `SET method = ${surrealString(e.method)}, confidence = ${e.confidence}, bytes = ${e.bytes}, ` +
    `ts = ${surrealDate(e.ts)}${sessionClause}${fineClause};`
  );
};
```

Note on `recordRef`/`recordKeyPart`/`safeKeyPart`/`surrealDate`/`surrealString`: import exactly as `derive-loaded-skills.ts` does. If `recordRef`'s signature differs from `(table, key)`, mirror the loaded-skills call site precisely.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/ingest/derive-content-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/derive-content-types.ts apps/axctl/src/ingest/derive-content-types.test.ts
git commit -m "feat(ingest): content-edge spec builder + renderers"
```

---

## Task 4: Wire the DB query + register the stage

**Files:**
- Modify: `apps/axctl/src/ingest/derive-content-types.ts` (append the `deriveContentTypes` Effect + stage def)
- Modify: `apps/axctl/src/ingest/stage/registry.ts` (import + add to `ALL_STAGES`)
- Test: `apps/axctl/src/ingest/derive-content-types.test.ts` (add an integration check), `apps/axctl/src/ingest/stage/registry.test.ts` (existing guard)

- [ ] **Step 1: Append the Effect stage to derive-content-types.ts**

```typescript
// append to apps/axctl/src/ingest/derive-content-types.ts
import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { executeStatementsWith } from "@ax/lib/shared/surreal";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

// Incremental: classify only tool_calls that have no has_content edge yet.
// Two FLAT queries (deref-free): the already-classified id set, and the
// unclassified rows. Edge ids are deterministic, so re-running is safe even if
// the "already classified" set races - RELATE on an existing id is a no-op upsert.
const ALREADY_SQL = `SELECT type::string(in) AS tid FROM has_content;`;
const ROWS_SQL = `
SELECT type::string(id) AS id, type::string(session) AS session, name,
       input_json AS inputJson, output_excerpt AS outputExcerpt,
       string::len(output_json) AS bytes, type::string(ts) AS ts
FROM tool_call WHERE output_json != NONE;
`;

export interface DeriveContentTypeStats {
  readonly written: number;
  readonly skipped: number;
}

export const deriveContentTypes = Effect.fn("ingest.deriveContentTypes")(function* () {
  const db = yield* SurrealClient;
  const [already] = yield* db.query<[Array<{ tid: string }>]>(ALREADY_SQL);
  const [rows] = yield* db.query<[Array<ToolCallRow>]>(ROWS_SQL);

  const done = new Set((already ?? []).map((r) => r.tid));
  const stmts: string[] = renderContentTypeNodes();
  let written = 0;
  let skipped = 0;
  for (const row of rows ?? []) {
    if (done.has(row.id)) { skipped += 1; continue; }
    const sql = renderContentEdge(buildContentEdge(row));
    if (sql) { stmts.push(sql); written += 1; }
  }
  yield* executeStatementsWith(db, stmts, { chunkSize: 250, label: "contentEdges" });
  return { written, skipped } satisfies DeriveContentTypeStats;
});

export class ContentTypeStats extends BaseStageStats.extend<ContentTypeStats>(
  "ContentTypeStats",
)({
  written: Schema.Number,
  skipped: Schema.Number,
}) {}

/**
 * Content-types stage - classifies tool_call outputs into a closed taxonomy and
 * writes has_content edges (denormalized session + bytes for deref-free reads).
 * Depends on the transcript/codex parsers having written tool_call rows.
 * Tags: derive.
 */
export const contentTypesStage: StageDef<ContentTypeStats, SurrealClient> = {
  meta: StageMeta.make({
    key: "content-types",
    deps: ["claude", "codex"],
    tags: ["derive"],
  }),
  run: (_ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const result = yield* deriveContentTypes();
      return ContentTypeStats.make({
        durationMs: Date.now() - t0,
        summary: `classified ${result.written} tool outputs (${result.skipped} already done)`,
        written: result.written,
        skipped: result.skipped,
      });
    }),
};
```

Note: confirm the dep keys (`"claude"`, `"codex"`) exist in `ALL_STAGES` meta keys; the registry test validates deps-validity. If the tool_call-producing stages have different keys, use those.

- [ ] **Step 2: Register the stage**

In `apps/axctl/src/ingest/stage/registry.ts`: add the import next to the other derive imports -

```typescript
import { contentTypesStage } from "../derive-content-types.ts";
```

and add `contentTypesStage` into the `ALL_STAGES` array, after `cursorStage` (so all tool_call producers have run):

```typescript
export const ALL_STAGES = [skillsStage, commandsStage, agentDefStage, pricingStage, claudeStage, codexStage, piStage, opencodeStage, cursorStage, contentTypesStage, subagentsStage, /* ...unchanged... */] as const;
```

- [ ] **Step 3: Run the registry guard + a live ingest of the stage**

Run: `bun test apps/axctl/src/ingest/stage/registry.test.ts`
Expected: PASS (key-uniqueness + deps-validity hold).

Run: `bun run apps/axctl/bin/axctl ingest --stages=content-types`
Expected: completes; prints a summary like "classified N tool outputs".

- [ ] **Step 4: Verify edges landed + sanity-check the distribution**

Run:
```bash
curl -s -X POST http://127.0.0.1:8521/sql -H "surreal-ns: ax" -H "surreal-db: main" -u root:root \
  --data "SELECT type::string(out) AS ct, count() AS n, math::sum(bytes) AS bytes FROM has_content GROUP BY ct;" | jq '.[0].result'
```
Expected: rows for `content_type:code`, `content_type:text`, etc. with plausible counts (code+text dominate, matching the spike). Re-running the ingest should report most rows `skipped` (idempotency holds).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/derive-content-types.ts apps/axctl/src/ingest/stage/registry.ts
git commit -m "feat(ingest): register content-types derive stage"
```

---

## Task 5: Shared deref-free rollup helper

**Files:**
- Create: `apps/axctl/src/queries/content-types.ts`
- Test: `apps/axctl/src/queries/content-types.test.ts`

This is the single helper every read surface calls. Pure aggregation logic is unit-tested against fixture rows; the SQL is a thin wrapper.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/axctl/src/queries/content-types.test.ts
import { describe, expect, test } from "bun:test";
import { rollupContentTypes, BYTES_PER_TOKEN } from "./content-types.ts";

describe("rollupContentTypes", () => {
  test("aggregates calls + bytes + token share by category", () => {
    const out = rollupContentTypes([
      { ct: "content_type:code", calls: 3, bytes: 400 },
      { ct: "content_type:text", calls: 1, bytes: 400 },
    ]);
    expect(out.rows).toEqual([
      { category: "code", calls: 3, bytes: 400, estTokens: 100, tokenShare: 0.5 },
      { category: "text", calls: 1, bytes: 400, estTokens: 100, tokenShare: 0.5 },
    ]);
    expect(out.totals).toEqual({ calls: 4, bytes: 800, estTokens: 200 });
  });

  test("sorts by est tokens desc and strips the content_type: prefix", () => {
    const out = rollupContentTypes([
      { ct: "content_type:text", calls: 1, bytes: 100 },
      { ct: "content_type:code", calls: 1, bytes: 900 },
    ]);
    expect(out.rows.map((r) => r.category)).toEqual(["code", "text"]);
  });

  test("BYTES_PER_TOKEN matches the context-budget ratio", () => {
    expect(BYTES_PER_TOKEN).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/content-types.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write the helper**

```typescript
// apps/axctl/src/queries/content-types.ts
/**
 * Content-type rollups over the has_content edge. Deref-free: the edge
 * denormalizes bytes + session, so every aggregate is a flat GROUP BY (the
 * house idiom - record derefs inside aggregates over large edge tables hang
 * production). Shared by context-budget, cost split, and the profile facet.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

export const BYTES_PER_TOKEN = 4; // shared with skill-bloat + context-budget
const estTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

export interface ContentTypeRow {
  readonly category: string;
  readonly calls: number;
  readonly bytes: number;
  readonly estTokens: number;
  readonly tokenShare: number; // 0..1 of total est tokens
}
export interface ContentTypeBreakdown {
  readonly rows: ReadonlyArray<ContentTypeRow>;
  readonly totals: { readonly calls: number; readonly bytes: number; readonly estTokens: number };
}

interface RawCtRow { readonly ct: string; readonly calls: number; readonly bytes: number }

/** Pure aggregation - unit tested. */
export const rollupContentTypes = (raw: ReadonlyArray<RawCtRow>): ContentTypeBreakdown => {
  const totalBytes = raw.reduce((a, r) => a + Number(r.bytes ?? 0), 0);
  const rows = raw
    .map((r) => {
      const bytes = Number(r.bytes ?? 0);
      const tok = estTokens(bytes);
      return {
        category: r.ct.replace(/^content_type:/, ""),
        calls: Number(r.calls ?? 0),
        bytes,
        estTokens: tok,
        tokenShare: totalBytes > 0 ? bytes / totalBytes : 0,
      };
    })
    .sort((a, b) => b.estTokens - a.estTokens);
  return {
    rows,
    totals: {
      calls: rows.reduce((a, r) => a + r.calls, 0),
      bytes: totalBytes,
      estTokens: estTokens(totalBytes),
    },
  };
};

const DISTRIBUTION_SQL = `
SELECT type::string(out) AS ct, count() AS calls, math::sum(bytes) AS bytes
FROM has_content GROUP BY ct;
`;

/** Global content-type distribution. */
export const fetchContentTypeBreakdown = Effect.fn("queries.fetchContentTypeBreakdown")(
  function* () {
    const db = yield* SurrealClient;
    const [raw] = yield* db.query<[Array<RawCtRow>]>(DISTRIBUTION_SQL);
    return rollupContentTypes(raw ?? []);
  },
);

const PER_SESSION_SQL = `
SELECT type::string(session) AS sid, type::string(out) AS ct,
       count() AS calls, math::sum(bytes) AS bytes
FROM has_content WHERE session != NONE GROUP BY sid, ct;
`;

export interface SessionContentMix {
  readonly sessionId: string;
  readonly mix: ContentTypeBreakdown;
}

/** Per-session content-type mix (token-weighted). */
export const fetchSessionContentMix = Effect.fn("queries.fetchSessionContentMix")(
  function* () {
    const db = yield* SurrealClient;
    const [raw] = yield* db.query<[Array<{ sid: string; ct: string; calls: number; bytes: number }>]>(
      PER_SESSION_SQL,
    );
    const bySession = new Map<string, RawCtRow[]>();
    for (const r of raw ?? []) {
      const arr = bySession.get(r.sid) ?? [];
      arr.push({ ct: r.ct, calls: r.calls, bytes: r.bytes });
      bySession.set(r.sid, arr);
    }
    return Array.from(bySession.entries()).map(
      ([sessionId, rows]) => ({ sessionId, mix: rollupContentTypes(rows) }) satisfies SessionContentMix,
    );
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/content-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/content-types.ts apps/axctl/src/queries/content-types.test.ts
git commit -m "feat(queries): deref-free content-type rollup helper"
```

---

## Task 6: Thread content-type into the context-budget read path

**Files:**
- Modify: `apps/axctl/src/queries/context-budget.ts` (extend `ContextBudgetResult` + `fetchContextBudget`)
- Test: `apps/axctl/src/queries/context-budget.test.ts` (if present; else add a focused test file)

This is the headline read surface. The `/api/context/budget` handler already maps `fetchContextBudget` to JSON, so attaching a field auto-exposes it; no handler change required.

- [ ] **Step 1: Write/extend the failing test**

```typescript
// apps/axctl/src/queries/context-budget.test.ts (add this test; create the file if absent)
import { describe, expect, test } from "bun:test";
import type { ContextBudgetResult } from "./context-budget.ts";

describe("ContextBudgetResult", () => {
  test("carries a contentTypes breakdown field", () => {
    // type-level assertion: the field must exist and be the breakdown shape
    const sample: ContextBudgetResult["contentTypes"] = {
      rows: [{ category: "code", calls: 1, bytes: 4, estTokens: 1, tokenShare: 1 }],
      totals: { calls: 1, bytes: 4, estTokens: 1 },
    };
    expect(sample.rows[0].category).toBe("code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/context-budget.test.ts`
Expected: FAIL - `Property 'contentTypes' does not exist on type 'ContextBudgetResult'` (a type error at test compile).

- [ ] **Step 3: Extend the result + the query**

In `apps/axctl/src/queries/context-budget.ts`:

a) import the helper at the top:
```typescript
import { fetchContentTypeBreakdown, type ContentTypeBreakdown } from "./content-types.ts";
```

b) add the field to the `ContextBudgetResult` interface:
```typescript
  /** content-type distribution of tool outputs (token-weighted). */
  readonly contentTypes: ContentTypeBreakdown;
```

c) inside `fetchContextBudget`, add the helper to the existing `Effect.all` batch and attach it. The function already does `Effect.all([...], { concurrency: 3 })`; add a fourth element and bump concurrency:
```typescript
    const [rawRes, summaryRes, recentRes, contentTypes] = yield* Effect.all([
      db.query<[Array<Record<string, unknown>>]>(BUDGET_SQL),
      db.query<[Array<Record<string, unknown>>]>(UNUSED_SUMMARY_SQL),
      db.query<[Array<Record<string, unknown>>]>(UNUSED_RECENT_SQL(WINDOW_DAYS)),
      fetchContentTypeBreakdown(),
    ], { concurrency: 4 });
```
and add `contentTypes` to the returned object:
```typescript
    return { skills, sources, totals, contentTypes } satisfies ContextBudgetResult;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test apps/axctl/src/queries/context-budget.test.ts && bun run typecheck`
Expected: PASS + clean typecheck.

Run (smoke the live endpoint, daemon must be up):
```bash
curl -s http://127.0.0.1:1738/api/context/budget | jq '.contentTypes.rows[:5]'
```
Expected: top content-type rows with category/estTokens/tokenShare.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/context-budget.ts apps/axctl/src/queries/context-budget.test.ts
git commit -m "feat(context-budget): content-type breakdown facet"
```

**=== Phase 1 ship point. The signal is captured and visible on the headline surface. Tasks 7-10 are independent add-ons. ===**

---

## Task 7: Content-type dimension on cost split

**Files:**
- Modify: `apps/axctl/src/queries/cost-analytics.ts`
- Test: `apps/axctl/src/queries/cost-analytics.test.ts` (add a focused test)

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/axctl/src/queries/cost-analytics.test.ts
import { attachContentMix } from "./cost-analytics.ts";

test("attachContentMix folds per-session content mix into cost rows", () => {
  const rows = [{ session: "session:s1", model: "opus", cost_usd: 1.0 }];
  const mix = [{ sessionId: "session:s1", mix: { rows: [{ category: "code", calls: 1, bytes: 8, estTokens: 2, tokenShare: 1 }], totals: { calls: 1, bytes: 8, estTokens: 2 } } }];
  const out = attachContentMix(rows as never, mix as never);
  expect(out[0].topContentType).toBe("code");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/queries/cost-analytics.test.ts`
Expected: FAIL - `attachContentMix` not exported.

- [ ] **Step 3: Implement the pure fold**

In `apps/axctl/src/queries/cost-analytics.ts`, add:
```typescript
import type { SessionContentMix } from "./content-types.ts";

export const attachContentMix = <T extends { readonly session: string }>(
  rows: ReadonlyArray<T>,
  mixes: ReadonlyArray<SessionContentMix>,
): Array<T & { topContentType: string | null }> => {
  const byId = new Map(mixes.map((m) => [m.sessionId, m.mix.rows[0]?.category ?? null]));
  return rows.map((r) => ({ ...r, topContentType: byId.get(r.session) ?? null }));
};
```
Then in the cost-split query function, call `fetchSessionContentMix()` alongside the existing query and pass both through `attachContentMix` before returning. Add `topContentType` to the row output type.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/axctl/src/queries/cost-analytics.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/cost-analytics.ts apps/axctl/src/queries/cost-analytics.test.ts
git commit -m "feat(cost): content-type dimension on cost split"
```

---

## Task 8: `--type` filter on recall

**Files:**
- Modify: `apps/axctl/src/cli/commands/recall.ts`
- Test: `apps/axctl/src/cli/commands/recall.test.ts` (add a parse test)

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/axctl/src/cli/commands/recall.test.ts
import { parseTypeFlag } from "./recall.ts";

test("parseTypeFlag splits CSV and rejects unknown categories", () => {
  expect(parseTypeFlag("code,json")).toEqual(["code", "json"]);
  expect(() => parseTypeFlag("code,bogus")).toThrow(/unknown content type/);
  expect(parseTypeFlag(null)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/cli/commands/recall.test.ts`
Expected: FAIL - `parseTypeFlag` not exported.

- [ ] **Step 3: Implement, mirroring parseSourcesFlag**

In `apps/axctl/src/cli/commands/recall.ts` add, next to `parseSourcesFlag`:
```typescript
import { ALL_CONTENT_CATEGORIES } from "../../ingest/content-type-classify.ts";
const VALID_TYPES = new Set<string>(ALL_CONTENT_CATEGORIES);

export function parseTypeFlag(raw: string | null): ReadonlyArray<string> | null {
  if (!raw) return null;
  const parts = parseCsvFlag(raw);
  const invalid = parts.filter((p) => !VALID_TYPES.has(p));
  if (invalid.length > 0) fail(`unknown content type(s): ${invalid.join(", ")}.`);
  return parts;
}
```
Then thread the parsed types into the turn query. Keep it deref-free: pre-query
`SELECT type::string(session) AS sid FROM has_content WHERE out.category IN [...]`
into a session-id set and filter turns by that set in JS, matching the recall
scope-filter idiom. Do NOT add graph derefs to the turn full-text query.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/axctl/src/cli/commands/recall.test.ts && bun run apps/axctl/bin/axctl recall "session" --type=code`
Expected: parse test PASS; command returns code-typed hits only.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/commands/recall.ts apps/axctl/src/cli/commands/recall.test.ts
git commit -m "feat(recall): --type content-type filter"
```

---

## Task 9: Content-type facet on insights (friction / churn)

**Files:**
- Modify: `apps/axctl/src/queries/insights.ts` (or the friction query module it delegates to)
- Test: the existing insights test file (add a focused case)

- [ ] **Step 1: Write the failing test**

```typescript
// add to the insights/friction test file
import { foldContentTypeOntoFriction } from "./insights.ts";

test("friction rows gain content_type of the failing tool output", () => {
  const friction = [{ session: "session:s1", toolCallId: "tool_call:a" }];
  const byTc = new Map([["tool_call:a", "unknown"]]);
  const out = foldContentTypeOntoFriction(friction as never, byTc);
  expect(out[0].contentType).toBe("unknown");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/queries/insights.test.ts`
Expected: FAIL - export missing.

- [ ] **Step 3: Implement the fold + the lookup query**

Add to `insights.ts`:
```typescript
export const foldContentTypeOntoFriction = <T extends { readonly toolCallId: string }>(
  rows: ReadonlyArray<T>,
  byToolCall: ReadonlyMap<string, string>,
): Array<T & { contentType: string | null }> =>
  rows.map((r) => ({ ...r, contentType: byToolCall.get(r.toolCallId) ?? null }));
```
Feed it from a flat lookup:
```sql
SELECT type::string(in) AS tid, type::string(out) AS ct FROM has_content;
```
mapped into `Map<tid, category>` (strip the `content_type:` prefix). Surfaces the spike's "unknown -> 42% error" signal directly in the friction view.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/axctl/src/queries/insights.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/insights.ts apps/axctl/src/queries/insights.test.ts
git commit -m "feat(insights): content-type facet on friction"
```

---

## Task 10: `tool-output-mix` profile taste pattern

**Files:**
- Modify: `apps/axctl/src/profile/schema.ts` (add the category) + the profile builder module that assembles patterns
- Test: the profile builder test file

- [ ] **Step 1: Write the failing test**

```typescript
// add to the profile builder test (use the actual builder path)
import { buildToolOutputMixPattern } from "./builder.ts";

test("builds a tool-output-mix pattern from the content breakdown", () => {
  const p = buildToolOutputMixPattern({
    rows: [
      { category: "code", calls: 10, bytes: 800, estTokens: 200, tokenShare: 0.8 },
      { category: "text", calls: 5, bytes: 200, estTokens: 50, tokenShare: 0.2 },
    ],
    totals: { calls: 15, bytes: 1000, estTokens: 250 },
  }, 42);
  expect(p?.category).toBe("tool-output-mix");
  expect(p?.summary).toContain("code");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/profile/builder.test.ts`
Expected: FAIL - export missing.

- [ ] **Step 3: Add the category + builder**

In `apps/axctl/src/profile/schema.ts` add `"tool-output-mix"` to `PATTERN_CATEGORIES` and (if patterns are a discriminated union) add a struct variant carrying `mix: Array<{category, share}>`. Then in the builder:
```typescript
import type { ContentTypeBreakdown } from "../queries/content-types.ts";

export const buildToolOutputMixPattern = (
  breakdown: ContentTypeBreakdown,
  sessions: number,
) => {
  const top = breakdown.rows.slice(0, 3);
  if (top.length === 0) return null;
  const lead = top[0];
  return {
    category: "tool-output-mix" as const,
    name: `${lead.category}-heavy context`,
    summary: `Context is ${Math.round(lead.tokenShare * 100)}% ${lead.category} by tokens (${top.map((r) => r.category).join(", ")}).`,
    mix: top.map((r) => ({ category: r.category, share: Number(r.tokenShare.toFixed(2)) })),
    evidence: { sessions, confidence: 0.9 },
  };
};
```
Wire it into the pattern assembly (call `fetchContentTypeBreakdown()` where the builder gathers its inputs, push the non-null pattern). This is the "org"/community read surface - it flows into the published ProfileV1 + leaderboard automatically.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/axctl/src/profile/builder.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/schema.ts apps/axctl/src/profile/builder.ts apps/axctl/src/profile/builder.test.ts
git commit -m "feat(profile): tool-output-mix taste pattern"
```

---

## Final verification (after all tasks)

- [ ] `bun test` (repo-wide) - all green.
- [ ] `bun run typecheck` - clean.
- [ ] `bun run apps/axctl/bin/axctl ingest --stages=content-types` then re-run - second run reports nearly all `skipped` (idempotency).
- [ ] `curl -s http://127.0.0.1:1738/api/context/budget | jq '.contentTypes'` - populated.
- [ ] No em-dash characters introduced (the repo write-hook rejects them); no emoji.

---

## Notes / deferred

- **Real cost (USD) per content-type** is dormant until `telemetry_of` edges exist in the DB (currently 0). The bytes/4 est-token proxy ships now; when telemetry lands, extend the helper with a `session -> telemetry_of -> otel_*` cost join (same dark-then-lit pattern as the telemetry-insight enrichment PR). Do NOT block this plan on it.
- **Magika upgrade** (optional, later): add a `local_model` ClassifierDefinition that re-scores low-confidence (`fallback`/`sniff`) edges only. Keep it out of the hot ingest path; the deterministic classifier stays the default.
- **Studio rendering** of the content-type breakdown (a tile on the context-budget view) is a thin follow-up once Task 6 exposes the field; not required for the data to be correct.
