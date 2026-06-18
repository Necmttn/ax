# `ax profile interview` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-driven interview that captures user-authored profile highlights (secret-weapon rigs, per-skill summaries, philosophy, wins) and folds them into the published gist + the site's Taste section.

**Architecture:** Mirror `ax wrapped`'s brief→publish loop. `ax profile interview` emits a graph-prefilled brief; the agent interviews the user (draft-then-confirm) and pipes JSON to `ax profile interview submit`, which validates against an Effect schema and writes `~/.ax/profile-highlights.json`. `buildProfile` attaches the loaded file (injected via `ProfileEnv`, never read inside the DB Effect) as an optional `highlights` block. The site validates + renders it inside the existing Taste section. User-authored content (`highlights`) stays a separate block from mined content (`taste.patterns`); only the render unifies.

**Tech Stack:** bun ≥ 1.3, TypeScript (strict), Effect `@beta` (`effect/unstable/cli`, `Schema`), SurrealDB (read-only here), TanStack Start SPA (site, no Effect dep), bun:test.

## Global Constraints

- Runtime is bun. Tests are `bun:test`. Effect is `effect@beta` (v4); CLI uses `effect/unstable/cli` (`Command`, `Flag`).
- `node:fs`/`node:path` are banned in `apps/` by the `check:no-node-fs` CI gate - use `Bun.file` / `Bun.write({createPath:true})` / `Bun.spawnSync(["mv",...])`.
- The site (`apps/site`) does NOT depend on Effect - validation there is manual (`community.ts`), throw-on-invalid.
- Repo-root `bun test` has NO tsconfig-paths plugin → cannot resolve the apps/site `~` alias. Site tests must use relative imports or be source-grep tests. NEVER write a render test that pulls the `~/` chain.
- Multi-agent repo: all work happens in the worktree `.claude/worktrees/profile-interview` on branch `feat/profile-interview`. Never edit `main`.
- Aggregates + user prose only - no transcript content, project paths, or derived private data leaves the machine.
- Path helpers derive from `process.env.HOME`; default highlights path is `~/.ax/profile-highlights.json` (sibling of `~/.ax/profile-publish.json`).
- All commands run from the worktree root: `/Users/necmttn/Projects/ax/.claude/worktrees/profile-interview`.

---

### Task 1: `Highlights` schema + `ProfileV1.highlights` field

**Files:**
- Modify: `apps/axctl/src/profile/schema.ts`
- Test: `apps/axctl/src/profile/schema.test.ts`

**Interfaces:**
- Produces: `Highlights` (Effect Schema struct, the profile block - no `v`), `export type Highlights`. `ProfileV1.highlights?: Highlights`. `Highlights.fields` is reused by Task 2 to build the file schema.

- [ ] **Step 1: Write the failing test**

Add to `apps/axctl/src/profile/schema.test.ts`:

```ts
import { Highlights } from "./schema.ts";
import { Schema } from "effect";

test("Highlights decodes a full block", () => {
    const decode = Schema.decodeUnknownSync(Highlights);
    const v = decode({
        authored_at: "2026-06-17T00:00:00Z",
        setup: [{ title: "loader", what: "injects code", why: "saves time", link: "https://x.dev" }],
        skills: [{ name: "tdd", source: "superpowers", summary: "tests first" }],
        taste: "I optimize for landed-clean commits.",
        wins: [{ text: "duel page", evidence: "PR #527" }],
    });
    expect(v.setup?.[0]?.title).toBe("loader");
    expect(v.wins?.[0]?.evidence).toBe("PR #527");
});

test("Highlights decodes a taste-only block", () => {
    const v = Schema.decodeUnknownSync(Highlights)({ authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" });
    expect(v.taste).toBe("ship clean");
    expect(v.setup).toBeUndefined();
});

test("Highlights rejects a setup row missing `why`", () => {
    expect(() => Schema.decodeUnknownSync(Highlights)({
        authored_at: "2026-06-17T00:00:00Z",
        setup: [{ title: "x", what: "y" }],
    })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/schema.test.ts`
Expected: FAIL - `Highlights` is not exported from `./schema.ts`.

- [ ] **Step 3: Add the schema**

In `apps/axctl/src/profile/schema.ts`, before `export const ProfileV1`:

```ts
export const Highlights = Schema.Struct({
    authored_at: Schema.String,
    setup: Schema.optional(Schema.Array(Schema.Struct({
        title: Schema.String,
        what: Schema.String,
        why: Schema.String,
        link: Schema.optional(Schema.String),
    }))),
    skills: Schema.optional(Schema.Array(Schema.Struct({
        name: Schema.String,
        source: Schema.String,
        summary: Schema.String,
    }))),
    taste: Schema.optional(Schema.String),
    wins: Schema.optional(Schema.Array(Schema.Struct({
        text: Schema.String,
        evidence: Schema.optional(Schema.String),
    }))),
});
export type Highlights = typeof Highlights.Type;
```

Add the field to the `ProfileV1` struct (after `workflow: Schema.optional(Workflow),`):

```ts
    highlights: Schema.optional(Highlights),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/schema.test.ts`
