# Slice 0 - Local `ax team sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local, no-backend `ax team sync` that activates a repo's committed `.ax/` non-executable rig (skills + agent definitions) into the runtime, gated by a trust-on-change prompt. Validates the individual-pull wedge before any hosted plumbing.

**Architecture:** `.ax/` (a unified, harness-agnostic team rig committed in the repo) → `ax team sync` scans it, content-hashes each artifact, diffs against a per-machine trust file (`~/.ax/team-trust.json`), shows new/changed artifacts for approval, and copies approved **non-executable** artifacts into the runtime (`~/.claude/skills/<name>/`, `~/.claude/agents/<name>.md`). Executable `.ax/hooks/` are **listed but never activated** (deferred to the mesh security spec). Pure scan/hash/diff/plan logic; thin IO.

**Tech Stack:** Bun, TypeScript (strict), Effect v4 (where it fits), `effect/unstable/cli`. Tests: `bun:test`. No DB (runtime "none", like `ax quota`).

**Spec:** `docs/superpowers/specs/2026-06-15-team-backend-design.md` (on `feat/team-backend-spec`), §"Build order" Slice 0 + §S4.

## The `.ax/` convention (pinned for Slice 0)

```
<repo>/.ax/
  skills/<name>/SKILL.md   (+ bundled files in that dir)   → non-executable, activated
  agents/<name>.md                                         → non-executable, activated
  hooks/*.ts                                               → EXECUTABLE, listed-not-activated (gated)
```
Activation targets (user-level so the rig is active everywhere, and the base for cross-harness later):
- skill `<name>` → copy the dir to `~/.claude/skills/<name>/`
- agent `<name>` → copy to `~/.claude/agents/<name>.md`

Trust file `~/.ax/team-trust.json`: `{ "<kind>:<name>": { hash, activated_at } }`.

## File structure

```
apps/axctl/src/team/
  model.ts      - TeamArtifact, SyncClassification, TrustState (+ types)
  scan.ts       - scanAxFolder(repoRoot, fs) → { artifacts, gated }
  hash.ts       - hashArtifact(artifact) stable content hash
  trust.ts      - load/save ~/.ax/team-trust.json + classify(artifacts, trust) (pure)
  activate.ts   - activate plan + copy into runtime + record trust
apps/axctl/src/cli/commands/team.ts   - `ax team sync [--dry-run] [--yes]`
apps/axctl/src/cli/index.ts           - register teamCommand + teamRuntime (modify)
docs/cli.md · apps/site/public/llms.txt · apps/site/app/routes/docs/-cli-reference.data.ts - document `ax team` (modify; BOTH cli-reference gates - the #414 lesson)
```

Reuse: atomic-write pattern from `apps/axctl/src/quota/cache.ts`; CLI command pattern from `apps/axctl/src/cli/commands/digest.ts` (Command.make + RuntimeManifest, runtime "none" since no DB); `node:fs` is BANNED (check:no-node-fs) - use Bun fs.

---

## Task 1: `model.ts` - types

**Files:** Create `apps/axctl/src/team/model.ts` + `model.test.ts`

- [ ] **Step 1: failing test** `apps/axctl/src/team/model.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { artifactKey, type TeamArtifact } from "./model.ts";

describe("artifactKey", () => {
  it("is kind:name", () => {
    const a: TeamArtifact = { kind: "skill", name: "tdd", path: "/r/.ax/skills/tdd", files: ["SKILL.md"] };
    expect(artifactKey(a)).toBe("skill:tdd");
  });
  it("distinguishes kinds", () => {
    const a: TeamArtifact = { kind: "agent", name: "tdd", path: "/r/.ax/agents/tdd.md", files: ["tdd.md"] };
    expect(artifactKey(a)).toBe("agent:tdd");
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/model.ts`:

