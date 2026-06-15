# ax dojo report + outbox writers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `ax dojo report` / `ax dojo draft` / `ax dojo outbox` and restructure `ax dojo` (agenda) into a command family, per spec `docs/superpowers/specs/2026-06-13-dojo-report-outbox-design.md`.

**Architecture:** Pure cores (slugify/shortHash, frontmatter parse, report render) unit-tested; Effect glue (FS writers, two graph queries, gatherReport) tested with BunFileSystem + the fake-SurrealClient harness from `improve/show.test.ts`. The agenda leaf becomes `ax dojo agenda`; the new writers are db-conditional subcommands.

**Tech Stack:** bun ≥1.3, TS strict, Effect v4 beta (`effect/unstable/cli`), bun:test, SurrealDB via `SurrealClient`.

**Conventions:** Run from worktree root `/Users/necmttn/Projects/ax/.claude/worktrees/dojo-report`. Test = `bun test <path>` (tmp wrapper if a hook blocks bare `bun test`). Repo bans `node:fs`/`node:path` in apps - use `@ax/lib/shared/path` `posixPath` + `node:os` `homedir` (see `apps/axctl/src/dojo/paths.ts`). FileSystem via `effect/platform/FileSystem` (mirror `apps/axctl/src/dojo/briefs.ts`). Em-dashes normalize to `-`. Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: slug + shortHash (pure)

**Files:** Create `apps/axctl/src/dojo/slug.ts`, `apps/axctl/src/dojo/slug.test.ts`

- [ ] **Step 1: failing test**

```ts
// apps/axctl/src/dojo/slug.test.ts
import { describe, expect, test } from "bun:test";
import { shortHash, slugify } from "./slug.ts";

describe("slugify", () => {
    test("kebabs, lowercases, strips punctuation, collapses dashes", () => {
        expect(slugify("Dojo: Fix the Briefs Scanner!")).toBe("dojo-fix-the-briefs-scanner");
    });
    test("truncates to 50 chars without trailing dash", () => {
        const s = slugify("a".repeat(80));
        expect(s.length).toBeLessThanOrEqual(50);
        expect(s.endsWith("-")).toBe(false);
    });
    test("empty / punctuation-only -> 'draft'", () => {
        expect(slugify("")).toBe("draft");
        expect(slugify("!!!")).toBe("draft");
    });
});

describe("shortHash", () => {
    test("deterministic 8-hex for the same input", () => {
        expect(shortHash("hello")).toBe(shortHash("hello"));
        expect(shortHash("hello")).toMatch(/^[0-9a-f]{8}$/);
    });
    test("different inputs differ", () => {
        expect(shortHash("a")).not.toBe(shortHash("b"));
    });
});
```

- [ ] **Step 2: run -> FAIL** (`bun test apps/axctl/src/dojo/slug.test.ts`)

- [ ] **Step 3: implement**

```ts
// apps/axctl/src/dojo/slug.ts
/** kebab-case slug, <=50 chars, never empty (falls back to "draft"). */
export const slugify = (title: string): string => {
    const base = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50)
        .replace(/-+$/g, "");
    return base.length > 0 ? base : "draft";
};

/** FNV-1a 32-bit, 8-hex. Stable, dependency-free; not for security. */
export const shortHash = (input: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
};
```

- [ ] **Step 4: run -> PASS**
- [ ] **Step 5: commit** `feat(dojo): slugify + shortHash helpers`

---

### Task 2: outbox draft type + writer + lister

**Files:** Create `apps/axctl/src/dojo/outbox.ts`, `apps/axctl/src/dojo/outbox.test.ts`

READ FIRST: `apps/axctl/src/dojo/briefs.ts` (FileSystem import + classifyNoFollow pattern), `apps/axctl/src/improve/actions.ts` ~lines 443-451 (atomic tmp+rename write), `apps/axctl/src/dojo/paths.ts` (dojoOutboxDir).

- [ ] **Step 1: failing test**

