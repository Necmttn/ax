# Onboarding help-then-contribute loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-source the agent onboarding prompt into a zero-dep package and rebuild it as a help-then-contribute loop (founder note, woven CONTRIBUTE-back triggers, a reality-check beat) so both the post-install (`ax setup`) and pre-install (landing copy button) surfaces stay identical.

**Architecture:** Extract the prompt strings into a new zero-runtime-dep package `@ax/onboarding-prompt`. `@ax/lib` re-exports them (keeping the terminal wrapper `renderAgentOnboarding`); `apps/site` imports them and deletes its inline copy. Numbered steps compose from one `STEPS` array so install-prefixed (1-6) and post-install (1-5) variants can't drift. The prompt body gains a founder note, a CONTRIBUTE-back block defined once and referenced inline at each triggerable step, and a reality-check beat after the facts.

**Tech Stack:** Bun workspace monorepo, TypeScript (raw `.ts` per-file exports, no build step), Turbo, `bun:test`. TanStack Start SPA for the site.

**Note on copy:** A repo hook rewrites em-dashes (`-`) to `-` on write. All prompt strings in this plan use ASCII hyphens and straight quotes only. Do not introduce em-dashes.

---

## File structure

- Create `packages/onboarding-prompt/package.json` - new zero-dep package manifest (`@ax/onboarding-prompt`).
- Create `packages/onboarding-prompt/tsconfig.json` - extends the repo base config.
- Create `packages/onboarding-prompt/src/index.ts` - the canonical prompt strings + install constants, composed from a single `STEPS` array.
- Create `packages/onboarding-prompt/src/index.test.ts` - structural assertions on the exported strings.
- Modify `packages/lib/package.json` - add `@ax/onboarding-prompt` workspace dep.
- Modify `packages/lib/src/agent-onboarding.ts` - re-export the strings from the micro-package; keep `renderAgentOnboarding`.
- Modify `packages/lib/src/agent-onboarding.test.ts` - keep the port guard; add a cross-check that the micro-package port matches `DEFAULT_DASHBOARD_PORT`.
- Modify `apps/site/package.json` - add `@ax/onboarding-prompt` workspace dep.
- Modify `apps/site/app/components/landing-v2/dashboard-preview.tsx` - import strings + install constants; delete the inline `AGENT_PROMPT`, `INSTALL_CMD`, `DOCS_URL`.
- Create `apps/site/app/components/landing-v2/dashboard-preview.test.ts` - assert the component copies the canonical `AGENT_ONBOARDING_WITH_INSTALL`.

`install.ts` (`cmdSetup`) needs NO change: it imports `AGENT_ONBOARDING_PROMPT` and `renderAgentOnboarding` from `@ax/lib/agent-onboarding`, both of which keep their names and shapes.

---

## Task 1: Scaffold the `@ax/onboarding-prompt` package

**Files:**
- Create: `packages/onboarding-prompt/package.json`
- Create: `packages/onboarding-prompt/tsconfig.json`
- Create: `packages/onboarding-prompt/src/index.ts`

- [ ] **Step 1: Write the package manifest**

Create `packages/onboarding-prompt/package.json`:

```json
{
  "name": "@ax/onboarding-prompt",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: Write the tsconfig**

Create `packages/onboarding-prompt/tsconfig.json` (mirrors `packages/schema/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write a placeholder module so the package resolves**

Create `packages/onboarding-prompt/src/index.ts`:

```ts
// Canonical "give this to your agent" onboarding prompt. Zero runtime deps so
// both @ax/lib (CLI) and @ax/site (marketing bundle) can import it without
// pulling any heavy graph in. Real content lands in Task 3.
export const AGENT_ONBOARDING_PROMPT = "";
export const AGENT_ONBOARDING_WITH_INSTALL = "";
```

- [ ] **Step 4: Link the workspace**

Run: `bun install`
Expected: completes; `@ax/onboarding-prompt` is linked into the workspace (no error about an unknown workspace package).

- [ ] **Step 5: Verify it resolves**

Run: `bun -e "import('@ax/onboarding-prompt').then(m => console.log(typeof m.AGENT_ONBOARDING_PROMPT))"`
Expected: prints `string`

- [ ] **Step 6: Commit**

```bash
git add packages/onboarding-prompt/package.json packages/onboarding-prompt/tsconfig.json packages/onboarding-prompt/src/index.ts package.json bun.lock
git commit -m "feat(onboarding-prompt): scaffold zero-dep prompt package"
```