```typescript
export type ArtifactKind = "skill" | "agent";

/** A non-executable team-rig artifact discovered in `.ax/`. `path` is the source
 *  (dir for a skill, file for an agent); `files` are the relative file paths to hash/copy. */
export interface TeamArtifact {
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly path: string;
  readonly files: ReadonlyArray<string>; // relative to `path` (a skill dir) or [basename] (an agent file)
}

/** An executable artifact (`.ax/hooks/*`) - listed, never activated in Slice 0. */
export interface GatedArtifact {
  readonly kind: "hook";
  readonly name: string;
  readonly path: string;
}

export interface TrustRecord {
  readonly hash: string;
  readonly activated_at: string; // ISO
}
export type TrustState = Record<string, TrustRecord>;

export interface SyncClassification {
  readonly added: ReadonlyArray<TeamArtifact>;     // not in trust
  readonly changed: ReadonlyArray<TeamArtifact>;   // hash differs from trust
  readonly unchanged: ReadonlyArray<TeamArtifact>; // hash matches trust
}

export const artifactKey = (a: TeamArtifact): string => `${a.kind}:${a.name}`;
```

- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: commit:** `git add apps/axctl/src/team/model.ts apps/axctl/src/team/model.test.ts && git commit -m "feat(team): team-sync artifact model"`

---

## Task 2: `hash.ts` - stable content hash

**Files:** Create `apps/axctl/src/team/hash.ts` + `hash.test.ts`

- [ ] **Step 1: failing test** (pure over an injected file-reader so it's DB/FS-free):

```typescript
import { describe, expect, it } from "bun:test";
import { hashArtifact } from "./hash.ts";
import type { TeamArtifact } from "./model.ts";

const read = (contents: Record<string, string>) => (abs: string) => contents[abs] ?? "";