Expected: PASS (all tests, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/schema.ts apps/axctl/src/profile/schema.test.ts
git commit -m "feat(profile): Highlights schema + ProfileV1.highlights field"
```

---

### Task 2: Highlights file loader module

**Files:**
- Create: `apps/axctl/src/profile/highlights.ts`
- Test: `apps/axctl/src/profile/highlights.test.ts`

**Interfaces:**
- Consumes: `Highlights` from `./schema.ts` (Task 1).
- Produces:
  - `defaultHighlightsPath(): string`
  - `HighlightsFile` (Schema struct = `v:1` + Highlights fields), `type HighlightsFile`
  - `decodeHighlightsFile(raw: unknown): Effect<HighlightsFile, ParseError>` - loud, for `submit`
  - `loadHighlightsBlock(path: string): Promise<Highlights | null>` - fail-open; returns the profile block (file minus `v`) or null on missing/corrupt
  - `saveHighlightsFile(path: string, data: HighlightsFile): Promise<void>` - atomic write

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/profile/highlights.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    decodeHighlightsFile,
    loadHighlightsBlock,
    saveHighlightsFile,
} from "./highlights.ts";

const tmpPath = () => `/tmp/ax-highlights-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

describe("highlights file loader", () => {
    test("decodeHighlightsFile accepts a valid file", async () => {
        const v = await Effect.runPromise(decodeHighlightsFile({
            v: 1, authored_at: "2026-06-17T00:00:00Z", taste: "ship clean",
        }));
        expect(v.v).toBe(1);
        expect(v.taste).toBe("ship clean");
    });

    test("decodeHighlightsFile rejects a missing v", async () => {
        const exit = await Effect.runPromiseExit(decodeHighlightsFile({ authored_at: "x" }));
        expect(exit._tag).toBe("Failure");
    });

    test("saveHighlightsFile then loadHighlightsBlock round-trips minus v", async () => {
        const path = tmpPath();
        await saveHighlightsFile(path, {
            v: 1, authored_at: "2026-06-17T00:00:00Z",
            setup: [{ title: "loader", what: "w", why: "y" }],
        });
        const block = await loadHighlightsBlock(path);
        expect(block?.setup?.[0]?.title).toBe("loader");
        expect((block as Record<string, unknown>).v).toBeUndefined();
        await Bun.spawnSync(["rm", "-f", path]);
    });

    test("loadHighlightsBlock returns null for a missing file", async () => {
        expect(await loadHighlightsBlock(tmpPath())).toBeNull();
    });

    test("loadHighlightsBlock returns null for corrupt JSON", async () => {
        const path = tmpPath();
        await Bun.write(path, "{not json");
        expect(await loadHighlightsBlock(path)).toBeNull();
        await Bun.spawnSync(["rm", "-f", path]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/highlights.test.ts`
Expected: FAIL - `./highlights.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/axctl/src/profile/highlights.ts`:

```ts
/**
 * User-authored profile highlights: load/validate/save the local
 * ~/.ax/profile-highlights.json file. The profile block (no `v`) is what
 * buildProfile attaches; the file carries `v:1`. Atomic write mirrors
 * publish-state.ts (Bun.write tmp + mv; node:fs is banned by check:no-node-fs).
 * loadHighlightsBlock is fail-open (null on missing/corrupt) like publish-state.
 */
import { Effect, Schema } from "effect";
import { Highlights } from "./schema.ts";

export const defaultHighlightsPath = (): string =>
    `${process.env.HOME}/.ax/profile-highlights.json`;

export const HighlightsFile = Schema.Struct({
    v: Schema.Literal(1),
    ...Highlights.fields,
});
export type HighlightsFile = typeof HighlightsFile.Type;

export const decodeHighlightsFile = (raw: unknown): Effect.Effect<HighlightsFile, unknown> =>
    Schema.decodeUnknownEffect(HighlightsFile)(raw);

export async function loadHighlightsBlock(path: string): Promise<Highlights | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const raw: unknown = JSON.parse(await file.text());
        const decoded = Schema.decodeUnknownSync(HighlightsFile)(raw);
        const { v: _v, ...block } = decoded;
        return block;
    } catch {
        return null;
    }
}

export async function saveHighlightsFile(path: string, data: HighlightsFile): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(data, null, 2)}\n`, { createPath: true });
    const result = Bun.spawnSync(["mv", tmp, path]);
    if (result.exitCode !== 0) {
        Bun.spawnSync(["rm", "-f", tmp]);
        throw new Error(`saveHighlightsFile: mv ${tmp} → ${path} failed (exit ${result.exitCode})`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/highlights.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/highlights.ts apps/axctl/src/profile/highlights.test.ts
git commit -m "feat(profile): highlights file loader (load/validate/save)"
```

---

### Task 3: Interview brief renderer (pure function)

**Files:**
- Create: `apps/axctl/src/profile/interview-brief.ts`
- Test: `apps/axctl/src/profile/interview-brief.test.ts`

**Interfaces:**
- Produces: `renderProfileInterviewBrief(input: { date: string; skills: ReadonlyArray<{ name: string; source: string }>; hooks: ReadonlyArray<string> }): string`

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/profile/interview-brief.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderProfileInterviewBrief } from "./interview-brief.ts";

test("brief lists prefilled skills and hooks and the submit command", () => {
    const md = renderProfileInterviewBrief({
        date: "2026-06-17",
        skills: [{ name: "tdd", source: "superpowers" }, { name: "efficient-dispatch", source: "ax" }],
        hooks: ["enforce-worktree", "route-dispatch"],
    });
    expect(md).toContain("tdd (superpowers)");
    expect(md).toContain("enforce-worktree");
    expect(md).toContain("ax profile interview submit");
    expect(md).toContain("2026-06-17");
    // draft-then-confirm interaction is spelled out
    expect(md.toLowerCase()).toContain("confirm");
});

test("brief handles an empty rig gracefully", () => {
    const md = renderProfileInterviewBrief({ date: "2026-06-17", skills: [], hooks: [] });
    expect(md).toContain("ax profile interview submit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/interview-brief.test.ts`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Write the renderer**

Create `apps/axctl/src/profile/interview-brief.ts`:

```ts
/**
 * The profile-interview brief - `ax profile interview` writes it to
 * .ax/tasks/. An agent session reads it, interviews the user (draft from the
 * graph, then confirm), and submits the result through
 * `ax profile interview submit`. Sibling of wrapped-generate-brief.ts; the
 * difference is two-way (the agent asks the user) + a JSON file target
 * (not the DB).
 */
export interface ProfileInterviewBriefInput {
    readonly date: string;
    readonly skills: ReadonlyArray<{ readonly name: string; readonly source: string }>;
    readonly hooks: ReadonlyArray<string>;
}

export const renderProfileInterviewBrief = ({ date, skills, hooks }: ProfileInterviewBriefInput): string => {
    const skillList = skills.length > 0
        ? skills.map((s) => `- ${s.name} (${s.source})`).join("\n")
        : "- (no skills recorded in the window - ask the user what they lean on)";
    const hookList = hooks.length > 0 ? hooks.join(", ") : "(none installed)";
    return `## Task: Interview me for my ax profile highlights (${date})

You are capturing the **user-authored** layer of my public ax profile - the
"I'm proud of this" content the graph can't mine. The profile already has all
the mechanical metrics; your job is the human layer, grounded in my real setup.

**Style:** draft-then-confirm. Draft candidates from the data BELOW, show them
to me, ask me to confirm / correct / add. Keep my voice - these are MY words,
not template-speak. Short and concrete beats long and generic.

**My rig (already mined - use it to draft):**

Top skills (draft a one-line "what this does / why someone should learn it"
summary for the ones I actually rely on):
${skillList}

Installed hooks (candidate "secret weapons"): ${hookList}
Also scan my dotfiles / scripts dirs (e.g. ~/.claude, ~/.ax, ~/dotfiles) for
setup I'd be proud of - the kind of script/hook that changes how I work.

**Capture these four (all optional - skip any I have nothing for):**
1. **setup** - secret-weapon rigs/hooks/scripts: { title, what, why, link? }.
   The "proud to share" layer. Draft from hooks + dotfiles, then ask me.
2. **skills** - per-skill "learn more": { name, source, summary }. Draft from
   the top skills above; confirm the summaries read true.
3. **taste** - one free-form line: how I work, what I optimize for. ASK me;
   don't invent it.
4. **wins** - specific things I shipped recently: { text, evidence? }.
   Corroborate from \`git log\`, \`ax sessions churn --since=30\`, or PR numbers;
   keep my framing of why it mattered.

**Then submit the final JSON (one call, replaces the whole file):**

\`\`\`bash
echo '<json>' | ax profile interview submit
\`\`\`

\`\`\`json
{
  "v": 1,
  "authored_at": "${date}T00:00:00Z",
  "setup": [{ "title": "instructions-loader.sh", "what": "Injects similar past code into context before I work.", "why": "Stops re-deriving last week's solve.", "link": "https://..." }],
  "skills": [{ "name": "tdd", "source": "superpowers", "summary": "Red-green-refactor; tests before code." }],
  "taste": "I optimize for landed-clean commits, not wall-clock.",
  "wins": [{ "text": "Bespoke duel page", "evidence": "PR #527 · 12 sessions" }]
}
\`\`\`

**Rules:**
- Everything is MY words - confirm before writing anything down. Don't fabricate.
- \`link\` is optional and must be http/https; a private repo URL is fine (I'll
  see the full JSON at publish-time and consent then).
- Submit validates against a schema and fails loudly on a bad shape - fix and
  re-run, never hand-edit the file.
- After submit, run \`ax profile publish\` to fold these into my public gist.

_source: ax profile interview ${date}_
`;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/profile/interview-brief.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/interview-brief.ts apps/axctl/src/profile/interview-brief.test.ts
git commit -m "feat(profile): interview brief renderer"
```

---

### Task 4: `ax profile interview` + `interview submit` subcommands

**Files:**
- Modify: `apps/axctl/src/cli/commands/profile.ts`
- Test: `apps/axctl/src/cli/commands/profile-interview.test.ts`

**Interfaces:**
- Consumes: `renderProfileInterviewBrief` (Task 3), `decodeHighlightsFile` + `saveHighlightsFile` + `defaultHighlightsPath` (Task 2), `buildProfile` + `gatherEnv` (existing in this file), `jsonFlag`/`optionValue` (existing import).
- Produces: `profileInterviewCommand` wired under `profileCommand` via `Command.withSubcommands`. `cmdProfileInterviewSubmit` exported for the test.

- [ ] **Step 1: Write the failing test**

Create `apps/axctl/src/cli/commands/profile-interview.test.ts` (pure unit test of the submit handler - no DB):

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { cmdProfileInterviewSubmit } from "./profile.ts";
import { loadHighlightsBlock } from "../../profile/highlights.ts";

const tmpPath = () => `/tmp/ax-hl-submit-${process.pid}-${Math.random().toString(36).slice(2)}.json`;

describe("ax profile interview submit", () => {
    test("validates JSON and writes the highlights file", async () => {
        const path = tmpPath();
        const json = JSON.stringify({ v: 1, authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" });
        await Effect.runPromise(cmdProfileInterviewSubmit({ rawJson: json, path }));
        const block = await loadHighlightsBlock(path);
        expect(block?.taste).toBe("ship clean");
        Bun.spawnSync(["rm", "-f", path]);
    });

    test("fails on a bad shape and does not write", async () => {
        const path = tmpPath();
        const exit = await Effect.runPromiseExit(
            cmdProfileInterviewSubmit({ rawJson: JSON.stringify({ taste: 5 }), path }),
        );
        expect(exit._tag).toBe("Failure");
        expect(await Bun.file(path).exists()).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/cli/commands/profile-interview.test.ts`
Expected: FAIL - `cmdProfileInterviewSubmit` is not exported.

- [ ] **Step 3: Wire the subcommands**

In `apps/axctl/src/cli/commands/profile.ts`, add imports near the top:

```ts
import { renderProfileInterviewBrief } from "../../profile/interview-brief.ts";
import {
    decodeHighlightsFile,
    defaultHighlightsPath,
    saveHighlightsFile,
    type HighlightsFile,
} from "../../profile/highlights.ts";
```

Add the submit handler (testable seam - takes raw JSON + path, no stdin/IO):

```ts
// ax profile interview submit - validate { v, ...highlights } JSON, write the file.
export const cmdProfileInterviewSubmit = (input: { readonly rawJson: string; readonly path: string }) =>
    Effect.gen(function* () {
        const parsed = yield* Effect.try({
            try: () => JSON.parse(input.rawJson) as unknown,
            catch: (err) => new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`),
        });
        const file: HighlightsFile = yield* decodeHighlightsFile(parsed);
        yield* Effect.promise(() => saveHighlightsFile(input.path, file));
        return file;
    });