(Include `bun.lock` / root `package.json` only if `bun install` changed them.)

---

## Task 2: Write the failing test for the prompt content

**Files:**
- Create: `packages/onboarding-prompt/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/onboarding-prompt/src/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    AGENT_ONBOARDING_PROMPT,
    AGENT_ONBOARDING_WITH_INSTALL,
    AX_INSTALL_CMD,
    AX_DOCS_URL,
    DASHBOARD_PORT,
} from "./index.ts";

describe("onboarding prompt - canonical content", () => {
    test("body opens with the local-and-reviewed framing", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("it runs locally and I review every change");
    });

    test("body carries the founder feedback note", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("A note from Neco (ax's founder)");
    });

    test("body defines the CONTRIBUTE-BACK block once", () => {
        const count = AGENT_ONBOARDING_PROMPT.split("CONTRIBUTE-BACK (do this whenever").length - 1;
        expect(count).toBe(1);
    });

    test("body has a reality-check beat naming verification as the seeded blind-spot", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("does this match how I actually work");
        expect(AGENT_ONBOARDING_PROMPT).toContain("verification often hides");
    });

    test("body points at the serve dashboard port", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain(`http://127.0.0.1:${DASHBOARD_PORT}`);
    });

    test("body is the 5-step post-install variant (no INSTALL step)", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("1. INGEST MY HISTORY");
        expect(AGENT_ONBOARDING_PROMPT).toContain("5. GIVE ME A NEXT STEP");
        expect(AGENT_ONBOARDING_PROMPT).not.toContain("INSTALL - run");
    });

    test("with-install variant prepends the install step and renumbers to 6", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain(`1. INSTALL - run \`${AX_INSTALL_CMD}\``);
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain(AX_DOCS_URL);
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("2. INGEST MY HISTORY");
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("6. GIVE ME A NEXT STEP");
    });

    test("with-install shares the same body steps as the canonical prompt", () => {
        // The reality-check beat must appear in both, proving one source.
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("does this match how I actually work");
    });

    test("no em-dashes survive (repo hook rewrites them; assert ASCII)", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).not.toContain("-");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/onboarding-prompt/src/index.test.ts`
Expected: FAIL - imports `AX_INSTALL_CMD` / `AX_DOCS_URL` / `DASHBOARD_PORT` are undefined and content assertions fail against the empty strings.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/onboarding-prompt/src/index.test.ts
git commit -m "test(onboarding-prompt): pin canonical prompt content + variants"
```

---

## Task 3: Implement the canonical prompt strings

**Files:**
- Modify: `packages/onboarding-prompt/src/index.ts`

- [ ] **Step 1: Write the full implementation**

Replace the entire contents of `packages/onboarding-prompt/src/index.ts` with:

```ts
/**
 * The "give this to your agent" onboarding prompt - ax's parallel to
 * effect.solutions' "Copy Agent Instructions". Single source of truth consumed
 * by the CLI (`ax setup [--agent-prompt]`, install.sh via the binary) and the
 * landing site copy button. Zero runtime deps so the marketing bundle stays
 * free of @ax/lib weight.
 *
 * Drives the agent through ingest -> verify -> reality-check -> label -> next,
 * with a woven CONTRIBUTE-back loop: on a failure, a fact the user disputes, or
 * a spotted bug, the agent interviews then files a github.com/Necmttn/ax issue
 * (confirm-before-send), optionally backed by a redacted `ax share`.
 */

/** Dashboard port. Mirrors @ax/lib's DEFAULT_DASHBOARD_PORT; a @ax/lib test
 *  asserts the two match so this zero-dep copy can't silently drift. */
export const DASHBOARD_PORT = 1738;

/** Install one-liner + docs, single-sourced for the visible install box too. */
export const AX_INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";
export const AX_DOCS_URL = "https://ax.necmttn.com/docs";

const HEADER =
    "Set up ax for me, end to end. ax is a local agent-experience graph over my Claude Code + Codex history - it runs locally and I review every change.";

const FOUNDER_NOTE =
    "A note from Neco (ax's founder): ax is early and I'm hungry for feedback - every bug, wrong number, or rough edge you send back makes it sharper for everyone. Please don't hold back; if something's off, help me fix it.";

const CONTRIBUTE_BLOCK =
    "CONTRIBUTE-BACK (do this whenever a trigger below fires; never publish anything without showing it to me first and getting an explicit yes): Triggers - a step fails; a fact you report looks wrong or surprising to me; you spot a clear bug or improvement in ax itself. When one fires: ask me 2-3 sharp questions to pin down what I expected, which command/hook/agent is involved, and how often - enough for a repro. Then draft a GitHub issue for github.com/Necmttn/ax, show me the full draft, and on my yes file it via `gh` (the ax-repo skill). If a session is the evidence, run `ax share --dry-run` first, show me the redacted gist, and only publish with `ax share` on my yes - then link it in the issue.";

const INSTALL_STEP = `INSTALL - run \`${AX_INSTALL_CMD}\` to install the ax CLI. Reference: ${AX_DOCS_URL}`;