describe("hashArtifact", () => {
  const a: TeamArtifact = { kind: "skill", name: "tdd", path: "/r/.ax/skills/tdd", files: ["SKILL.md", "ref.md"] };
  it("is stable for identical content", () => {
    const r = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    expect(hashArtifact(a, r)).toBe(hashArtifact(a, r));
  });
  it("changes when any file content changes", () => {
    const r1 = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    const r2 = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "B" });
    expect(hashArtifact(a, r1)).not.toBe(hashArtifact(a, r2));
  });
  it("is independent of file order in `files`", () => {
    const r = read({ "/r/.ax/skills/tdd/SKILL.md": "a", "/r/.ax/skills/tdd/ref.md": "b" });
    const reordered: TeamArtifact = { ...a, files: ["ref.md", "SKILL.md"] };
    expect(hashArtifact(a, r)).toBe(hashArtifact(reordered, r));
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/hash.ts`:

```typescript
import type { TeamArtifact } from "./model.ts";

/** Stable content hash over the artifact's files (sorted path + content), so
 *  reorderings don't change it but any content change does. `readFile(abs)`
 *  returns the file text. Pure given the reader. */
export const hashArtifact = (a: TeamArtifact, readFile: (abs: string) => string): string => {
  const parts = [...a.files].sort().map((rel) => {
    const abs = a.kind === "agent" ? a.path : `${a.path}/${rel}`;
    return `${rel}\0${readFile(abs)}`;
  });
  return Bun.hash(parts.join("\0\0")).toString(16);
};
```

> Implementer note: for an agent (single file), `files = [basename]` and `path` is the file itself; the `a.kind === "agent" ? a.path : ...` keeps the abs path correct. Verify against the scan output in Task 3.

- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: commit.**

---

## Task 3: `scan.ts` - read `.ax/`

**Files:** Create `apps/axctl/src/team/scan.ts` + `scan.test.ts`

- [ ] **Step 1: failing test** - use a real temp dir (Bun) so the fs walk is exercised:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { scanAxFolder } from "./scan.ts";

let root: string;
beforeAll(async () => {
  root = `/tmp/ax-team-scan-${process.pid}`;
  await Bun.write(`${root}/.ax/skills/tdd/SKILL.md`, "tdd skill");
  await Bun.write(`${root}/.ax/skills/tdd/ref.md`, "ref");
  await Bun.write(`${root}/.ax/agents/reviewer.md`, "agent");
  await Bun.write(`${root}/.ax/hooks/guard.ts`, "export default {}");
});
afterAll(() => { Bun.spawnSync(["rm", "-rf", root]); });

describe("scanAxFolder", () => {
  it("finds skills (with bundled files), agents, and gates hooks", async () => {
    const { artifacts, gated } = await scanAxFolder(root);
    const skill = artifacts.find((a) => a.kind === "skill" && a.name === "tdd");
    expect(skill?.files.sort()).toEqual(["SKILL.md", "ref.md"]);
    expect(artifacts.find((a) => a.kind === "agent" && a.name === "reviewer")).toBeTruthy();
    expect(gated.map((g) => g.name)).toEqual(["guard"]);
  });
  it("returns empty for a repo with no .ax/", async () => {
    const { artifacts, gated } = await scanAxFolder(`/tmp/ax-team-none-${process.pid}`);
    expect(artifacts).toEqual([]);
    expect(gated).toEqual([]);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/scan.ts` using Bun's filesystem APIs (NO node:fs). Use `Bun.Glob` to walk:

```typescript
import { Glob } from "bun";
import type { GatedArtifact, TeamArtifact } from "./model.ts";

export interface ScanResult {
  readonly artifacts: ReadonlyArray<TeamArtifact>;
  readonly gated: ReadonlyArray<GatedArtifact>;
}

/** Scan `<repoRoot>/.ax/` for the team rig. Skills = each `skills/<name>/SKILL.md`
 *  (+ sibling files); agents = each `agents/<name>.md`; hooks = `hooks/*` (gated). */
export const scanAxFolder = async (repoRoot: string): Promise<ScanResult> => {
  const ax = `${repoRoot}/.ax`;
  const artifacts: TeamArtifact[] = [];
  const gated: GatedArtifact[] = [];

  // skills: a dir with a SKILL.md
  for await (const rel of new Glob("skills/*/SKILL.md").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.split("/")[1]!;
    const dir = `${ax}/skills/${name}`;
    const files: string[] = [];
    for await (const f of new Glob("**/*").scan({ cwd: dir, onlyFiles: true })) files.push(f);
    artifacts.push({ kind: "skill", name, path: dir, files });
  }
  // agents: agents/<name>.md
  for await (const rel of new Glob("agents/*.md").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.slice("agents/".length, -".md".length);
    artifacts.push({ kind: "agent", name, path: `${ax}/${rel}`, files: [`${name}.md`] });
  }
  // hooks: gated (executable)
  for await (const rel of new Glob("hooks/*").scan({ cwd: ax, onlyFiles: true })) {
    const name = rel.slice("hooks/".length).replace(/\.[^.]+$/, "");
    gated.push({ kind: "hook", name, path: `${ax}/${rel}` });
  }
  return {
    artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name)),
    gated: gated.sort((a, b) => a.name.localeCompare(b.name)),
  };
};
```

> Implementer note: confirm `Bun.Glob` is available in this Bun version and the `scan({cwd,onlyFiles})` async-iterator API matches; adapt if the API differs (e.g. `glob.scanSync`). The agent `files:[`${name}.md`]` + `path` pointing at the file must match `hash.ts`'s `kind==="agent"` branch. A missing `.ax/` dir → empty result (Glob over a non-existent cwd yields nothing; verify it doesn't throw - wrap in a dir-exists check if it does).

- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: commit.**

---

## Task 4: `trust.ts` - trust file + classify

**Files:** Create `apps/axctl/src/team/trust.ts` + `trust.test.ts`

- [ ] **Step 1: failing test:**

```typescript
import { describe, expect, it } from "bun:test";
import { classify } from "./trust.ts";
import type { TeamArtifact, TrustState } from "./model.ts";

const art = (name: string): TeamArtifact => ({ kind: "skill", name, path: `/r/.ax/skills/${name}`, files: ["SKILL.md"] });

