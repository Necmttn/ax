# Godfile Carve: classifiers-workflow-candidates.ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behavior-preserving carve of the 9,074-line `apps/axctl/src/cli/classifiers-workflow-candidates.ts` into two sibling modules (types + pure helpers) with the original file kept as a barrel, zero import-site changes.

**Architecture:** An AST-driven extraction script (TypeScript compiler API) partitions the file's top-level statements into three buckets: (1) type/interface declarations with no `typeof` → `apps/axctl/src/classifiers/workflow-candidate-types.ts`; (2) all other statements whose text does NOT reference impure markers (Effect execution, SurrealClient, FileSystem, ClassifierReviewPipelineService values, catchDbErrorAndExit, process/console) → `apps/axctl/src/classifiers/workflow-candidate-helpers.ts`; (3) the 7 impure statements stay in the original file, which gains `export * from` barrels plus imports for the moved symbols it still uses. Statement order is preserved within each bucket; leading comments travel with their statement (via `getFullStart`). Previously-private moved symbols gain `export` so the barrel + godfile imports resolve.

**Tech Stack:** bun ≥1.3, TypeScript compiler API (already a repo dep), bun:test.

## Global Constraints (from BRIEF.md)

- No logic changes: identical function bodies, names, signatures (adding `export ` prefix to moved private symbols is the ONLY permitted text change).
- No edits to the 3 importers (`cli/commands/classifiers.ts`, `classifiers/review-pipeline-service.ts`, `classifiers/package-service.ts`).
- Only touch: the godfile, the new sibling modules under `apps/axctl/src/classifiers/`, and (only if forced) the characterization test.
- Gates: `bun run typecheck` exit 0; `bun test apps/axctl/src/cli/classifiers-workflow-candidates.test.ts` green with **76 pass / 0 fail** (baseline recorded 2026-07-16); `bun run check:no-node-fs` exit 0.
- All work from the worktree `/Users/necmttn/Projects/ax/.claude/worktrees/refactor-godfile`.

## Analysis already performed (do not redo)

- Baseline characterization suite: **76 pass, 0 fail, 646 expect() calls** on untouched file.
- 326 top-level symbols: 125 type/interface (~1,375 lines), 194 pure value symbols (~6,266 lines), 7 impure symbols (~1,408 lines): `loadWorkflowCandidatePendingReviewTurnContexts` (priv), `listMarkdownFiles` (priv), `loadWorkflowCandidateGuidancePendingReviewTaskListReport`, `readWorkflowCandidateHelperFixtures`, `withWorkflowCandidateReviewPipelineLifecycle`, `withWorkflowCandidateReviewCoverageApplySummaryLifecycle`, `runClassifiersWorkflowCandidates`.
- Transitive closure verified: **no pure/type symbol references any impure symbol** - dependency direction is strictly impure → pure → types. So the carve cannot create a runtime cycle: types has zero runtime imports, helpers imports types type-only, godfile imports both.
- Type block references `ClassifierReviewPipelineInputValues/LifecycleReport/OutputVerifier` (type-only) from `review-pipeline-service.ts`, which itself imports the godfile - this cycle is type-level only and erased at compile.
- Name-domain split of helpers is cyclic; positional split blocked by forward refs spanning lines 1569–6379. Hence ONE helpers module, order preserved.
- `apps/axctl/tsconfig.json` has `noUnusedLocals: true` → unused imports must be trimmed (script computes per-file imports from actual identifier usage).

---

### Task 1: AST extraction script + emit the three files

**Files:**
- Create: `scripts/tmp-carve-workflow-candidates.ts` (throwaway; delete before commit - do NOT commit it)
- Create (emitted): `apps/axctl/src/classifiers/workflow-candidate-types.ts`
- Create (emitted): `apps/axctl/src/classifiers/workflow-candidate-helpers.ts`
- Modify (emitted): `apps/axctl/src/cli/classifiers-workflow-candidates.ts`

**Interfaces:**
- Produces: `workflow-candidate-types.ts` (exported type/interface decls), `workflow-candidate-helpers.ts` (exported pure values + typeof-bearing types), godfile = imports + `export *` barrels + 7 impure statements verbatim.

- [ ] **Step 1: Write the extraction script**

Write exactly this to `scripts/tmp-carve-workflow-candidates.ts`:

