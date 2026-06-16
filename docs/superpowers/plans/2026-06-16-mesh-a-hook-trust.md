# Mesh A - Executable-Hook Trust Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let `ax team` activate the team's **executable** `.ax/hooks/*` - but only through a real trust gate: a **sha256** content-pin, **trust-on-change** (interactive diff + approval), **trusted-branch-only**, never auto-on-pull.

**Architecture:** Slice 0 lists `.ax/hooks/*` as gated. Mesh A adds `ax team trust`: it sha256-hashes each hook, classifies new/changed/trusted against `~/.ax/team-trust-exec.json`, **refuses unless on the repo's default branch** (a feature branch could smuggle a malicious hook), shows new/changed hooks (with a diff for changed) for explicit approval, then **snapshots the approved content to `~/.ax/hooks/<name>.ts`** and installs it via the existing `installHookFile`. The trust gate is the human approval; the sha256 makes "changed" detection a security boundary (a non-crypto hash would be insufficient here).

**Tech Stack:** Bun + TS + Effect v4 + `effect/unstable/cli`. sha256 via `node:crypto` `createHash` (allowed; only `node:fs` is banned). Reuse `apps/axctl/src/hooks/sdk-install.ts` `installHookFile`. Tests: `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-team-backend-design.md` §"Build order" step 1 (Mesh A) + §S4. Builds on Slice 0 (`apps/axctl/src/team/`, merged #440).

## Threat model (what this defends)

A teammate `git pull`s; `.ax/hooks/enforce-x.ts` is new or changed. Without a gate, activating it = arbitrary code execution on every machine (a merged PR or one compromised push = RCE). Mesh A makes activation **explicit + content-pinned + branch-restricted**. It does NOT defend against a malicious *default-branch* commit that passes human review (that's the team's PR review) - it defends against silent/auto activation and against feature-branch / unreviewed-checkout smuggling.

## File structure

```
apps/axctl/src/team/
  exec-hash.ts    - sha256OfFile(abs): full hex sha256 (security-grade, not Bun.hash)
  exec-trust.ts   - ExecTrustState load/save (~/.ax/team-trust-exec.json) + classifyExec
  git-branch.ts   - currentBranch(), defaultBranch(), isOnDefaultBranch() (git, Bun.spawnSync)
  install-team-hook.ts - snapshot approved hook → ~/.ax/hooks/<name>.ts → installHookFile
apps/axctl/src/cli/commands/team.ts   - add the `trust` subcommand (modify) + point sync's gated report at it
docs/cli.md · apps/site/public/llms.txt · -cli-reference.data.ts - document `ax team trust` (BOTH gates)
```

Reuse: `apps/axctl/src/team/{model,scan,trust}.ts` (Slice 0); `installHookFile` from `apps/axctl/src/hooks/sdk-install.ts`; sha256 pattern from `apps/axctl/src/config-core/hash.ts`.

---

## Task 1: `exec-hash.ts` - sha256

**Files:** Create `apps/axctl/src/team/exec-hash.ts` + `exec-hash.test.ts`

- [ ] **Step 1: failing test** (pure given content):

```typescript
import { describe, expect, it } from "bun:test";
import { sha256Hex } from "./exec-hash.ts";

describe("sha256Hex", () => {
  it("is the known sha256 of a string", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("changes with content", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/exec-hash.ts`:

```typescript
import { createHash } from "node:crypto";

/** Full hex sha256 of text. Security-grade content pin for executable trust
 *  (a non-cryptographic hash like Bun.hash would be insufficient here - a
 *  collision is a trust-bypass, not just a missed change). */
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** sha256 of a file's content; "" hash for a missing/unreadable file. */
export async function sha256OfFile(abs: string): Promise<string> {
  const f = Bun.file(abs);
  return (await f.exists()) ? sha256Hex(await f.text()) : sha256Hex("");
}
```

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 2: `git-branch.ts` - default-branch guard

**Files:** Create `apps/axctl/src/team/git-branch.ts` + `git-branch.test.ts`

- [ ] **Step 1: failing test** - the parsing logic is pure; the git calls are thin. Test the pure `isDefault` reconciler:

```typescript
import { describe, expect, it } from "bun:test";
import { isDefaultBranchName } from "./git-branch.ts";

describe("isDefaultBranchName", () => {
  it("matches current to the resolved default", () => {
    expect(isDefaultBranchName("main", "main")).toBe(true);
    expect(isDefaultBranchName("feature/x", "main")).toBe(false);
  });
  it("falls back to main/master when default is unknown", () => {
    expect(isDefaultBranchName("main", null)).toBe(true);
    expect(isDefaultBranchName("master", null)).toBe(true);
    expect(isDefaultBranchName("dev", null)).toBe(false);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/git-branch.ts`:

```typescript
/** Pure: is `current` the trusted default? If `defaultBranch` is known, exact
 *  match; else fall back to the conventional main/master. */
export const isDefaultBranchName = (current: string, defaultBranch: string | null): boolean =>
  defaultBranch ? current === defaultBranch : current === "main" || current === "master";

const git = (args: string[], cwd: string): string | null => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
};

export const currentBranch = (cwd: string): string | null => git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

/** origin's default branch, e.g. "main" from refs/remotes/origin/HEAD; null if undetermined. */
export const defaultBranch = (cwd: string): string | null => {
  const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd); // "refs/remotes/origin/main"
  return ref ? ref.split("/").pop() ?? null : null;
};

/** True when the repo at cwd is checked out on its trusted default branch. */
export const isOnDefaultBranch = (cwd: string): boolean => {
  const cur = currentBranch(cwd);
  if (!cur || cur === "HEAD") return false; // detached HEAD is not trusted
  return isDefaultBranchName(cur, defaultBranch(cwd));
};
```

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 3: `exec-trust.ts` - exec trust store + classify

**Files:** Create `apps/axctl/src/team/exec-trust.ts` + `exec-trust.test.ts`

- [ ] **Step 1: failing test:**

```typescript
import { describe, expect, it } from "bun:test";
import { classifyExec, type ExecTrustState } from "./exec-trust.ts";
import type { GatedArtifact } from "./model.ts";

const hook = (name: string): GatedArtifact => ({ kind: "hook", name, path: `/r/.ax/hooks/${name}.ts` });

describe("classifyExec", () => {
  it("buckets new / changed / trusted by sha256", () => {
    const hooks = [hook("a"), hook("b"), hook("c")];
    const sha: Record<string, string> = { a: "h1", b: "h2", c: "h3" };
    const trust: ExecTrustState = {
      "hook:b": { sha256: "h2", content: "...", trusted_at: "x" },
      "hook:c": { sha256: "OLD", content: "old body", trusted_at: "x" },
    };
    const r = classifyExec(hooks, (h) => sha[h.name], trust);
    expect(r.added.map((x) => x.name)).toEqual(["a"]);
    expect(r.changed.map((x) => x.name)).toEqual(["c"]);
    expect(r.trusted.map((x) => x.name)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/exec-trust.ts`. The store caches the trusted **content** so a *changed* hook can show a diff:

```typescript
import { decodeJsonOrNull } from "@ax/lib/decode";
import type { GatedArtifact } from "./model.ts";

export interface ExecTrustRecord { readonly sha256: string; readonly content: string; readonly trusted_at: string; }
export type ExecTrustState = Record<string, ExecTrustRecord>; // key: "hook:<name>"

export const execKey = (h: GatedArtifact): string => `${h.kind}:${h.name}`;
export const defaultExecTrustPath = (): string => `${process.env.HOME}/.ax/team-trust-exec.json`;

export async function loadExecTrust(path: string): Promise<ExecTrustState> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return {};
    const p = decodeJsonOrNull(await f.text());
    return p && typeof p === "object" ? (p as ExecTrustState) : {};
  } catch { return {}; }
}

export async function saveExecTrust(path: string, state: ExecTrustState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const r = Bun.spawnSync(["mv", tmp, path]);
  if (r.exitCode !== 0) { Bun.spawnSync(["rm", "-f", tmp]); throw new Error(`saveExecTrust: mv failed (${r.exitCode})`); }
}

export interface ExecClassification {
  readonly added: ReadonlyArray<GatedArtifact>;
  readonly changed: ReadonlyArray<GatedArtifact>;
  readonly trusted: ReadonlyArray<GatedArtifact>;
}

export const classifyExec = (
  hooks: ReadonlyArray<GatedArtifact>,
  shaOf: (h: GatedArtifact) => string,
  trust: ExecTrustState,
): ExecClassification => {
  const added: GatedArtifact[] = [], changed: GatedArtifact[] = [], trusted: GatedArtifact[] = [];
  for (const h of hooks) {
    const rec = trust[execKey(h)];
    if (!rec) added.push(h);
    else if (rec.sha256 !== shaOf(h)) changed.push(h);
    else trusted.push(h);
  }
  return { added, changed, trusted };
};
```

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 4: `install-team-hook.ts` - snapshot + install

**Files:** Create `apps/axctl/src/team/install-team-hook.ts` + `install-team-hook.test.ts`

The approved hook content is **snapshotted** to `~/.ax/hooks/<name>.ts` (a stable user-owned copy, NOT the live repo file - so a later repo change can't alter an installed hook without re-trust), then installed via `installHookFile`.

- [ ] **Step 1: failing test** - test the pure target-path + the snapshot write (real temp HOME); the `installHookFile` call is integration-verified in Task 6 e2e (mock or skip the provider write here):

```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { hookSnapshotPath, snapshotHook, isSafeHookName } from "./install-team-hook.ts";

describe("hookSnapshotPath / isSafeHookName", () => {
  it("maps to ~/.ax/hooks/<name>.ts", () => {
    expect(hookSnapshotPath("enforce-x", "/home/u")).toBe("/home/u/.ax/hooks/enforce-x.ts");
  });
  it("rejects path-escaping hook names", () => {
    expect(isSafeHookName("enforce-x")).toBe(true);
    expect(isSafeHookName("../evil")).toBe(false);
    expect(isSafeHookName("a/b")).toBe(false);
  });
});
describe("snapshotHook", () => {
  const home = `/tmp/ax-mesha-${process.pid}`;
  afterEach(() => Bun.spawnSync(["rm", "-rf", home]));
  it("writes the trusted content to the snapshot path", async () => {
    const p = await snapshotHook("enforce-x", "export default {}\n", home);
    expect(p).toBe(`${home}/.ax/hooks/enforce-x.ts`);
    expect(await Bun.file(p).text()).toBe("export default {}\n");
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** `apps/axctl/src/team/install-team-hook.ts`:

```typescript
import { Effect } from "effect";
import { installHookFile } from "../hooks/sdk-install.ts";

export const isSafeHookName = (n: string): boolean => /^[a-zA-Z0-9._-]+$/.test(n) && n !== "." && n !== "..";
export const hookSnapshotPath = (name: string, home: string): string => `${home}/.ax/hooks/${name}.ts`;

/** Write the trusted content to ~/.ax/hooks/<name>.ts (the stable snapshot). */
export async function snapshotHook(name: string, content: string, home: string): Promise<string> {
  if (!isSafeHookName(name)) throw new Error(`unsafe hook name: ${name}`);
  const path = hookSnapshotPath(name, home);
  await Bun.write(path, content, { createPath: true });
  return path;
}

/** Snapshot + install the team hook into the given providers via the existing SDK installer. */
export const installTeamHook = (name: string, content: string, home: string, providers: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Effect.promise(() => snapshotHook(name, content, home));
    // installHookFile signature: (absFile, providers, scope) -> Effect; verify against sdk-install.ts
    return yield* installHookFile(path, providers as string[], "user" as never);
  });
```

> Implementer note: read `apps/axctl/src/hooks/sdk-install.ts:217` for the EXACT `installHookFile(absFile, providers, scope)` signature + the `scope` type (grep `asScope`/`InstallScope`) and adapt the call. The snapshot dir `~/.ax/hooks/` must already have the SDK file:dep (it does after `ax hooks init`); if a team hook imports `@ax/hooks-sdk`, it resolves there. Note as a v1 limitation: team hooks must be self-contained or use `@ax/hooks-sdk` only.

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 5: `ax team trust` CLI + diff + approval + branch guard

**Files:** Modify `apps/axctl/src/cli/commands/team.ts` (+ its test)

- [ ] **Step 1: failing test** for the pure diff/report renderer:

```typescript
import { describe, expect, it } from "bun:test";
import { renderTrustReport } from "./team.ts";

describe("renderTrustReport", () => {
  it("shows new/changed/installed counts + the branch guard", () => {
    const out = renderTrustReport({ installed: ["hook:enforce-x"], changed: [], added: [], onDefault: true });
    expect(out).toContain("installed 1");
  });
  it("refuses off the default branch", () => {
    const out = renderTrustReport({ installed: [], changed: ["hook:x"], added: [], onDefault: false });
    expect(out).toMatch(/default branch|refus|not trusted/i);
  });
  it("empty-state when no executable hooks", () => {
    expect(renderTrustReport({ installed: [], changed: [], added: [], onDefault: true })).toContain("no executable");
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** the `trust` subcommand in `team.ts` + the pure `renderTrustReport`. Flow:
  1. Resolve repo root (reuse sync's resolver). `scanAxFolder` → `gated` (hooks).
  2. **Branch guard:** `isOnDefaultBranch(root)` (Task 2). If NOT on the default branch and there are added/changed hooks → refuse (print the guard message, install nothing) unless `--allow-branch` is passed (documented escape hatch; default fail-closed).
  3. sha256 each hook (`sha256OfFile`); `loadExecTrust`; `classifyExec` → added/changed/trusted.
  4. For each **changed** hook, show a diff: the trust record cached the old content; print "CHANGED" + the new sha256 + a simple line-diff (old vs new) so the approver sees what changed. For **added**, show the new content's first ~20 lines + sha256.
  5. Approval: if added∪changed non-empty AND not `--yes`: if non-TTY, print "re-run with --yes to install N executable hook(s)" and install NOTHING (fail-safe, like sync). If `--yes`, approve all.
  6. For approved: `installTeamHook(name, content, home, ["claude","codex"])` (or a `--providers` flag), then record `execTrust[execKey] = { sha256, content, trusted_at }`.
  7. `saveExecTrust`. Print `renderTrustReport`.
  Add `trustCommand = Command.make("trust", { yes, allowBranch, ... }, ...)` and add it to the `team` group's subcommands alongside `sync`.

```typescript
export const renderTrustReport = (r: { installed: string[]; changed: string[]; added: string[]; onDefault: boolean }): string => {
  if (r.installed.length === 0 && r.changed.length === 0 && r.added.length === 0)
    return "[ax team trust] no executable hooks in .ax/hooks/.";
  if (!r.onDefault && (r.changed.length || r.added.length) && r.installed.length === 0)
    return "[ax team trust] refusing to install executable hooks: not on the repo's default branch (use --allow-branch to override).";
  const lines = [`[ax team trust] installed ${r.installed.length} executable hook(s)`];
  for (const k of r.installed) lines.push(`  + ${k}`);
  return lines.join("\n");
};
```

> Implementer note: keep `renderTrustReport` pure + tested; the diff display + the `installTeamHook`/`saveExecTrust` IO live in the command body. Verify the group-subcommand API (`Command.withSubcommands([syncCommand, trustCommand])`) against the Slice-0 `team.ts`. Update sync's gated-hooks line to say "run `ax team trust` to review + install".

- [ ] **Step 4: run, PASS.** **Step 5: commit.**

---

## Task 6: docs + both cli-reference gates + e2e

**Files:** modify `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`

- [ ] **Step 1: document `ax team trust`** in all three (the #414 lesson): docs/cli.md `## Team` section (add `ax team trust`), llms.txt line, and update the `team` card in `-cli-reference.data.ts` to mention `sync` + `trust`.
- [ ] **Step 2: verify gates + tests + typecheck:**
```
bun test apps/axctl/src/team apps/axctl/src/cli/commands/team.test.ts
bun scripts/check-cli-reference.ts 2>&1 | tail -1
bun test scripts/check-site-cli-reference.test.ts 2>&1 | tail -3
bun run typecheck 2>&1 | rg -c "error TS"
```
- [ ] **Step 3: e2e** (build a rig with a hook, on a default branch):
```
rm -rf /tmp/axhook && mkdir -p /tmp/axhook/.ax/hooks && (cd /tmp/axhook && git init -q -b main && git commit -q --allow-empty -m init)
printf 'import { defineHook } from "@ax/hooks-sdk/define";\nexport default defineHook({ name: "demo-guard", events: ["PreToolUse"], run: () => ({ _tag: "Allow" }) as any });\n' > /tmp/axhook/.ax/hooks/demo-guard.ts
W=/Users/necmttn/Projects/ax/.claude/worktrees/hook-trust
# 1) non-TTY without --yes installs nothing
cd /tmp/axhook && bun run $W/apps/axctl/src/cli/index.ts team trust < /dev/null 2>&1 | head -6
# 2) --yes installs it (snapshot + provider install)
cd /tmp/axhook && bun run $W/apps/axctl/src/cli/index.ts team trust --yes 2>&1 | head -8
ls ~/.ax/hooks/demo-guard.ts 2>/dev/null && echo "snapshot present" || echo "snapshot MISSING"
# 3) re-run = trusted/unchanged (no re-install)
cd /tmp/axhook && bun run $W/apps/axctl/src/cli/index.ts team trust --yes 2>&1 | head -4
# 4) off-default-branch refuses
cd /tmp/axhook && git checkout -q -b feature/x && bun run $W/apps/axctl/src/cli/index.ts team trust --yes 2>&1 | head -4
```
Expected: (1) installs nothing; (2) snapshots to `~/.ax/hooks/demo-guard.ts` + reports installed + records sha256; (3) trusted/unchanged; (4) refuses off the default branch. Paste output.
- [ ] **Step 4: CLEANUP** (don't leave the demo hook installed in the real config): `ax hooks remove demo-guard` (or revert the provider config edit), `rm -f ~/.ax/hooks/demo-guard.ts /tmp/axhook`, and drop `hook:demo-guard` from `~/.ax/team-trust-exec.json`. Confirm the demo hook is NOT left in `~/.claude/settings.json` / codex config.
- [ ] **Step 5: commit.**

---

## Self-Review Notes
- **Security:** sha256 (not Bun.hash) - collision = trust bypass; default-branch-only (feature-branch smuggling blocked); non-TTY/no-`--yes` installs nothing; path-traversal guard on hook names; the installed hook is a **snapshot** (a repo change can't mutate an installed hook without re-trust).
- **Reuse:** `installHookFile` (existing SDK install path), the Slice-0 `scan`/`model`, sha256 helper pattern.
- **CI:** BOTH cli-reference gates updated (Task 6).
- **Cleanup:** e2e must remove the demo hook from real provider configs + the snapshot + exec-trust.
- **v1 limitations to note in docs:** team hooks must be self-contained or use `@ax/hooks-sdk`; `--allow-branch` is the documented escape hatch; signing-against-an-org-key is deferred (post price-signal / hosted).