describe("classify", () => {
  it("buckets added / changed / unchanged by hash", () => {
    const arts = [art("a"), art("b"), art("c")];
    const hashes = { "skill:a": "h1", "skill:b": "h2", "skill:c": "h3" };
    const trust: TrustState = {
      "skill:b": { hash: "h2", activated_at: "x" },     // unchanged
      "skill:c": { hash: "OLD", activated_at: "x" },    // changed
    };                                                    // a absent → added
    const c = classify(arts, (a) => hashes[`${a.kind}:${a.name}`]!, trust);
    expect(c.added.map((x) => x.name)).toEqual(["a"]);
    expect(c.changed.map((x) => x.name)).toEqual(["c"]);
    expect(c.unchanged.map((x) => x.name)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/trust.ts`:

```typescript
import { decodeJsonOrNull } from "@ax/lib/decode";
import { artifactKey, type SyncClassification, type TeamArtifact, type TrustState } from "./model.ts";

export const defaultTrustPath = (): string => `${process.env.HOME}/.ax/team-trust.json`;

export async function loadTrust(path: string): Promise<TrustState> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return {};
    const parsed = decodeJsonOrNull(await f.text());
    return parsed && typeof parsed === "object" ? (parsed as TrustState) : {};
  } catch { return {}; }
}

export async function saveTrust(path: string, state: TrustState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const r = Bun.spawnSync(["mv", tmp, path]);
  if (r.exitCode !== 0) { Bun.spawnSync(["rm", "-f", tmp]); throw new Error(`saveTrust: mv failed (${r.exitCode})`); }
}

/** Pure: bucket artifacts vs trusted hashes. `hashOf` gives each artifact's current hash. */
export const classify = (
  artifacts: ReadonlyArray<TeamArtifact>,
  hashOf: (a: TeamArtifact) => string,
  trust: TrustState,
): SyncClassification => {
  const added: TeamArtifact[] = [], changed: TeamArtifact[] = [], unchanged: TeamArtifact[] = [];
  for (const a of artifacts) {
    const rec = trust[artifactKey(a)];
    if (!rec) added.push(a);
    else if (rec.hash !== hashOf(a)) changed.push(a);
    else unchanged.push(a);
  }
  return { added, changed, unchanged };
};
```

- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: commit.**

---

## Task 5: `activate.ts` - copy into runtime + record trust

**Files:** Create `apps/axctl/src/team/activate.ts` + `activate.test.ts`

- [ ] **Step 1: failing test** (real temp dirs):

```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { runtimeTarget, activateArtifact } from "./activate.ts";
import type { TeamArtifact } from "./model.ts";

describe("runtimeTarget", () => {
  it("maps skill → ~/.claude/skills/<name>, agent → ~/.claude/agents/<name>.md", () => {
    expect(runtimeTarget({ kind: "skill", name: "tdd", path: "x", files: [] }, "/home/u"))
      .toBe("/home/u/.claude/skills/tdd");
    expect(runtimeTarget({ kind: "agent", name: "rev", path: "x", files: [] }, "/home/u"))
      .toBe("/home/u/.claude/agents/rev.md");
  });
});

describe("activateArtifact", () => {
  const home = `/tmp/ax-team-act-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", home]));
  it("copies a skill dir into the runtime", async () => {
    const src = `/tmp/ax-team-src-${process.pid}`;
    await Bun.write(`${src}/SKILL.md`, "hi");
    const a: TeamArtifact = { kind: "skill", name: "tdd", path: src, files: ["SKILL.md"] };
    await activateArtifact(a, home);
    expect(await Bun.file(`${home}/.claude/skills/tdd/SKILL.md`).text()).toBe("hi");
    Bun.spawnSync(["rm", "-rf", src]);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/activate.ts` (copy via Bun + `cp -R` for dirs - node:fs banned):

```typescript
import type { TeamArtifact } from "./model.ts";

export const runtimeTarget = (a: TeamArtifact, home: string): string =>
  a.kind === "skill" ? `${home}/.claude/skills/${a.name}` : `${home}/.claude/agents/${a.name}.md`;

/** Copy an artifact's source into its runtime target (idempotent overwrite). */
export async function activateArtifact(a: TeamArtifact, home: string): Promise<void> {
  const target = runtimeTarget(a, home);
  if (a.kind === "agent") {
    const text = await Bun.file(a.path).text();
    await Bun.write(target, text, { createPath: true });
    return;
  }
  // skill dir: ensure parent, replace target dir
  Bun.spawnSync(["mkdir", "-p", `${home}/.claude/skills`]);
  Bun.spawnSync(["rm", "-rf", target]);
  const r = Bun.spawnSync(["cp", "-R", a.path, target]);
  if (r.exitCode !== 0) throw new Error(`activate ${a.name}: cp failed (${r.exitCode})`);
}
```

- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: commit.**

---

## Task 6: `ax team sync` CLI + docs + both cli-reference gates + e2e

**Files:** Create `apps/axctl/src/cli/commands/team.ts` + `team.test.ts`; modify `apps/axctl/src/cli/index.ts`, `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`

- [ ] **Step 1: failing test** for the pure renderer:

```typescript
import { describe, expect, it } from "bun:test";
import { renderSyncReport } from "./team.ts";

describe("renderSyncReport", () => {
  it("summarizes activated, unchanged, and gated", () => {
    const out = renderSyncReport({ activated: ["skill:tdd", "agent:rev"], unchanged: ["skill:x"], gated: ["guard"] });
    expect(out).toContain("activated 2");
    expect(out).toContain("1 unchanged");
    expect(out).toContain("guard");
    expect(out).toMatch(/gated|executable|trust/i);
  });
  it("empty-state when no .ax/", () => {
    expect(renderSyncReport({ activated: [], unchanged: [], gated: [] })).toContain("no team rig");
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/cli/commands/team.ts`. Mirror `apps/axctl/src/cli/commands/digest.ts` for `Command.make` + `RuntimeManifest` (runtime **"none"** - no DB, like quota). The command resolves the git repo root, scans, hashes, classifies, prompts for new/changed (unless `--yes` or `--dry-run`), activates approved, updates trust, prints `renderSyncReport`. Pure `renderSyncReport`:

```typescript
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { jsonFlag } from "./shared.ts";          // reuse boolean-flag idiom if useful
import type { RuntimeManifest } from "./manifest.ts";
import { scanAxFolder } from "../../team/scan.ts";
import { hashArtifact } from "../../team/hash.ts";
import { classify, loadTrust, saveTrust, defaultTrustPath } from "../../team/trust.ts";
import { activateArtifact } from "../../team/activate.ts";
import { artifactKey } from "../../team/model.ts";

export const renderSyncReport = (r: { activated: string[]; unchanged: string[]; gated: string[] }): string => {
  if (r.activated.length === 0 && r.unchanged.length === 0 && r.gated.length === 0)
    return "[ax team] no team rig found (.ax/ has no skills or agents).";
  const lines = [`[ax team] sync: activated ${r.activated.length}, ${r.unchanged.length} unchanged`];
  for (const k of r.activated) lines.push(`  + ${k}`);
  if (r.gated.length) lines.push(`gated (executable hooks - require the mesh trust layer, NOT activated): ${r.gated.join(", ")}`);
  return lines.join("\n");
};
```

The command body (Effect.gen): resolve repo root via `git rev-parse --show-toplevel` (Bun.spawnSync); `scanAxFolder`; build `hashOf` reading files via `Bun.file(abs).text()` sync-ish (read all needed files first, or make hashArtifact accept an async reader - simplest: pre-read every artifact's files into a map, then `hashArtifact(a, (abs)=>map[abs])`); `loadTrust`; `classify`; if `--dry-run` print plan + exit; else for `added`+`changed` either auto-approve (`--yes`) or prompt (read a yes/no from stdin - keep simple; if not a TTY, require `--yes`); `activateArtifact` each approved; update trust with the new hashes + `activated_at`; `saveTrust`; print `renderSyncReport`. Read `apps/axctl/src/cli/commands/digest.ts` for the exact `Command.make`/`RuntimeManifest` shape; `teamRuntime = { team: { runtime: "none", hidden: false } }`.

> Implementer note: `team` is a command GROUP (`ax team sync`) - model it as a subcommand of a `team` group, OR (simpler for Slice 0) a single `ax team sync`. Mirror how an existing group command is built (grep a `Command` with subcommands, e.g. `sessions`/`cost`); if groups are heavy, ship `ax team` with `sync` as its only action. Keep `renderSyncReport` pure + tested regardless. Interactive prompt: if `process.stdin.isTTY` is false and there are added/changed artifacts and no `--yes`, print "re-run with --yes to approve N new/changed artifacts" and activate nothing (fail-safe - never auto-activate without approval).

- [ ] **Step 4: register + document.** index.ts: import + `...teamRuntime` + `teamCommand`. Document `ax team` in docs/cli.md (a `## Team` section), llms.txt (a `- \`ax team sync\`` line), and a `team` card in `-cli-reference.data.ts` (mirror the `digest`/`usage` cards; signature `ax team sync [--dry-run] [--yes]`; no axctl/`/Users` in copy).

- [ ] **Step 5: verify - tests + BOTH gates + typecheck + e2e:**
```
bun test apps/axctl/src/team apps/axctl/src/cli/commands/team.test.ts
bun scripts/check-cli-reference.ts 2>&1 | tail -1
bun test scripts/check-site-cli-reference.test.ts 2>&1 | tail -3
bun run typecheck 2>&1 | rg -c "error TS"
# e2e: build a fake team rig + sync it
rm -rf /tmp/axteam && mkdir -p /tmp/axteam && (cd /tmp/axteam && git init -q)
mkdir -p /tmp/axteam/.ax/skills/demo-skill /tmp/axteam/.ax/agents /tmp/axteam/.ax/hooks
printf -- '---\nname: demo-skill\ndescription: a demo\n---\nbody\n' > /tmp/axteam/.ax/skills/demo-skill/SKILL.md
printf 'agent body\n' > /tmp/axteam/.ax/agents/demo-agent.md
printf 'export default {}\n' > /tmp/axteam/.ax/hooks/demo-hook.ts
cd /tmp/axteam && bun run /Users/necmttn/Projects/ax/.claude/worktrees/team-sync/apps/axctl/src/cli/index.ts team sync --yes
ls ~/.claude/skills/demo-skill/SKILL.md ~/.claude/agents/demo-agent.md   # should exist
# idempotency: re-run → "unchanged"
cd /tmp/axteam && bun run /Users/necmttn/Projects/ax/.claude/worktrees/team-sync/apps/axctl/src/cli/index.ts team sync --yes
```
Expected: tests pass; both gates cover `ax team`; 0 typecheck errors; the demo skill + agent land in the runtime; the hook is reported gated (not activated - confirm `ls ~/.ax/hooks/demo-hook.ts` does NOT exist / it's not installed); second run reports unchanged. **Cleanup after e2e:** `rm -rf ~/.claude/skills/demo-skill ~/.claude/agents/demo-agent.md /tmp/axteam` and remove the demo entries from `~/.ax/team-trust.json` (don't leave demo state on the dev machine - the repo-root-clean rule).

- [ ] **Step 6: commit.**

---

## Self-Review Notes
- **Security (Slice 0):** only non-executable artifacts (skills/agents) are copied; `.ax/hooks/*` are listed-not-activated (the RCE carve-out). Trust-on-change: new/changed artifacts require approval (`--yes` or interactive); non-TTY without `--yes` activates nothing. This is the v1-sync behavior from spec §S4.
- **No backend/auth/secrets** - pure local. Runtime "none" (no DB).
- **CI gotchas carried from #414:** BOTH cli-reference gates + the docs updated in Task 6.
- **Cleanup:** e2e must not leave demo skills/agents/trust on the dev machine.