const STEPS: ReadonlyArray<string> = [
    `INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:${DASHBOARD_PORT}. If it fails or lands zero data after finishing, that's a CONTRIBUTE-BACK trigger. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use.`,
    "VERIFY - run `ax doctor`. If anything isn't ok, diagnose and fix it, then re-run until it is. If the cause is a bug in ax itself (not my environment), that's a CONTRIBUTE-BACK trigger.",
    "REALITY CHECK - show me the headline facts (sessions, turns, top skills + tools), then ask: does this match how I actually work? Heads-up: verification often hides inside PR commands, hooks, and subagents, so if a number reads lower than my gut says, that's a likely miss. If I disagree with any fact, that's a CONTRIBUTE-BACK trigger - my disagreement is the repro.",
    "LABEL what ax can't classify - run `ax skills classify`. It writes one `.ax/tasks/classify-<skill>.md` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (`primary_role:` is required; `secondary`, `confidence`, `rationale` are optional). Run `ax roles` to see labels already in use. Then run `ax skills lint` to apply them. If it says \"no unclassified skills\", that's fine. Then show `ax skills weighted` and `ax skills config`; tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.",
    "GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.",
];

/** Compose the prompt: header, founder note, contribute block, then numbered steps. */
const render = (steps: ReadonlyArray<string>): string =>
    [
        HEADER,
        FOUNDER_NOTE,
        CONTRIBUTE_BLOCK,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n\n");

/** Post-install body (5 steps): `ax setup`, install.sh. */
export const AGENT_ONBOARDING_PROMPT = render(STEPS);

/** Pre-install variant (6 steps): the landing copy button paste. */
export const AGENT_ONBOARDING_WITH_INSTALL = render([INSTALL_STEP, ...STEPS]);
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test packages/onboarding-prompt/src/index.test.ts`
Expected: PASS (all assertions in Task 2).

- [ ] **Step 3: Typecheck the package**

Run: `bun --filter @ax/onboarding-prompt run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/onboarding-prompt/src/index.ts
git commit -m "feat(onboarding-prompt): canonical help-then-contribute prompt"
```

---

## Task 4: Re-point `@ax/lib/agent-onboarding` at the micro-package

**Files:**
- Modify: `packages/lib/package.json` (dependencies block)
- Modify: `packages/lib/src/agent-onboarding.ts`
- Modify: `packages/lib/src/agent-onboarding.test.ts`

- [ ] **Step 1: Add the workspace dependency**

In `packages/lib/package.json`, add `@ax/onboarding-prompt` to `dependencies` (keep alphabetical-ish with the existing entries):

```json
  "dependencies": {
    "@ax/onboarding-prompt": "workspace:*",
    "@effect/platform-bun": "4.0.0-beta.78",
    "effect": "catalog:",
    "surrealdb": "^2.0.0"
  },
```

- [ ] **Step 2: Re-export from the micro-package, keep the terminal wrapper**

Replace the entire contents of `packages/lib/src/agent-onboarding.ts` with:

```ts
/**
 * @ax/lib re-export of the canonical onboarding prompt (now owned by the
 * zero-dep @ax/onboarding-prompt package) plus the terminal wrapper used by the
 * CLI. Existing consumers (`install.ts` cmdSetup) import from here unchanged.
 */
export {
    AGENT_ONBOARDING_PROMPT,
    AGENT_ONBOARDING_WITH_INSTALL,
    AX_DOCS_URL,
    AX_INSTALL_CMD,
    DASHBOARD_PORT,
} from "@ax/onboarding-prompt";

import { AGENT_ONBOARDING_PROMPT } from "@ax/onboarding-prompt";

/** Prompt wrapped with a short human-facing header for terminal output. */
export const renderAgentOnboarding = (): string =>
    [
        "▸ Hand the rest to your coding agent. Paste this into Claude Code or Codex:",
        "",
        AGENT_ONBOARDING_PROMPT.split("\n")
            .map((l) => (l ? `    ${l}` : ""))
            .join("\n"),
        "",
    ].join("\n");
```

(`▸` is the existing `▸` marker, kept as an escape so no non-ASCII literal is rewritten by the hook.)

- [ ] **Step 3: Update the lib test - keep the port guard, add the cross-check**

Replace the entire contents of `packages/lib/src/agent-onboarding.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { DASHBOARD_PORT as PROMPT_PORT } from "@ax/onboarding-prompt";
import { AGENT_ONBOARDING_PROMPT, renderAgentOnboarding } from "./agent-onboarding.ts";
import { DEFAULT_DASHBOARD_PORT } from "./dashboard-port.ts";

describe("agent-onboarding dashboard port", () => {
    test("onboarding prompt points at the serve default port", () => {
        // Anti-drift guard for issue #268: the prompt agents paste verbatim
        // must reference the same port `ax serve` actually binds by default.
        expect(AGENT_ONBOARDING_PROMPT).toContain(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`);
    });

    test("micro-package port matches @ax/lib serve default", () => {
        // The zero-dep package inlines the port; this asserts it can't drift
        // from the single source in dashboard-port.ts.
        expect(PROMPT_PORT).toBe(DEFAULT_DASHBOARD_PORT);
    });

    test("no stale port references survive in the rendered onboarding", () => {
        expect(renderAgentOnboarding()).not.toContain("8520");
    });
});
```

- [ ] **Step 4: Install + run the lib tests**

Run: `bun install && bun test packages/lib/src/agent-onboarding.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the CLI consumer still resolves**

Run: `bun -e "import('@ax/lib/agent-onboarding').then(m => console.log(typeof m.AGENT_ONBOARDING_PROMPT, typeof m.renderAgentOnboarding))"`
Expected: prints `string function`

- [ ] **Step 6: Commit**

```bash
git add packages/lib/package.json packages/lib/src/agent-onboarding.ts packages/lib/src/agent-onboarding.test.ts bun.lock
git commit -m "refactor(lib): re-export onboarding prompt from @ax/onboarding-prompt"
```

---

## Task 5: Consume the prompt in the landing site, delete the inline copy

**Files:**
- Modify: `apps/site/package.json` (dependencies block)
- Modify: `apps/site/app/components/landing-v2/dashboard-preview.tsx`
- Create: `apps/site/app/components/landing-v2/dashboard-preview.test.ts`

- [ ] **Step 1: Write the failing test (drift guard for the site)**

Create `apps/site/app/components/landing-v2/dashboard-preview.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_ONBOARDING_WITH_INSTALL } from "@ax/onboarding-prompt";

describe("landing copy button", () => {
    test("uses the canonical with-install prompt (no inline AGENT_PROMPT literal)", () => {
        const src = readFileSync(
            new URL("./dashboard-preview.tsx", import.meta.url),
            "utf8",
        );
        // The component must consume the shared export, not re-author the prompt.
        expect(src).toContain("AGENT_ONBOARDING_WITH_INSTALL");
        expect(src).not.toMatch(/const AGENT_PROMPT\s*=/);
    });

    test("canonical with-install prompt is the 6-step pre-install variant", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("1. INSTALL - run");
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("6. GIVE ME A NEXT STEP");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/site/app/components/landing-v2/dashboard-preview.test.ts`
Expected: FAIL - the component still declares `const AGENT_PROMPT =` and does not reference `AGENT_ONBOARDING_WITH_INSTALL`. (The `@ax/onboarding-prompt` import will also fail to resolve until Step 3 adds the dep - run `bun install` after Step 3.)

- [ ] **Step 3: Add the workspace dependency to the site**

In `apps/site/package.json` `dependencies`, add (next to the existing `@ax/studio` workspace entry):

```json
    "@ax/onboarding-prompt": "workspace:*",
```

Then run: `bun install`
Expected: completes; the site resolves `@ax/onboarding-prompt`.

- [ ] **Step 4: Replace the inline constants with imports**

In `apps/site/app/components/landing-v2/dashboard-preview.tsx`:

Delete these three declarations (currently around lines 149-227 - the `INSTALL_CMD`, `DOCS_URL`, and the full `AGENT_PROMPT` template literal):

```ts
const INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";
const DOCS_URL = "https://ax.necmttn.com/docs";

const AGENT_PROMPT = `Set up ax for me, end to end. ... `;  // the whole literal
```

Add an import at the top of the file (alongside the other imports):

```ts
import {
    AGENT_ONBOARDING_WITH_INSTALL,
    AX_DOCS_URL,
    AX_INSTALL_CMD,
} from "@ax/onboarding-prompt";
```

Then update the references:
- The clipboard copy call (currently `navigator.clipboard.writeText(AGENT_PROMPT)`) becomes `navigator.clipboard.writeText(AGENT_ONBOARDING_WITH_INSTALL)`.
- Any visible use of `INSTALL_CMD` becomes `AX_INSTALL_CMD`; any visible use of `DOCS_URL` becomes `AX_DOCS_URL`. (Grep the file: `rg -n "INSTALL_CMD|DOCS_URL|AGENT_PROMPT" apps/site/app/components/landing-v2/dashboard-preview.tsx` - every hit must now point at the imported names or be removed.)

- [ ] **Step 5: Run the site test to verify it passes**

Run: `bun test apps/site/app/components/landing-v2/dashboard-preview.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Confirm no stray references remain**

Run: `rg -n "AGENT_PROMPT\b|const INSTALL_CMD|const DOCS_URL" apps/site/app/components/landing-v2/dashboard-preview.tsx`
Expected: no output (all replaced/removed).

- [ ] **Step 7: Commit**

```bash
git add apps/site/package.json apps/site/app/components/landing-v2/dashboard-preview.tsx apps/site/app/components/landing-v2/dashboard-preview.test.ts bun.lock
git commit -m "feat(site): consume canonical onboarding prompt, drop inline copy"
```

---

## Task 6: Full verification - tests, typecheck, site build + bundle check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS across the repo (the new package tests, the updated lib + site tests, and everything else green).

- [ ] **Step 2: Repo typecheck**

Run: `bun run typecheck`
Expected: no errors. (If the site's strict-null typecheck requires a prior build per the repo convention, run `bunx turbo run build --filter=@ax/site` first, then re-run.)

- [ ] **Step 3: Build the site and confirm the bundle stays @ax/lib-free**

Run: `bunx turbo run build --filter=@ax/site`
Expected: build succeeds.

Then inspect the built client bundle for leakage from `@ax/lib` heavy modules (the micro-package is zero-dep, so only the prompt strings should appear):

Run: `rg -l "surrealdb|@effect/platform-bun" apps/site/dist 2>/dev/null || echo "no @ax/lib runtime symbols in site bundle"`
Expected: prints `no @ax/lib runtime symbols in site bundle` (or no matching files). If `surrealdb`/effect symbols appear, the import is pulling more than the strings - stop and investigate (the import must be from `@ax/onboarding-prompt`, never `@ax/lib`).

- [ ] **Step 4: Smoke-test the CLI rendering**

Run: `bun apps/axctl/bin/axctl setup --agent-prompt 2>/dev/null | head -20`
Expected: prints the post-install prompt - opens with the "Set up ax for me" header, then the founder note, then the CONTRIBUTE-BACK block, then `1. INGEST MY HISTORY`. No `INSTALL - run` step (that's the with-install variant only).

- [ ] **Step 5: Commit any build-artifact-driven config changes only**

If Steps 1-4 surfaced no source changes, nothing to commit here. If the build required a config tweak (e.g. tsconfig include), commit it:

```bash
git add -p
git commit -m "chore: verification fixups for onboarding-prompt extraction"
```

(Do NOT `git add -A`; per repo norms stage only the intended files. Do not commit `dist/`.)

---

## Self-review notes

- **Spec coverage:** single-source (Tasks 1-5), founder note (Task 3 + test Task 2), woven CONTRIBUTE block defined once (Task 3 + "defined once" test), reality-check beat with verification seed (Task 3 + test), direct-file/`ax share` consent wording (Task 3 copy), port single-source guard (Task 4 cross-check test), no new CLI command (only re-exports; install.ts untouched), bundle stays @ax/lib-free (Task 6 Step 3).
- **No behavioral CLI change:** `cmdSetup` imports the same two names from `@ax/lib/agent-onboarding`; verified by Task 4 Step 5 + Task 6 Step 4.
- **Naming consistency:** exports `AGENT_ONBOARDING_PROMPT`, `AGENT_ONBOARDING_WITH_INSTALL`, `AX_INSTALL_CMD`, `AX_DOCS_URL`, `DASHBOARD_PORT`, `renderAgentOnboarding` are used identically across the package, the lib re-export, the site import, and all tests.
- **Line numbers** in Task 5 are approximate (the file has shifted during this work); the steps key off symbol names + grep, not fixed lines.