```

Add the `interview` (emit brief) handler - reuses `gatherEnv` + `buildProfile` for the prefill:

```ts
const cmdProfileInterview = (input: { readonly force: boolean }) =>
    Effect.gen(function* () {
        const date = new Date().toISOString().slice(0, 10);
        const path = `.ax/tasks/profile-interview-${date}.md`;
        const exists = yield* Effect.tryPromise(() => Bun.file(path).exists());
        if (exists && !input.force) {
            console.log(`already exists: ${path} (re-run with --force to overwrite)`);
            return;
        }
        const env = yield* gatherEnv;
        const profile = yield* buildProfile({ windowDays: 30, includeCost: false, env });
        const md = renderProfileInterviewBrief({
            date,
            skills: profile.rig.skills.slice(0, 10).map((s) => ({ name: s.name, source: s.source })),
            hooks: profile.rig.hooks,
        });
        yield* Effect.tryPromise(() => Bun.write(path, md));
        console.log(`interview brief written: ${path}`);
        console.log("hand it to an agent session; answers come back via `ax profile interview submit`");
    });
```

Add the command definitions (after `profileUnpublishCommand`, before `export const profileCommand`):

```ts
const profileInterviewSubmitCommand = Command.make(
    "submit",
    { file: Flag.string("file").pipe(Flag.optional) },
    ({ file }) =>
        Effect.gen(function* () {
            const filePath = optionValue(file);
            const rawJson = filePath !== undefined
                ? yield* Effect.tryPromise(() => Bun.file(filePath).text())
                : yield* Effect.tryPromise(() => Bun.stdin.text());
            yield* cmdProfileInterviewSubmit({ rawJson, path: defaultHighlightsPath() });
            console.log(`saved: ${defaultHighlightsPath()}`);
            console.log("run `ax profile publish` to fold these into your public gist.");
        }),
).pipe(Command.withDescription(
    "Validate { v, authored_at, setup?, skills?, taste?, wins? } JSON (stdin or --file) and write ~/.ax/profile-highlights.json.",
));