```ts
import ts from "typescript";

const FILE = "apps/axctl/src/cli/classifiers-workflow-candidates.ts";
const TYPES_OUT = "apps/axctl/src/classifiers/workflow-candidate-types.ts";
const HELPERS_OUT = "apps/axctl/src/classifiers/workflow-candidate-helpers.ts";

const src = await Bun.file(FILE).text();
const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);

const IMPURE_RE =
    /\b(Effect\.|SurrealClient\b|FileSystem\b|ClassifierReviewPipelineService\b|ClassifierReviewPipelineServiceLive\b|nodeFileOutputVerifier\b|catchDbErrorAndExit\b|process\.|console\.)/;

interface Stmt {
    node: ts.Statement;
    text: string; // full text incl. leading comments
    names: string[];
    exported: boolean;
    bucket: "import" | "types" | "helpers" | "impure";
}

const stmts: Stmt[] = [];
for (const node of sf.statements) {
    const text = src.slice(node.getFullStart(), node.end);
    const names: string[] = [];
    let exported = false;
    if (ts.isImportDeclaration(node)) {
        stmts.push({ node, text, names, exported, bucket: "import" });
        continue;
    }
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    exported = !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
        if (node.name) names.push(node.name.text);
    } else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) names.push(d.name.text);
        }
    }
    const isTypeDecl = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
    let bucket: Stmt["bucket"];
    if (IMPURE_RE.test(text)) bucket = "impure";
    else if (isTypeDecl && !/\btypeof\b/.test(text)) bucket = "types";
    else bucket = "helpers";
    stmts.push({ node, text, names, exported, bucket });
}

const byBucket = (b: Stmt["bucket"]) => stmts.filter((s) => s.bucket === b);
console.log("import:", byBucket("import").length, "types:", byBucket("types").length, "helpers:", byBucket("helpers").length, "impure:", byBucket("impure").length);
const impureNames = byBucket("impure").flatMap((s) => s.names);
console.log("impure names:", impureNames.join(", "));
if (impureNames.length !== 7) throw new Error("expected exactly 7 impure symbols, got " + impureNames.length);

// map: exported binding name -> its original import statement + module specifier
interface ImportBinding { name: string; typeOnly: boolean; module: string; }
const importBindings: ImportBinding[] = [];
for (const s of byBucket("import")) {
    const node = s.node as ts.ImportDeclaration;
    const module = (node.moduleSpecifier as ts.StringLiteral).text;
    const clause = node.importClause;
    if (!clause) continue;
    const clauseTypeOnly = clause.isTypeOnly;
    if (clause.name) importBindings.push({ name: clause.name.text, typeOnly: clauseTypeOnly, module });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
            importBindings.push({ name: el.name.text, typeOnly: clauseTypeOnly || el.isTypeOnly, module });
        }
    }
}

const wordRe = (n: string) => new RegExp("\\b" + n + "\\b");
const usesName = (body: string, n: string) => wordRe(n).test(body);

// module specifier rewrite: original file lives in cli/, new files in classifiers/
const rewriteForClassifiers = (m: string) => (m.startsWith("../classifiers/") ? "./" + m.slice("../classifiers/".length) : m.startsWith("./") ? "../cli/" + m.slice(2) : m);

function importBlockFor(body: string, dir: "classifiers" | "cli"): string {
    const used = importBindings.filter((b) => usesName(body, b.name));
    const byModule = new Map<string, ImportBinding[]>();
    for (const b of used) {
        const m = dir === "classifiers" ? rewriteForClassifiers(b.module) : b.module;
        (byModule.get(m) ?? byModule.set(m, []).get(m)!).push(b);
    }
    const lines: string[] = [];
    for (const [m, bs] of byModule) {
        const allType = bs.every((b) => b.typeOnly);
        const specs = bs.map((b) => (b.typeOnly && !allType ? "type " + b.name : b.name)).join(", ");
        lines.push(`import ${allType ? "type " : ""}{ ${specs} } from "${m}";`);
    }
    return lines.join("\n");
}

const typesBody = byBucket("types").map((s) => s.text).join("");
const helpersBodyRaw = byBucket("helpers").map((s) =>
    s.exported ? s.text : s.text.replace(/^(\s*)(function|const|interface|type|class|enum|async function)\b/m, "$1export $2"),
).join("");

// names defined in each new module
const typeNames = byBucket("types").flatMap((s) => s.names);
const helperNames = byBucket("helpers").flatMap((s) => s.names);

// types module: external imports only (type-only refs into review-pipeline-service)
const typesImports = importBlockFor(typesBody, "classifiers");
const typesFile = (typesImports ? typesImports + "\n" : "") + typesBody.replace(/^\n+/, "") + "\n";

// helpers module: external imports + type imports from types module
const helpersExternalImports = importBlockFor(helpersBodyRaw, "classifiers");
const usedTypeNames = typeNames.filter((n) => usesName(helpersBodyRaw, n));
const helpersTypeImport = usedTypeNames.length
    ? `import type {\n${usedTypeNames.map((n) => "    " + n + ",").join("\n")}\n} from "./workflow-candidate-types.ts";`
    : "";
const helpersFile = [helpersExternalImports, helpersTypeImport].filter(Boolean).join("\n") + "\n" + helpersBodyRaw.replace(/^\n+/, "") + "\n";

// godfile: original imports filtered to impure usage + imports of moved symbols + barrels + impure statements
const impureBody = byBucket("impure").map((s) => s.text).join("");
const godExternalImports = importBlockFor(impureBody, "cli");
const usedHelperNames = helperNames.filter((n) => usesName(impureBody, n));
const usedTypeNamesInGod = typeNames.filter((n) => usesName(impureBody, n));
const godHelperImport = usedHelperNames.length
    ? `import {\n${usedHelperNames.map((n) => "    " + n + ",").join("\n")}\n} from "../classifiers/workflow-candidate-helpers.ts";`
    : "";
const godTypeImport = usedTypeNamesInGod.length
    ? `import type {\n${usedTypeNamesInGod.map((n) => "    " + n + ",").join("\n")}\n} from "../classifiers/workflow-candidate-types.ts";`
    : "";
const godFile = [
    godExternalImports,
    godHelperImport,
    godTypeImport,
    `export * from "../classifiers/workflow-candidate-types.ts";`,
    `export * from "../classifiers/workflow-candidate-helpers.ts";`,
].filter(Boolean).join("\n") + "\n" + impureBody.replace(/^\n+/, "") + "\n";

await Bun.write(TYPES_OUT, typesFile);
await Bun.write(HELPERS_OUT, helpersFile);
await Bun.write(FILE, godFile);
console.log("types lines:", typesFile.split("\n").length, "helpers lines:", helpersFile.split("\n").length, "godfile lines:", godFile.split("\n").length);
```