```ts
// apps/axctl/src/dojo/outbox.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { listDrafts, parseDraftFrontmatter, writeDraft } from "./outbox.ts";

describe("parseDraftFrontmatter", () => {
    test("extracts title/kind/created_at/session", () => {
        const md = "---\ntitle: Fix scanner\nkind: bug\ncreated_at: 2026-06-13T10:00:00.000Z\nsession: s1\n---\nbody\n";
        expect(parseDraftFrontmatter("x.md", md)).toEqual({
            file: "x.md", title: "Fix scanner", kind: "bug",
            created_at: "2026-06-13T10:00:00.000Z", session: "s1",
        });
    });
    test("missing optional session -> null; non-frontmatter -> null", () => {
        expect(parseDraftFrontmatter("y.md", "---\ntitle: T\nkind: improvement\ncreated_at: 2026-01-01T00:00:00Z\n---\n")?.session).toBeNull();
        expect(parseDraftFrontmatter("z.md", "no frontmatter")).toBeNull();
    });
});

describe("writeDraft + listDrafts", () => {
    test("writes a frontmatter draft and lists it back", async () => {
        const base = mkdtempSync(`${tmpdir()}/dojo-outbox-`);
        const run = <A>(e: Effect.Effect<A, unknown, any>) =>
            Effect.runPromise(e.pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A, unknown, never>);
        const written = await run(writeDraft({
            title: "Fix the scanner!", kind: "bug", body: "repro steps",
            session: "s1", nowMs: Date.parse("2026-06-13T10:00:00.000Z"), outboxDir: base,
        }));
        expect(written.path).toMatch(/fix-the-scanner-[0-9a-f]{8}\.md$/);
        const drafts = await run(listDrafts(base));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ title: "Fix the scanner!", kind: "bug", session: "s1" });
    });
    test("missing outbox dir -> []", async () => {
        const drafts = await Effect.runPromise(
            listDrafts("/no/such/dir").pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<any, unknown, never>,
        );
        expect(drafts).toEqual([]);
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement** (mirror briefs.ts for FS import + classifyNoFollow skip-non-files in listDrafts; mirror actions.ts atomic write)

```ts
// apps/axctl/src/dojo/outbox.ts
import { Effect } from "effect";
import { FileSystem } from "effect/platform/FileSystem";
import { posixPath } from "@ax/lib/shared/path";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { dojoOutboxDir } from "./paths.ts";
import { shortHash, slugify } from "./slug.ts";

export type DraftKind = "bug" | "improvement";

export interface OutboxDraft {
    readonly file: string;
    readonly title: string;
    readonly kind: string;
    readonly created_at: string;
    readonly session: string | null;
}

export interface WriteDraftInput {
    readonly title: string;
    readonly kind: DraftKind;
    readonly body: string;
    readonly session?: string | null;
    readonly nowMs: number;
    readonly outboxDir?: string;
}

const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

/** Pure: parse a draft's frontmatter, or null when it isn't a frontmatter doc. */
export const parseDraftFrontmatter = (file: string, content: string): OutboxDraft | null => {
    if (!content.startsWith("---")) return null;
    const title = field(content, "title");
    const kind = field(content, "kind");
    const created_at = field(content, "created_at");
    if (!title || !kind || !created_at) return null;
    return { file, title, kind, created_at, session: field(content, "session") };
};

const render = (i: WriteDraftInput): string => {
    const fm = [
        "---",
        `title: ${i.title}`,
        `kind: ${i.kind}`,
        `created_at: ${new Date(i.nowMs).toISOString()}`,
        ...(i.session ? [`session: ${i.session}`] : []),
        "---",
        "",
    ].join("\n");
    return `${fm}${i.body}\n`;
};

export const writeDraft = (
    input: WriteDraftInput,
): Effect.Effect<{ path: string; slug: string }, unknown, FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const dir = input.outboxDir ?? dojoOutboxDir();
        yield* fs.makeDirectory(dir, { recursive: true });
        const slug = slugify(input.title);
        const name = `${slug}-${shortHash(input.title)}.md`;
        const path = posixPath.join(dir, name);
        const tmp = `${path}.tmp.${process.pid}`;
        yield* fs.writeFileString(tmp, render(input));
        yield* fs.rename(tmp, path);
        return { path, slug };
    });