const profileInterviewCommand = Command.make(
    "interview",
    { force: Flag.boolean("force").pipe(Flag.withDefault(false)) },
    ({ force }) => cmdProfileInterview({ force }),
).pipe(
    Command.withDescription(
        "Emit .ax/tasks/profile-interview-<date>.md - a brief for an agent to interview you and submit highlights via `ax profile interview submit`. --force overwrites.",
    ),
    Command.withSubcommands([profileInterviewSubmitCommand]),
);
```

Add `profileInterviewCommand` to the existing `Command.withSubcommands([...])` array in `profileCommand`:

```ts
    Command.withSubcommands([profileShowCommand, profilePublishCommand, profileUnpublishCommand, profileInterviewCommand]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/cli/commands/profile-interview.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Smoke-test the CLI wiring**

Run: `bun run apps/axctl/src/cli/index.ts profile interview --help`
Expected: help text for the `interview` command, listing the `submit` subcommand. (If a live DB is unavailable, `--help` still resolves the command tree without querying.)

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/cli/commands/profile.ts apps/axctl/src/cli/commands/profile-interview.test.ts
git commit -m "feat(profile): ax profile interview + interview submit subcommands"
```

---

### Task 5: Fold highlights into `buildProfile` via `ProfileEnv`

**Files:**
- Modify: `apps/axctl/src/profile/render.ts`
- Modify: `apps/axctl/src/cli/commands/profile.ts` (gatherEnv loads the file)
- Test: `apps/axctl/src/profile/render.test.ts`

**Interfaces:**
- Consumes: `Highlights` (Task 1), `loadHighlightsBlock` + `defaultHighlightsPath` (Task 2).
- Produces: `ProfileEnv.highlights: Highlights | null`. `buildProfile` attaches `highlights` to the decoded profile when `env.highlights` is non-null.

- [ ] **Step 1: Write the failing test**

In `apps/axctl/src/profile/render.test.ts`, find the existing `buildProfile` test that constructs `env` (it passes `github`, `generatedAt`, `today`, `hookFiles`, `hasRoutingTable`, `rulesMarkdown`). Add a new test after it that reuses the same `mockResults` array and the `makeMockDb`/`runWithMock` harness:

```ts
test("buildProfile attaches highlights from env", async () => {
    const db = makeMockDb(mockResults);
    const profile = await runWithMock(db, buildProfile({
        windowDays: 30,
        includeCost: true,
        env: {
            github: "octocat", generatedAt: "2026-06-12T00:00:00Z", today: "2026-06-12",
            hookFiles: [], hasRoutingTable: false, rulesMarkdown: null,
            highlights: { authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" },
        },
    }));
    expect(profile.highlights?.taste).toBe("ship clean");
});

test("buildProfile omits highlights when env.highlights is null", async () => {
    const db = makeMockDb(mockResults);
    const profile = await runWithMock(db, buildProfile({
        windowDays: 30,
        includeCost: true,
        env: {
            github: "octocat", generatedAt: "2026-06-12T00:00:00Z", today: "2026-06-12",
            hookFiles: [], hasRoutingTable: false, rulesMarkdown: null, highlights: null,
        },
    }));
    expect(profile.highlights).toBeUndefined();
});
```

(Match the exact `makeMockDb`/`runWithMock` call form used by the existing test in this file - copy its harness lines verbatim and only change the `env` + assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/profile/render.test.ts`
Expected: FAIL - `highlights` is not on `ProfileEnv` (type error) / not attached.

- [ ] **Step 3: Extend `ProfileEnv` and attach**

In `apps/axctl/src/profile/render.ts`, add the import:

```ts
import type { Highlights } from "./schema.ts";
```

Add to the `ProfileEnv` interface:

```ts
    readonly highlights: Highlights | null;
```

In the `decodeProfile({...})` call, add after the `workflow` spread line:

```ts
            ...(env.highlights !== null ? { highlights: env.highlights } : {}),
```

- [ ] **Step 4: Load highlights in `gatherEnv`**

In `apps/axctl/src/cli/commands/profile.ts`, add the import:

```ts
import { defaultHighlightsPath, loadHighlightsBlock } from "../../profile/highlights.ts";
```

(If Task 4 already added a `highlights.ts` import line, extend it instead of duplicating - keep one import statement.)

In `gatherEnv`, before the `return { ... } satisfies ProfileEnv;`, add:

```ts
    const highlights = yield* Effect.promise(() => loadHighlightsBlock(defaultHighlightsPath()));
```

And add `highlights,` to the returned object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/axctl/src/profile/render.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/profile/render.ts apps/axctl/src/cli/commands/profile.ts apps/axctl/src/profile/render.test.ts
git commit -m "feat(profile): fold highlights into buildProfile via ProfileEnv"
```

---

### Task 6: Site validator - `highlights` in `validateProfileV1`

**Files:**
- Modify: `apps/site/app/lib/community.ts`
- Test: `apps/site/app/lib/community.test.ts` (create if absent; relative import only - NO `~/` alias)

**Interfaces:**
- Produces: `ProfileHighlights` interface + `highlights?` on `ProfileModel`'s parent `ProfileV1`; `validateProfileV1` validates every highlights field.

- [ ] **Step 1: Write the failing test**

Create or append to `apps/site/app/lib/community.test.ts` (import is relative - repo-root `bun test` has no `~` plugin):

```ts
import { describe, expect, test } from "bun:test";
import { validateProfileV1 } from "./community.ts";

const base = {
    v: 1, github: "octocat", generated_at: "2026-06-17T00:00:00Z", window_days: 30,
    stats: { sessions: 1, active_days: 1, streak_days: 1, tokens: { prompt: 1, completion: 1, total: 2 }, models: [], harnesses: [] },
    rig: { skills: [], hooks: [], routing_table: false },
};

describe("validateProfileV1 highlights", () => {
    test("accepts a full highlights block", () => {
        const p = validateProfileV1({
            ...base,
            highlights: {
                authored_at: "2026-06-17T00:00:00Z",
                setup: [{ title: "t", what: "w", why: "y", link: "https://x.dev" }],
                skills: [{ name: "tdd", source: "superpowers", summary: "s" }],
                taste: "ship clean",
                wins: [{ text: "shipped", evidence: "PR #1" }],
            },
        });
        expect(p.highlights?.taste).toBe("ship clean");
        expect(p.highlights?.setup?.[0]?.title).toBe("t");
    });

    test("rejects a setup row missing why", () => {
        expect(() => validateProfileV1({
            ...base,
            highlights: { authored_at: "x", setup: [{ title: "t", what: "w" }] },
        })).toThrow();
    });

    test("profile without highlights still validates", () => {
        expect(validateProfileV1(base).highlights).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/site/app/lib/community.test.ts`
Expected: FAIL - `highlights` not validated / interface missing.

- [ ] **Step 3: Add the interface and validation**

In `apps/site/app/lib/community.ts`, add interfaces near `TastePattern`:

```ts
export interface ProfileSetupItem {
    readonly title: string;
    readonly what: string;
    readonly why: string;
    readonly link?: string;
}
export interface ProfileSkillSummary {
    readonly name: string;
    readonly source: string;
    readonly summary: string;
}
export interface ProfileWin {
    readonly text: string;
    readonly evidence?: string;
}
export interface ProfileHighlights {
    readonly authored_at: string;
    readonly setup?: readonly ProfileSetupItem[];
    readonly skills?: readonly ProfileSkillSummary[];
    readonly taste?: string;
    readonly wins?: readonly ProfileWin[];
}
```

Add `highlights?: ProfileHighlights;` to the `ProfileV1` interface (after `workflow?`).

In `validateProfileV1`, before `return value as unknown as ProfileV1;`, add:

```ts
    if (value.highlights !== undefined) {
        const h = value.highlights;
        if (!isRecord(h)) throw new Error("invalid highlights");
        str(h.authored_at, "highlights.authored_at");
        if (h.setup !== undefined) {
            if (!Array.isArray(h.setup)) throw new Error("invalid highlights.setup");
            for (const s of h.setup) {
                if (!isRecord(s)) throw new Error("invalid setup row");
                str(s.title, "setup.title");
                str(s.what, "setup.what");
                str(s.why, "setup.why");
                optStr(s.link, "setup.link");
            }
        }
        if (h.skills !== undefined) {
            if (!Array.isArray(h.skills)) throw new Error("invalid highlights.skills");
            for (const s of h.skills) {
                if (!isRecord(s)) throw new Error("invalid highlights skill row");
                str(s.name, "highlights.skill.name");
                str(s.source, "highlights.skill.source");
                str(s.summary, "highlights.skill.summary");
            }
        }
        optStr(h.taste, "highlights.taste");
        if (h.wins !== undefined) {
            if (!Array.isArray(h.wins)) throw new Error("invalid highlights.wins");
            for (const w of h.wins) {
                if (!isRecord(w)) throw new Error("invalid win row");
                str(w.text, "win.text");
                optStr(w.evidence, "win.evidence");
            }
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/site/app/lib/community.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/lib/community.ts apps/site/app/lib/community.test.ts
git commit -m "feat(site): validate highlights block in validateProfileV1"
```

---

### Task 7: Dossier render - fold highlights into the Taste section

**Files:**
- Modify: `apps/site/app/components/profile-dossier.tsx`
- Modify: `apps/site/app/styles/globals.css` (or the dossier's style file - match where `.pf-taste`/`.pf-pattern` are defined)
- Test: `apps/site/app/components/profile-highlights.test.tsx` (source-grep test - NO render, NO `~/` import)

**Interfaces:**
- Consumes: `ProfileV1.highlights` (Task 6), existing `SectionIntro`, `fmtInt`, `fmtPct`.

- [ ] **Step 1: Write the failing source-grep test**

Create `apps/site/app/components/profile-highlights.test.tsx`:

```ts
import { describe, expect, test } from "bun:test";

// Source-grep test: repo-root `bun test` cannot resolve the `~/` alias chain
// this component imports, so we assert against the file's source text rather
// than rendering it (same convention as profile-duel.test.tsx).
const src = await Bun.file(new URL("./profile-dossier.tsx", import.meta.url)).text();

describe("dossier renders highlights inside the Taste section", () => {
    test("references each highlights sub-block", () => {
        expect(src).toContain("highlights");
        expect(src).toContain("In their words");      // taste lede label
        expect(src).toContain("Secret weapons");
        expect(src).toContain("Learn the rig");
        expect(src).toContain("Shipped");
    });
    test("Taste section renders when highlights OR mined patterns exist", () => {
        // guard widened from `p.taste && ...` to also fire on highlights
        expect(src).toMatch(/p\.highlights\s*\|\|\s*\(p\.taste/);
    });
    test("setup links guard the scheme", () => {
        expect(src).toContain("https");        // scheme check present
        expect(src).toContain("noopener");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/site/app/components/profile-highlights.test.tsx`
Expected: FAIL - strings absent.

- [ ] **Step 3: Add a safe-link helper + the highlights render**

In `apps/site/app/components/profile-dossier.tsx`, add a small helper near the other `/* ---------- pieces ---------- */` helpers:

```tsx
/** Only http/https links are rendered as anchors; anything else renders as text. */
function safeHttpUrl(raw: string): string | null {
    try {
        const u = new URL(raw);
        return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
        return null;
    }
}
```

Replace the existing taste-patterns block (the `{p.taste && p.taste.patterns.length > 0 && ( ... )}` section) with a combined section. The new section opens when `p.highlights` OR mined patterns exist:

```tsx
            {/* taste: user-authored highlights (their words) + mined patterns */}
            {(p.highlights || (p.taste && p.taste.patterns.length > 0)) && (
                <section className="pf-section">
                    <SectionIntro eyebrow="taste" title="Taste" note="in their words, and what ax keeps seeing" />

                    {p.highlights?.taste && (
                        <blockquote className="pf-words">
                            <p>{p.highlights.taste}</p>
                            <cite>- in their words</cite>
                        </blockquote>
                    )}

                    {p.highlights?.setup && p.highlights.setup.length > 0 && (
                        <div className="pf-weapons">
                            <h3>Secret weapons</h3>
                            <div className="pf-weapons-grid">
                                {p.highlights.setup.map((s, i) => {
                                    const href = s.link ? safeHttpUrl(s.link) : null;
                                    return (
                                        <div className="pf-weapon" key={`${s.title}-${i}`}>
                                            <div className="pf-weapon-title">
                                                {href
                                                    ? <a href={href} target="_blank" rel="noopener nofollow">{s.title} ↗</a>
                                                    : s.title}
                                            </div>
                                            <p className="pf-weapon-what">{s.what}</p>
                                            <p className="pf-weapon-why">{s.why}</p>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {p.highlights?.skills && p.highlights.skills.length > 0 && (
                        <div className="pf-learn">
                            <h3>Learn the rig</h3>
                            {p.highlights.skills.map((s, i) => (
                                <div className="pf-learn-row" key={`${s.name}-${i}`}>
                                    <span className="pf-learn-name">{s.name}</span>
                                    <span className="pf-learn-src">{s.source}</span>
                                    <span className="pf-learn-sum">{s.summary}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {p.highlights?.wins && p.highlights.wins.length > 0 && (
                        <div className="pf-wins">
                            <h3>Shipped</h3>
                            {p.highlights.wins.map((w, i) => (
                                <div className="pf-win" key={`${i}`}>
                                    <span className="pf-win-text">✓ {w.text}</span>
                                    {w.evidence && <span className="pf-win-ev">{w.evidence}</span>}
                                </div>
                            ))}
                        </div>
                    )}

                    {p.taste && p.taste.patterns.length > 0 && (
                        <>
                            <div className="pf-taste-divider">patterns ax keeps seeing</div>
                            <div className="pf-taste">
                                {p.taste.patterns.map((t) => (
                                    <div className="pf-pattern" key={`${t.category}/${t.name}`}>
                                        <span className="pf-pattern-cat">{t.category}{t.slot ? ` · ${t.slot}` : ""}</span>
                                        <div className="pf-pattern-name">{t.name}</div>
                                        {t.summary && <p className="pf-pattern-sum">{t.summary}</p>}
                                        <div className="pf-pattern-ev">
                                            {fmtInt(t.evidence.sessions)} sessions · confidence {fmtPct(t.evidence.confidence)}
                                            {t.evidence.trend ? ` · ${t.evidence.trend}` : ""}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </section>
            )}
```

- [ ] **Step 4: Add styles**

Find where `.pf-taste`/`.pf-pattern` are defined (grep `pf-pattern` under `apps/site/app`). In that same file, add dark-shell-consistent styles (reuse existing CSS custom properties/tokens from neighboring rules - do NOT hardcode `#fff`; see memory `studio-dark-shell-bridge`):

```css
.pf-words { margin: 0 0 1.5rem; padding-left: 1rem; border-left: 2px solid var(--pf-accent, currentColor); }
.pf-words p { font-style: italic; }
.pf-words cite { display: block; opacity: 0.6; font-size: 0.85em; }
.pf-weapons-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.pf-weapon { padding: 1rem; border: 1px solid var(--pf-border, rgba(127,127,127,0.3)); border-radius: 6px; }
.pf-weapon-title { font-weight: 600; }
.pf-weapon-why { opacity: 0.7; font-size: 0.9em; }
.pf-learn-row { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.25rem 0; }
.pf-learn-src { opacity: 0.5; font-size: 0.8em; }
.pf-win { display: flex; justify-content: space-between; gap: 1rem; padding: 0.2rem 0; }
.pf-win-ev { opacity: 0.6; font-size: 0.85em; white-space: nowrap; }
.pf-taste-divider { margin: 1.5rem 0 0.75rem; opacity: 0.6; font-size: 0.85em; text-transform: lowercase; }
```

(Adjust property names/tokens to match the surrounding stylesheet - the goal is parity with `.pf-pattern`, not new design.)

- [ ] **Step 5: Run the source-grep test**

Run: `bun test apps/site/app/components/profile-highlights.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck the site build**

Run: `cd apps/site && bun run build && bun run typecheck`
Expected: build + strict-null typecheck pass (the site typecheck needs the prior build for route/content codegen - see CLAUDE.md).

- [ ] **Step 7: Commit**

```bash
git add apps/site/app/components/profile-dossier.tsx apps/site/app/components/profile-highlights.test.tsx apps/site/app/styles/globals.css
git commit -m "feat(site): render highlights inside the Taste section (their words)"
```

---

### Task 8: Docs gates + CLAUDE.md

**Files:**
- Modify: `docs/cli.md`
- Modify: `apps/site/public/llms.txt`
- Modify: `apps/site/app/routes/docs/-cli-reference.data.ts`
- Modify: `CLAUDE.md` (the `### Profile` section)

**Interfaces:** none (documentation). NOTE: `VISIBLE_COMMANDS` (`apps/axctl/src/cli/commands/visible-commands.ts` `n`) lists only top-level command tokens; `profile` is already present, so no change there - confirmed by `visible-commands.test.ts` which enumerates top-level commands only.

- [ ] **Step 1: Update `docs/cli.md`**

Find the `axctl profile show ...` / `axctl profile publish ...` lines and add below them:

```
axctl profile interview [--force]              # emit a brief; an agent interviews you for profile highlights
axctl profile interview submit [--file=PATH]   # validate highlights JSON (stdin/--file) -> ~/.ax/profile-highlights.json
```

- [ ] **Step 2: Update `apps/site/public/llms.txt`**

After the `- \`ax profile publish\` ...` line, add:

```
- `ax profile interview` - emit a brief; an agent interviews you (draft-then-confirm) for the user-authored layer of your profile: secret-weapon setup, per-skill summaries, philosophy, wins. `ax profile interview submit` validates the JSON into ~/.ax/profile-highlights.json; `ax profile publish` folds it into your gist
```

- [ ] **Step 3: Update `apps/site/app/routes/docs/-cli-reference.data.ts`**

In the profile command entry (around line 514, `name: "profile"`), extend the `signature` and add a note. Update `signature` to:

```ts
        signature: "ax profile show [--window=N] | publish [--yes] | unpublish | interview [submit]",
```

Add to that entry's notes array (matching the existing note style):

```ts
          "ax profile interview emits a brief; an agent interviews you (draft-then-confirm) and pipes the result to `ax profile interview submit`, which validates it into ~/.ax/profile-highlights.json. The next `ax profile publish` folds these user-authored highlights into your gist.",
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the `### Profile` section, after the `ax profile publish ...` paragraph, add:

```
`ax profile interview [--force]` - emit `.ax/tasks/profile-interview-<date>.md`, a
brief for an agent to interview you (draft-then-confirm, grounded in your rig) for
the user-authored profile layer: secret-weapon setup, per-skill summaries, a
free-form taste line, and corroborated wins. `ax profile interview submit`
[--file] validates `{ v, authored_at, setup?, skills?, taste?, wins? }` JSON
(stdin/--file) against an Effect schema and writes `~/.ax/profile-highlights.json`;
`buildProfile` folds it in as the optional `highlights` block (separate from mined
`taste.patterns`), and the site renders both inside the Taste section ("in their
words"). Persists across republishes; re-run to refresh. Module:
`apps/axctl/src/profile/{highlights,interview-brief}.ts`. Spec:
docs/superpowers/specs/2026-06-17-profile-interview-design.md.
```

- [ ] **Step 5: Verify the cli-reference check passes**

Run: `bun run scripts/check-cli-reference.ts` (and `bun test scripts/check-site-cli-reference.test.ts` if present)
Expected: PASS - the documented commands match the real CLI tree.

- [ ] **Step 6: Commit**

```bash
git add docs/cli.md apps/site/public/llms.txt apps/site/app/routes/docs/-cli-reference.data.ts CLAUDE.md
git commit -m "docs(profile): document ax profile interview + submit"
```

---

### Task 9: Full verification + branch finish

**Files:** none (verification).

- [ ] **Step 1: Repo-wide test + typecheck**

Run: `bun test` then `bun run typecheck`
Expected: both PASS. (If the site typecheck is part of `bun run typecheck`, ensure `apps/site` was built first per CLAUDE.md.)

- [ ] **Step 2: Dogfood the loop end-to-end (manual, against the live daemon/DB)**

Run:
```bash
bun run apps/axctl/src/cli/index.ts profile interview
echo '{"v":1,"authored_at":"2026-06-17T00:00:00Z","taste":"ship clean","wins":[{"text":"interview feature","evidence":"this PR"}]}' \
  | bun run apps/axctl/src/cli/index.ts profile interview submit
bun run apps/axctl/src/cli/index.ts profile show --json | grep -A3 highlights
```
Expected: brief file written; `submit` reports `saved: ~/.ax/profile-highlights.json`; `profile show --json` includes the `highlights` block. Clean up the test file afterward: `rm -f ~/.ax/profile-highlights.json` (or keep it if you actually want to publish yours).

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/profile-interview
gh pr create --title "feat(profile): ax profile interview - user-authored highlights" --body "$(cat <<'EOF'
Adds `ax profile interview` (graph-prefilled brief) + `ax profile interview submit`
(validated write to ~/.ax/profile-highlights.json). `buildProfile` folds the
highlights in as an optional block; the site renders them inside the Taste section
("in their words"). Spec: docs/superpowers/specs/2026-06-17-profile-interview-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Confirm CI is green before merge**

Wait for `verify` (repo-wide `bun test`) AND the Cloudflare Pages build to pass. Merge only at `mergeStateStatus: CLEAN`. Expect to merge `origin/main` and resolve `globals.css` / `profile-dossier.tsx` conflicts if main moved.