- [ ] **Step 2: Run it and sanity-check the console output**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/refactor-godfile && bun run scripts/tmp-carve-workflow-candidates.ts`

Expected: `impure names:` lists exactly the 7 symbols from the Analysis section (order may differ); throws otherwise. Line counts printed: godfile should land ~1,400–1,600, types ~1,300–1,500, helpers ~6,000–6,500.

- [ ] **Step 3: Verify no source lines were lost**

Run: `git stash list >/dev/null; wc -l apps/axctl/src/classifiers/workflow-candidate-{types,helpers}.ts apps/axctl/src/cli/classifiers-workflow-candidates.ts`

Expected: the three files sum to ≈ 9,074 + (number of new import/barrel lines) − (removed original import lines). A deficit of hundreds of lines = statements dropped → STOP, investigate.

### Task 2: Gates green (typecheck-driven import repair)

**Files:**
- Modify (only if tsc demands): the two new modules' import blocks + godfile import block. NEVER touch function/type bodies, the 3 importers, or the test file.

- [ ] **Step 1: Run characterization suite**

Run: `bun test apps/axctl/src/cli/classifiers-workflow-candidates.test.ts`
Expected: **76 pass, 0 fail**. Any other count = FAIL (investigate; do not edit the test).

- [ ] **Step 2: Run typecheck, capture the real exit code**

Run: `bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0`. If errors: they will be missing/unused imports in the three touched files (the identifier-scan heuristic can over/under-include, e.g. names appearing only inside strings/comments). Fix ONLY import lines. If an error demands a body change or an importer edit → STOP and write REPORT.md per the brief's escape hatches.

- [ ] **Step 3: no-node-fs gate**

Run: `bun run check:no-node-fs; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 4: Delete the throwaway script**

Run: `rm scripts/tmp-carve-workflow-candidates.ts`

### Task 3: Commit + signal (orchestrator-owned review; no push/PR)

- [ ] **Step 1: Verify worktree + stage**

Run: `pwd` (must be the worktree) then `git status --short` - expect only: modified godfile, 2 new modules, this plan file. `BRIEF.md` stays uncommitted.

- [ ] **Step 2: Commit**

```bash
git add apps/axctl/src/cli/classifiers-workflow-candidates.ts apps/axctl/src/classifiers/workflow-candidate-types.ts apps/axctl/src/classifiers/workflow-candidate-helpers.ts docs/superpowers/plans/2026-07-16-refactor-godfile-carve.md
git commit -m "refactor(axctl): carve classifiers-workflow-candidates godfile into types + pure-helpers modules

Behavior-preserving barrel carve: type/interface block -> classifiers/workflow-candidate-types.ts,
pure helpers -> classifiers/workflow-candidate-helpers.ts; original path re-exports everything,
7 impure symbols (Effect/SurrealClient/pipeline) stay in place. No import-site changes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Signal**

```bash
echo "$(date -Iseconds) refactor-godfile DONE carved 9074-line godfile -> types+helpers modules, barrel preserved, 76/76 green" >> /tmp/fleet-ax-improve.signals
```

(On failure use BLOCKED/ERROR + write REPORT.md at worktree root first.)

## Self-Review Notes

- Spec coverage: characterize-first ✅ (baseline recorded), low-risk groups only ✅ (impure stays), barrel ✅, no importer edits ✅, gates ✅, commit+signal ✅.
- Escape hatches wired into Task 2 Step 2.
- Type-consistency: bucket names (`types`/`helpers`/`impure`) used consistently; the 7 impure names asserted in-script.