export const listDrafts = (
    outboxDir: string = dojoOutboxDir(),
): Effect.Effect<OutboxDraft[], unknown, FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem;
        const exists = yield* fs.exists(outboxDir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [];
        const names = yield* fs.readDirectory(outboxDir).pipe(Effect.orElseSucceed(() => []));
        const drafts: OutboxDraft[] = [];
        for (const name of names) {
            if (!name.endsWith(".md")) continue;
            const full = posixPath.join(outboxDir, name);
            const kind = yield* classifyNoFollow(full);
            if (kind !== "File") continue;
            const content = yield* fs.readFileString(full).pipe(skipNotFound(null));
            if (content === null) continue;
            const draft = parseDraftFrontmatter(name, content);
            if (draft) drafts.push(draft);
        }
        return drafts.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
```

- [ ] **Step 4: run -> PASS**; then `bun run typecheck` (resolve any real FileSystem-API drift against briefs.ts).
- [ ] **Step 5: commit** `feat(dojo): outbox draft writer + lister`

---

### Task 3: report graph queries

**Files:** Create `apps/axctl/src/improve/report-queries.ts`, `apps/axctl/src/improve/report-queries.test.ts`

READ FIRST: `apps/axctl/src/improve/verdict-pending.ts` (query shape, SurrealClient/DbError imports, created_at-in-projection-then-strip pattern), `apps/axctl/src/improve/show.test.ts` (fake client harness).

Schema facts: `proposal.created_at` (datetime), `checkpoint.observed_at` (datetime) + `checkpoint.user_verdict` (option<string>) + `checkpoint.experiment` (record). SurrealDB 3.0 requires any ORDER BY field to be in the projection (per verdict-pending.ts lesson). Datetime comparison: bind the cutoff as a `Date` (SDK passes JS Date), e.g. `WHERE created_at >= $since`.

- [ ] **Step 1: failing test** -- two queries, each returning rows for a populated fake and `[]` for empty. Mirror verdict-pending.test.ts exactly for the harness.

```ts
// apps/axctl/src/improve/report-queries.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { listProposalsCreatedSince, listVerdictsLockedSince } from "./report-queries.ts";
// copy layerWith / fake-client harness from show.test.ts

describe("listProposalsCreatedSince", () => {
    test("maps rows to {id, title, form, dedupe_sig}", async () => {
        const client = fakeClient([[{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" }]]);
        const rows = await Effect.runPromise(
            listProposalsCreatedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(client.layer)),
        );
        expect(rows).toEqual([{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" }]);
    });
});

describe("listVerdictsLockedSince", () => {
    test("maps rows to {verdict, title, sig}", async () => {
        const client = fakeClient([[{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" }]]);
        const rows = await Effect.runPromise(
            listVerdictsLockedSince(new Date("2026-06-13T00:00:00Z")).pipe(Effect.provide(client.layer)),
        );
        expect(rows).toEqual([{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" }]);
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement** (copy import lines + query-call shape from verdict-pending.ts; strip any projection-only fields in JS)

```ts
// apps/axctl/src/improve/report-queries.ts
import { Effect } from "effect";
// SurrealClient from "@ax/lib/db"; DbError type from "@ax/lib/errors" - copy verdict-pending.ts exactly

export interface CreatedProposalRow {
    readonly id: string; readonly title: string;
    readonly form: string; readonly dedupe_sig: string;
}
export interface LockedVerdictRow {
    readonly verdict: string; readonly title: string; readonly sig: string;
}

export const listProposalsCreatedSince = (since: Date): Effect.Effect<CreatedProposalRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const r = yield* db.query<[Array<CreatedProposalRow & { created_at?: string }>]>(
            `SELECT type::string(id) AS id, title, form, dedupe_sig, type::string(created_at) AS created_at
             FROM proposal WHERE created_at >= $since ORDER BY created_at ASC LIMIT 50;`,
            { since },
        );
        return (r?.[0] ?? []).map(({ created_at, ...row }) => row);
    });

export const listVerdictsLockedSince = (since: Date): Effect.Effect<LockedVerdictRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const r = yield* db.query<[Array<LockedVerdictRow & { observed_at?: string }>]>(
            `SELECT user_verdict AS verdict, experiment.proposal.title AS title,
                    experiment.proposal.dedupe_sig AS sig, type::string(observed_at) AS observed_at
             FROM checkpoint WHERE user_verdict IS NOT NONE AND observed_at >= $since
             ORDER BY observed_at ASC LIMIT 50;`,
            { since },
        );
        return (r?.[0] ?? []).map(({ observed_at, ...row }) => row);
    });
```

VERIFY the exact `db.query` arg shape (does it take a bindings object? check verdict-pending.ts / list.ts - if those queries don't pass a second bindings arg, inline the cutoff via the repo's datetime literal helper instead, e.g. `d"<iso>"` or a surql helper; adapt and note in report). Smoke against the live DB if up: both queries must parse and return without error.

- [ ] **Step 4: run -> PASS**; typecheck clean.
- [ ] **Step 5: commit** `feat(improve): report queries - proposals created + verdicts locked since`

---

### Task 4: report data + render

**Files:** Create `apps/axctl/src/dojo/report.ts`, `apps/axctl/src/dojo/report.test.ts`

- [ ] **Step 1: failing test** -- renderReport is pure over a ReportData struct.

```ts
// apps/axctl/src/dojo/report.test.ts
import { describe, expect, test } from "bun:test";
import { renderReport } from "./report.ts";
import type { ReportData } from "./report.ts";

const data: ReportData = {
    date: "2026-06-13",
    since: "2026-06-13T02:00:00.000Z",
    generated_at: "2026-06-13T05:00:00.000Z",
    budgetLine: "12% spendable (7d window, 27% left) [quota]",
    verdicts: [{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" }],
    proposals: [{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" }],
    drafts: [{ file: "fix-x-deadbeef.md", title: "Fix X", kind: "bug", created_at: "2026-06-13T04:00:00.000Z", session: null }],
    notes: "ran 4 laps",
};

describe("renderReport", () => {
    test("renders all sections with counts", () => {
        const md = renderReport(data);
        expect(md).toContain("# Dojo report - 2026-06-13");
        expect(md).toContain("ending budget: 12% spendable");
        expect(md).toContain("## Verdicts locked (1)");
        expect(md).toContain("- confirmed");
        expect(md).toContain("## Proposals created (1)");
        expect(md).toContain("## Outbox drafts pending review (1)");
        expect(md).toContain("## Notes\nran 4 laps");
    });
    test("empty sections render '- (none)' and no Notes header when notes empty", () => {
        const md = renderReport({ ...data, verdicts: [], proposals: [], drafts: [], notes: "" });
        expect(md).toContain("## Verdicts locked (0)\n- (none)");
        expect(md).not.toContain("## Notes");
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement** -- `ReportData` type, pure `renderReport`, and `gatherReport` Effect glue that runs the two queries + listDrafts + getQuota under `soft`-style isolation (reuse the failure-tolerant pattern: a failing source yields its empty value; never abort). gatherReport signature:

```ts
export interface GatherReportInput {
    readonly sinceMs: number;
    readonly nowMs: number;
    readonly notes: string;
    readonly outboxDir?: string;
}
export const gatherReport = (input: GatherReportInput): Effect.Effect<ReportData, never, SurrealClient | FileSystem>
```

`gatherReport` builds `budgetLine` by calling `getQuota` (degrade to "unavailable") + `computeBudgetEnvelope` (reuse from budget.ts) and formatting the binding window line (factor the budget-line formatting out of `format.ts`'s `renderAgenda` if it isn't already reusable; otherwise inline a small formatter). `date` = local YYYY-MM-DD of nowMs. Provide `QuotaEnvLive` at the CLI layer, not here (keep gatherReport's R channel `SurrealClient | FileSystem | QuotaEnv` if getQuota needs it - match how the agenda command provides QuotaEnvLive).

- [ ] **Step 4: run -> PASS** (renderReport fully covered; gatherReport covered by a fake-client+BunFileSystem test if feasible, else by the CLI smoke in Task 5 - state which in the commit).
- [ ] **Step 5: commit** `feat(dojo): report data gather + render`

---

### Task 5: CLI restructure into a command family

**Files:** Modify `apps/axctl/src/cli/commands/dojo.ts`, `apps/axctl/src/cli/commands/dojo.test.ts`, `apps/axctl/src/cli/index.ts`

READ FIRST: `apps/axctl/src/cli/commands/ax-routing.ts` (handler-less root + `Command.withSubcommands` + db-conditional `RuntimeManifest`), the current `dojo.ts`.

- [ ] **Step 1: restructure dojo.ts**
  - Rename the existing leaf command body to `agendaCommand = Command.make("agenda", {...same flags...}, sameHandler)`.
  - Add `reportCommand = Command.make("report", { json, since: Flag.string("since").withDefault(""), notesFile: Flag.string("notes-file").withDefault("") }, handler)`. Handler: resolve sinceMs (parse `--since` ISO; default = start of local day from nowMs), read notes file if given (FileSystem, empty on absent), `gatherReport`, write `dojoReportPath(date)` (atomic), `console.log(json ? prettyPrint(data) : renderReport(data))`. Provide QuotaEnvLive.
  - Add `draftCommand = Command.make("draft", { json, title: Flag.string("title"), kind: Flag.string("kind"), bodyFile: Flag.string("body-file").withDefault(""), session: Flag.string("session").withDefault("") }, handler)`. Validate kind ∈ {bug, improvement} via `fail()` (mirror quota.ts validation). Body from `--body-file` (`-` => read stdin) or "". `writeDraft`, print path or `{path,slug,title,kind}`.
  - Add `outboxCommand = Command.make("outbox", { json }, handler)`: `listDrafts`, render a small table or JSON.
  - Root: `export const dojoCommand = Command.make("dojo").pipe(Command.withDescription("..."), Command.withSubcommands([agendaCommand, reportCommand, draftCommand, outboxCommand]))`.
  - `export const dojoRuntime: RuntimeManifest = { dojo: { runtime: { kind: "db-conditional", fallback: "none", subcommands: { agenda: "db", report: "db", draft: "none", outbox: "none" } }, hidden: false } }`.
  - Keep + export `untilToIso` (still used by agenda).

- [ ] **Step 2: index.ts** -- no change needed if `dojoCommand`/`dojoRuntime` names are unchanged (they're already imported + spread + registered). Confirm the spread of the new object-form manifest typechecks.

- [ ] **Step 3: tests** -- keep the `untilToIso` tests. Add a `dojo.test.ts` case asserting kind validation rejects a bad `--kind` (or test the validate helper directly if extracted). Run `bun test apps/axctl/src/cli/commands/dojo.test.ts` and `apps/axctl/src/cli/effect-cli.test.ts` -> PASS.

- [ ] **Step 4: smoke (DB up; scripts/db-start.sh if not)**
  - `bun apps/axctl/src/cli/index.ts dojo agenda --json` -> the old agenda JSON (v:1, budget, items). Confirm rename works.
  - `bun apps/axctl/src/cli/index.ts dojo draft --title "Test draft" --kind improvement` -> writes a file, prints path; then `bun apps/axctl/src/cli/index.ts dojo outbox` lists it. Clean up the test file after (`trash` the written outbox md).
  - `bun apps/axctl/src/cli/index.ts dojo report --json` -> ReportData JSON, empty sections fine; confirm `~/.ax/dojo/reports/<today>.md` written.
  Paste output snippets.

- [ ] **Step 5: commit** `feat(cli): ax dojo command family - agenda + report + draft + outbox`

---

### Task 6: docs gate + SKILL.md rename

**Files:** Modify `docs/cli.md`, `apps/site/public/llms.txt`, `CLAUDE.md`, `skills/dojo/SKILL.md`

- [ ] **Step 1: docs/cli.md** -- replace the single `dojo` line with the family:
```
axctl dojo agenda [--json|--spar|--budget=N|--until=HH:MM|--force|--days=N]   # training agenda
axctl dojo report [--since=<iso>|--json|--notes-file=<path>]                  # evidence-derived morning report
axctl dojo draft --title=<s> --kind=bug|improvement [--body-file=<path>]      # stage an upstream issue draft
axctl dojo outbox [--json]                                                    # list pending drafts
```
- [ ] **Step 2: llms.txt** -- update the dojo bullet to enumerate the four subcommands (one bullet, mention agenda/report/draft/outbox).
- [ ] **Step 3: CLAUDE.md** -- in the "### Dojo" section, change `ax dojo [...]` to `ax dojo agenda [...]` and append one sentence: "`ax dojo report` writes an evidence-derived morning report (verdicts locked + proposals created since, outbox drafts, ending budget); `ax dojo draft`/`ax dojo outbox` stage and list local upstream issue drafts (publish stays manual)."
- [ ] **Step 4: skills/dojo/SKILL.md** -- replace every `ax dojo --json` with `ax dojo agenda --json`; in the Exit/morning-report section, replace the hand-write instruction with: "Run `ax dojo report --since=<loop-start-iso> --notes-file=<your lap notes>` to write the receipt; it derives verdicts/proposals/outbox/budget. Stage upstream findings with `ax dojo draft --title=... --kind=bug|improvement` (never publish)."
- [ ] **Step 5: gate + commit**
  Run `bun run check:cli-reference` -> exit 0 (the family subcommands count as covered via the `dojo agenda`/`dojo report`/... lines; verify the checker matches `ax dojo` prefix - if it wants each leaf, ensure all four appear in llms.txt).
  Commit `docs(dojo): command-family reference + SKILL report/draft usage`.

---

### Task 7: verify + PR

- [ ] **Step 1** `bun test` (repo-wide) -> 0 fail.
- [ ] **Step 2** `bun run typecheck` -> clean (no new errors).
- [ ] **Step 3** `bun run check:cli-reference` + `bun scripts/check-no-node-fs.ts` -> clean.
- [ ] **Step 4** push + PR:
```bash
git push -u origin feat/dojo-report
gh pr create --title "feat: ax dojo report + outbox writers (dojo command family)" --body "..."
```
PR body: summary (agenda renamed to `ax dojo agenda`; new `report`/`draft`/`outbox`); **call out the `ax dojo` -> `ax dojo agenda` rename as the one breaking change, justified by zero users since #390**; test plan; deferred (publish automation, dojo_run table + budget diff, dashboard).
