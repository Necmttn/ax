# Mesh B - `.ax.local/` Experiment Overlay + Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a dev iterate on a variant of a team artifact in an **isolated, gitignored `.ax.local/` overlay** (no branch, nothing shared), have `ax team sync`/`trust` activate the overlay version over the committed one, and **promote** a proven variant (`.ax.local/ → .ax/` + a PR). The "separate threads" mechanism with no clean tool today.

**Architecture:** `.ax.local/` mirrors `.ax/`'s structure (`skills/`/`agents/`/`hooks/`) and is gitignored. `scanWithOverlay(root)` merges committed `.ax/` + `.ax.local/`, with the overlay **winning** on name collision - so a dev's experiment is what gets activated, only for them. `ax team experiment start|list|promote|drop` manage the overlay. Promote moves the overlay artifact into the committed `.ax/` and opens a PR (the team reviews; cross-dev telemetry-gated scoring is the deferred hosted phase). No backend, no auth, no secrets.

**Tech Stack:** Bun + TS + Effect v4 + `effect/unstable/cli`. No DB (runtime "none"). Tests: `bun:test`. `node:fs` banned (Bun fs). Reuse Slice 0 `apps/axctl/src/team/{scan,model,activate}.ts` + the Mesh A `team.ts` command group.

**Spec:** `docs/superpowers/specs/2026-06-15-team-backend-design.md` build-order step 2.

## Scope (v1, local)

IN: the overlay (`.ax.local/`), overlay-aware activation (sync + trust prefer the overlay), and `ax team experiment start/list/promote/drop`.
DEFERRED (hosted/fast-follow): `ax team experiment score` (telemetry-gated, cross-dev effectiveness) - v1 promote opens a PR for human review; the measured gate is the hosted phase.

## File structure

```
apps/axctl/src/team/
  overlay.ts      - scanWithOverlay(root) (merge .ax/ + .ax.local/, overlay wins) + AX_LOCAL_DIR + ensureGitignored
  experiment.ts   - start / list / drop / promote (pure plan + thin IO over .ax.local/ and .ax/)
apps/axctl/src/cli/commands/team.ts  - add `experiment` subgroup; switch sync+trust to scanWithOverlay (modify)
docs/cli.md · llms.txt · -cli-reference.data.ts  - document `ax team experiment` (BOTH gates)
```

The `.ax.local/` convention mirrors `.ax/`: `.ax.local/skills/<name>/SKILL.md`, `.ax.local/agents/<name>.md`, `.ax.local/hooks/<name>.ts`.

---

## Task 1: `overlay.ts` - overlay-merged scan

**Files:** Create `apps/axctl/src/team/overlay.ts` + `overlay.test.ts`

- [ ] **Step 1: failing test** (real temp dirs; overlay precedence is the key behavior):

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { scanWithOverlay } from "./overlay.ts";

let root: string;
beforeAll(async () => {
  root = `/tmp/ax-overlay-${process.pid}`;
  // committed rig
  await Bun.write(`${root}/.ax/skills/shared/SKILL.md`, "committed shared");
  await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "committed tdd");
  await Bun.write(`${root}/.ax/hooks/guard.ts`, "committed hook");
  // overlay: overrides tdd, adds experiment-only, overrides the hook
  await Bun.write(`${root}/.ax.local/skills/tdd/SKILL.md`, "OVERLAY tdd");
  await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "overlay-only");
  await Bun.write(`${root}/.ax.local/hooks/guard.ts`, "OVERLAY hook");
});
afterAll(() => Bun.spawnSync(["rm", "-rf", root]));

describe("scanWithOverlay", () => {
  it("overlay wins on name collision; overlay-only artifacts appear; committed-only survive; each flagged", async () => {
    const { artifacts, gated } = await scanWithOverlay(root);
    const tdd = artifacts.find((a) => a.kind === "skill" && a.name === "tdd");
    expect(tdd?.path).toContain(".ax.local/skills/tdd");  // overlay path wins
    expect(tdd?.overlay).toBe(true);
    const shared = artifacts.find((a) => a.kind === "skill" && a.name === "shared");
    expect(shared?.path).toContain("/.ax/skills/shared"); // committed survives
    expect(shared?.overlay).toBe(false);
    expect(artifacts.find((a) => a.name === "exp")?.overlay).toBe(true); // overlay-only
    const guard = gated.find((g) => g.name === "guard");
    expect(guard?.path).toContain(".ax.local/hooks/guard"); // overlay hook wins
    expect(guard?.overlay).toBe(true);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/overlay.ts`. Reuse `scanAxFolder` by scanning BOTH dirs and merging. Add an `overlay: boolean` flag to the returned artifacts (extend the shape locally - the scan returns `TeamArtifact`/`GatedArtifact`; wrap with `{ ...a, overlay }`). The scanner reads `<root>/.ax` and `<root>/.ax.local`; `scanAxFolder` already takes a dir whose `.ax` subpath it reads - so call it with a base that makes it read `.ax.local`. Check `scan.ts`: it reads `${repoRoot}/.ax`. To scan `.ax.local`, pass a path such that `${X}/.ax` === `${root}/.ax.local`. Cleanest: add an optional 2nd arg to `scanAxFolder(repoRoot, subdir=".ax")`, OR write a tiny local scanner. Implementer: prefer extending `scanAxFolder` with a `subdir` param (default `.ax`) so overlay reuses it (`scanAxFolder(root, ".ax.local")`). Then:

```typescript
import { scanAxFolder } from "./scan.ts";
import type { GatedArtifact, TeamArtifact } from "./model.ts";

export const AX_LOCAL_DIR = ".ax.local";

export type OverlayArtifact = TeamArtifact & { readonly overlay: boolean };
export type OverlayGated = GatedArtifact & { readonly overlay: boolean };
export interface OverlayScan { readonly artifacts: ReadonlyArray<OverlayArtifact>; readonly gated: ReadonlyArray<OverlayGated>; }

/** Merge committed `.ax/` + `.ax.local/`, overlay winning on (kind,name). */
export const scanWithOverlay = async (root: string): Promise<OverlayScan> => {
  const base = await scanAxFolder(root, ".ax");
  const over = await scanAxFolder(root, AX_LOCAL_DIR);
  const merge = <T extends { kind: string; name: string }>(b: ReadonlyArray<T>, o: ReadonlyArray<T>) => {
    const byKey = new Map<string, T & { overlay: boolean }>();
    for (const x of b) byKey.set(`${x.kind}:${x.name}`, { ...x, overlay: false });
    for (const x of o) byKey.set(`${x.kind}:${x.name}`, { ...x, overlay: true }); // overlay wins
    return [...byKey.values()].sort((a, b2) => a.name.localeCompare(b2.name));
  };
  return {
    artifacts: merge(base.artifacts, over.artifacts) as OverlayArtifact[],
    gated: merge(base.gated, over.gated) as OverlayGated[],
  };
};
```

> Implementer: add the `subdir = ".ax"` param to `scanAxFolder` in `scan.ts` (default keeps all existing callers working - verify the existing scan tests still pass). Confirm `scanAxFolder` returns empty (not throws) when `.ax.local` is absent (it already guards a missing dir).

- [ ] **Step 4: run, PASS** (overlay test + the existing `scan.test.ts` still green). **Step 5: commit.**

---

## Task 2: `experiment.ts` - start / list / drop / promote (pure plan + IO)

**Files:** Create `apps/axctl/src/team/experiment.ts` + `experiment.test.ts`

- [ ] **Step 1: failing test** - test the pure path helpers + the start/promote/drop plans against real temp dirs:

```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { overlayPath, committedPath, startExperiment, promoteExperiment, dropExperiment, isSafeKindName } from "./experiment.ts";

describe("paths + guard", () => {
  it("maps kind/name to overlay + committed paths", () => {
    expect(overlayPath("/r", "skill", "x")).toBe("/r/.ax.local/skills/x");
    expect(committedPath("/r", "agent", "y")).toBe("/r/.ax/agents/y.md");
  });
  it("rejects unsafe kind/name", () => {
    expect(isSafeKindName("skill", "x")).toBe(true);
    expect(isSafeKindName("skill", "../e")).toBe(false);
    expect(isSafeKindName("bogus", "x")).toBe(false);
  });
});

describe("start / promote / drop", () => {
  const root = `/tmp/ax-exp-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", root]));
  it("start copies a committed skill into the overlay (or scaffolds new)", async () => {
    await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "committed");
    await startExperiment(root, "skill", "tdd");
    expect(await Bun.file(`${root}/.ax.local/skills/tdd/SKILL.md`).text()).toBe("committed");
  });
  it("start scaffolds a new overlay skill when none committed", async () => {
    await startExperiment(root, "skill", "fresh");
    expect(await Bun.file(`${root}/.ax.local/skills/fresh/SKILL.md`).exists()).toBe(true);
  });
  it("promote moves overlay → committed and removes the overlay copy", async () => {
    await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "variant");
    await promoteExperiment(root, "skill", "exp");
    expect(await Bun.file(`${root}/.ax/skills/exp/SKILL.md`).text()).toBe("variant");
    expect(await Bun.file(`${root}/.ax.local/skills/exp/SKILL.md`).exists()).toBe(false);
  });
  it("drop removes the overlay artifact", async () => {
    await Bun.write(`${root}/.ax.local/skills/exp/SKILL.md`, "v");
    await dropExperiment(root, "skill", "exp");
    expect(await Bun.file(`${root}/.ax.local/skills/exp/SKILL.md`).exists()).toBe(false);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/experiment.ts`. Path-traversal guard on kind+name (writes/moves into the repo). `kind ∈ {skill,agent,hook}`. Skills are dirs; agents/hooks are files. Use Bun + shell (`cp -R`, `mkdir -p`, `mv`, `rm -rf` - node:fs banned):

```typescript
const KINDS = new Set(["skill", "agent", "hook"]);
const NAME_RE = /^[a-zA-Z0-9._-]+$/;
export const isSafeKindName = (kind: string, name: string): boolean =>
  KINDS.has(kind) && NAME_RE.test(name) && name !== "." && name !== "..";

const sub = (kind: string) => (kind === "skill" ? "skills" : kind === "agent" ? "agents" : "hooks");
const leaf = (kind: string, name: string) => (kind === "skill" ? name : `${name}.${kind === "agent" ? "md" : "ts"}`);
export const overlayPath = (root: string, kind: string, name: string) => `${root}/.ax.local/${sub(kind)}/${kind === "skill" ? name : leaf(kind, name)}`;
export const committedPath = (root: string, kind: string, name: string) => `${root}/.ax/${sub(kind)}/${kind === "skill" ? name : leaf(kind, name)}`;
```

Implement `startExperiment` (copy committed→overlay if exists, else scaffold a minimal SKILL.md/agent/hook stub), `promoteExperiment` (overlay→committed via mkdir -p parent + cp -R/mv + rm -rf overlay), `dropExperiment` (rm -rf overlay path). Each guards `isSafeKindName` first and throws otherwise. For a skill (dir) use `cp -R`; for agent/hook (file) use content read+write or `cp`. Scaffold templates: skill = `---\nname: <name>\ndescription: TODO\n---\n`, agent = `---\nname: <name>\ndescription: TODO\n---\n`, hook = `import { defineHook } from "@ax/hooks-sdk/define";\nexport default defineHook({ name: "<name>", events: [], run: () => ({ _tag: "Allow" }) });\n`.

> Implementer: keep the path/guard helpers exactly as tested. promote into a hook re-enters the trust flow (the dev runs `ax team trust` after promote + PR-merge) - note that; promote does NOT auto-install. Each IO fn guards the name first.

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 3: overlay-aware sync + trust + gitignore

**Files:** Modify `apps/axctl/src/cli/commands/team.ts`

- [ ] **Step 1:** switch `ax team sync`'s scan from `scanAxFolder(root)` to `scanWithOverlay(root)` so the overlay version activates. The artifacts now carry `overlay: boolean` - in the sync report, mark overlaid artifacts (e.g. `+ skill:tdd (experiment)`). Same for `ax team trust`'s gated hooks (use `scanWithOverlay(root).gated`). Behavior otherwise unchanged (trust/sync semantics identical; the overlay just changes WHICH file is the source).
- [ ] **Step 2:** ensure `.ax.local/` is gitignored. Add a helper used by `experiment start`: if `<root>/.gitignore` doesn't already ignore `.ax.local/`, append it (idempotent). (Or: since `.ax/*` may already be carved per the rig PR, `.ax.local/` is a separate path that must be explicitly ignored - `experiment start` ensures `.gitignore` has a `.ax.local/` line.)
- [ ] **Step 3:** verify existing `team.test.ts` (sync/trust renderers) still pass; `bun run typecheck` 0. **Step 4: commit.**

---

## Task 4: `ax team experiment` CLI subgroup

**Files:** Modify `apps/axctl/src/cli/commands/team.ts` + `team.test.ts`

- [ ] **Step 1: failing test** for the pure list renderer:

```typescript
import { renderExperimentList } from "./team.ts";
describe("renderExperimentList", () => {
  it("lists overlay artifacts with shadow info", () => {
    const out = renderExperimentList([{ key: "skill:tdd", shadows: true }, { key: "skill:exp", shadows: false }]);
    expect(out).toContain("skill:tdd");
    expect(out).toMatch(/shadow|overrides/i);
  });
  it("empty-state", () => { expect(renderExperimentList([])).toContain("no experiments"); });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** the `experiment` subgroup under `team`, mirroring the `sync`/`trust` subcommand wiring. Subcommands:
  - `ax team experiment start <kind> <name>` → `startExperiment` + ensure `.ax.local/` gitignored; print "editing .ax.local/<...> - iterate, then `ax team sync` (or `trust` for hooks) to activate, `ax team experiment promote` to ship".
  - `ax team experiment list` → `scanWithOverlay(root)`, filter `overlay:true`, render (mark which shadow a committed artifact).
  - `ax team experiment promote <kind> <name>` → `promoteExperiment` + `git add` the new `.ax/<...>` + print the `gh pr create` command (do NOT auto-open; print guidance). Note: a promoted hook needs `ax team trust` after the PR merges.
  - `ax team experiment drop <kind> <name>` → `dropExperiment`.
  Args: `<kind>` and `<name>` positionals (validate via `isSafeKindName`; error cleanly on bad input). `renderExperimentList` pure + tested.
- [ ] **Step 4: register** under the `team` group's `Command.withSubcommands([syncCommand, trustCommand, experimentCommand])`. `bun run typecheck` 0. **Step 5: commit.**

---

## Task 5: docs + both cli-reference gates + e2e

**Files:** modify `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`

- [ ] **Step 1: document** `ax team experiment <start|list|promote|drop>` in all three (the `team` card's `sub:` list gains `experiment`).
- [ ] **Step 2: gates + tests + typecheck:**
```
bun test apps/axctl/src/team apps/axctl/src/cli/commands/team.test.ts
bun scripts/check-cli-reference.ts 2>&1 | tail -1
bun test scripts/check-site-cli-reference.test.ts 2>&1 | tail -3
bun run typecheck 2>&1 | rg -c "error TS"
```
- [ ] **Step 3: e2e** (the experiment loop):
```
W=/Users/necmttn/Projects/ax/.claude/worktrees/team-experiment
rm -rf /tmp/axexp && mkdir -p /tmp/axexp/.ax/skills/shared && (cd /tmp/axexp && git -c init.defaultBranch=main init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init)
printf -- '---\nname: shared\ndescription: x\n---\nbody\n' > /tmp/axexp/.ax/skills/shared/SKILL.md
cd /tmp/axexp
bun run $W/apps/axctl/src/cli/index.ts team experiment start skill myexp 2>&1 | head -4
ls .ax.local/skills/myexp/SKILL.md && echo "overlay created"
grep -q ".ax.local" .gitignore && echo ".ax.local gitignored"
bun run $W/apps/axctl/src/cli/index.ts team experiment list 2>&1 | head -4
# sync activates the overlay (into a temp HOME so we don't touch the real runtime)
HOME=/tmp/axexp-home bun run $W/apps/axctl/src/cli/index.ts team sync --yes 2>&1 | head -6
ls /tmp/axexp-home/.claude/skills/myexp/SKILL.md && echo "overlay skill activated"
# promote → moves to .ax/ + prints PR guidance
bun run $W/apps/axctl/src/cli/index.ts team experiment promote skill myexp 2>&1 | head -6
ls .ax/skills/myexp/SKILL.md && echo "promoted to committed"
ls .ax.local/skills/myexp 2>/dev/null && echo "overlay STILL present (bad)" || echo "overlay cleared after promote"
```
Expected: start creates `.ax.local/skills/myexp` + gitignores `.ax.local/`; list shows it; sync activates the overlay version (into the temp HOME); promote moves it to `.ax/skills/myexp`, clears the overlay, and prints a `gh pr create` hint. Paste output.
- [ ] **Step 4: CLEANUP:** `rm -rf /tmp/axexp /tmp/axexp-home`.
- [ ] **Step 5: commit.**

---

## Self-Review Notes
- **Isolation:** the overlay is gitignored (`experiment start` ensures it) - nothing is shared until `promote` opens a PR. No branch of the main repo needed.
- **Security:** path-traversal guard on kind+name; promoted hooks re-enter the Mesh A trust gate (`ax team trust`) - promote never auto-installs an executable.
- **Reuse:** `scanAxFolder` (param-extended for the overlay), the Slice-0 activate path, the Mesh A trust flow.
- **Scope honesty:** `experiment score` (telemetry-gated, cross-dev) is DEFERRED to the hosted phase - v1 promote = isolate→iterate→PR, the measured gate comes with the backend.
- **CI:** BOTH cli-reference gates; the e2e git setup uses `-c user.email/-c user.name` (CI has no global git identity - the Mesh A lesson).
