# ForesightJS Predictive Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared `@ax/foresight` package wiring ForesightJS intent prediction (mouse trajectory / tab / scroll / touch) into studio + site so predicted navigation prefetches the route chunk AND its data before the click, with dev-only hit-rate counters.

**Architecture:** New `packages/foresight` (mirrors `@ax/recap-deck`: raw `.ts` exports, no build step) exposing `initForesight` (idempotent, SSR-guarded, dev devtools + ledger wiring), a pure hit-rate `ledger`, and `<ForesightLink>` wrapping TanStack Router's `Link` via the official `@foresightjs/react` `useForesight` hook. Studio consumes it with React Query `prefetchQuery` thunks; site consumes it with a new memoized `fetchProfile` cache (site has no React Query).

**Tech Stack:** bun workspaces, TypeScript strict, React 19, `js.foresight@4.2.0`, `js.foresight-devtools@2.2.0`, `@foresightjs/react@0.3.2`, `@tanstack/react-router`, `@tanstack/react-query` (studio only), bun:test.

**Spec:** `docs/superpowers/specs/2026-07-02-foresight-prefetch-design.md` (issue #661)

## Global Constraints

- ALL work happens in the worktree `/Users/necmttn/Projects/ax/.claude/worktrees/661-feat` on branch `feat/661-feat-foresightjs-predictive-prefetch`. Never touch the primary tree (it sits on `main`; a hook blocks writes there).
- Run commands with the worktree as cwd (e.g. `git -C <worktree>` or cd once into it in your shell).
- Package versions pinned in root `package.json` `workspaces.catalog`; add exactly: `"js.foresight": "4.2.0"`, `"js.foresight-devtools": "2.2.0"`, `"@foresightjs/react": "0.3.2"`.
- `packages/foresight` follows the `packages/recap-deck` precedent verbatim: `"private": true`, `"type": "module"`, single `"."` export `{ "types": "./src/index.ts", "import": "./src/index.ts" }`, no build step, `react` as peerDependency only.
- Root `tsconfig.json` must exclude `packages/foresight/**` (same carve-out as `packages/recap-deck/**` - root sweep uses the OpenTUI `jsxImportSource` and would misparse plain-React TSX).
- Tests: `bun test` (bun:test). The repo has a global hook that may block bare `bun test`; if blocked, use the tmp wrapper-script workaround (see memory: run tests via a small wrapper script in the scratchpad that execs `bun test <path>`).
- Never `git add -A`; stage explicit paths.
- Commit messages: conventional commits, end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- DEV-only surfaces (`window.__axForesight`, devtools overlay) must never activate in prod builds: apps pass `import.meta.env.DEV` into `initForesight`; the package itself reads no bundler globals.

---

### Task 1: Package scaffold + pure hit-rate ledger

**Files:**
- Modify: `package.json` (root - add 3 catalog entries)
- Modify: `tsconfig.json` (root - add exclude)
- Create: `packages/foresight/package.json`
- Create: `packages/foresight/tsconfig.json`
- Create: `packages/foresight/src/index.ts`
- Create: `packages/foresight/src/ledger.ts`
- Test: `packages/foresight/src/ledger.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `createLedger(windowMs?: number): Ledger` and a module-level singleton `export const ledger: Ledger` (default window 5000ms).
  - `type Ledger = { recordPrefetch(key: string, at: number): void; recordError(key: string, at: number): void; recordNavigate(key: string, at: number): void; snapshot(): LedgerSnapshot }`
  - `type LedgerSnapshot = { fired: number; hits: number; errors: number; navigations: number; hitRate: number }`
  - Timestamps are passed in (pure; callers supply `Date.now()`), so tests need no clock mocking.

- [ ] **Step 1: Root catalog + tsconfig exclude**

In root `package.json`, extend `workspaces.catalog` (currently 4 entries) to:

```json
"catalog": {
    "effect": "4.0.0-beta.78",
    "typescript": "^5.6.0",
    "@types/bun": "latest",
    "vite": "^8.0.3",
    "js.foresight": "4.2.0",
    "js.foresight-devtools": "2.2.0",
    "@foresightjs/react": "0.3.2"
}
```

In root `tsconfig.json`, change the exclude line to:

```json
"exclude": ["apps/studio/**", "packages/recap-deck/**", "packages/foresight/**"]
```

- [ ] **Step 2: Package manifest + tsconfig**

`packages/foresight/package.json`:

```json
{
  "name": "@ax/foresight",
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
  "dependencies": {
    "js.foresight": "catalog:",
    "js.foresight-devtools": "catalog:",
    "@foresightjs/react": "catalog:"
  },
  "peerDependencies": {
    "react": "^19.2.0",
    "@tanstack/react-router": "^1.166.0"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "@types/react": "^19.2.0",
    "react": "^19.2.0",
    "@tanstack/react-router": "^1.170.0",
    "typescript": "catalog:"
  }
}
```

`packages/foresight/tsconfig.json` (copy of recap-deck's):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["react"],
    "exactOptionalPropertyTypes": false,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Then run `bun install` from the worktree root. Expected: lockfile updates, `js.foresight@4.2.0` + `js.foresight-devtools@2.2.0` + `@foresightjs/react@0.3.2` land in `node_modules`.

- [ ] **Step 3: Write the failing ledger test**

`packages/foresight/src/ledger.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createLedger } from "./ledger.ts";

describe("createLedger", () => {
    test("navigate within window after prefetch counts as hit", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/sessions/abc", 1000);
        l.recordNavigate("/sessions/abc", 3000);
        expect(l.snapshot()).toEqual({
            fired: 1,
            hits: 1,
            errors: 0,
            navigations: 1,
            hitRate: 1,
        });
    });

    test("navigate after window is not a hit", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/sessions/abc", 1000);
        l.recordNavigate("/sessions/abc", 6001);
        expect(l.snapshot().hits).toBe(0);
        expect(l.snapshot().navigations).toBe(1);
    });

    test("navigate to a key never prefetched is not a hit", () => {
        const l = createLedger(5000);
        l.recordNavigate("/cost", 1000);
        expect(l.snapshot()).toEqual({
            fired: 0,
            hits: 0,
            errors: 0,
            navigations: 1,
            hitRate: 0,
        });
    });

    test("errors counted separately, do not affect fired", () => {
        const l = createLedger(5000);
        l.recordError("/sessions/abc", 1000);
        expect(l.snapshot().errors).toBe(1);
        expect(l.snapshot().fired).toBe(0);
    });

    test("re-prefetch refreshes the window", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/x", 1000);
        l.recordPrefetch("/x", 10_000);
        l.recordNavigate("/x", 12_000);
        const s = l.snapshot();
        expect(s.fired).toBe(2);
        expect(s.hits).toBe(1);
        expect(s.hitRate).toBe(0.5);
    });

    test("hitRate is 0 when nothing fired", () => {
        expect(createLedger().snapshot().hitRate).toBe(0);
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run (from worktree root): `bun test packages/foresight/src/ledger.test.ts`
Expected: FAIL - `Cannot find module './ledger.ts'`.

- [ ] **Step 5: Implement the ledger**

`packages/foresight/src/ledger.ts`:

```ts
// Pure hit-rate ledger for predictive prefetch. Timestamps are injected so
// the module stays clock-free and fully unit-testable.

export type LedgerSnapshot = {
    fired: number;
    hits: number;
    errors: number;
    navigations: number;
    hitRate: number;
};

export type Ledger = {
    recordPrefetch(key: string, at: number): void;
    recordError(key: string, at: number): void;
    recordNavigate(key: string, at: number): void;
    snapshot(): LedgerSnapshot;
};

export function createLedger(windowMs = 5000): Ledger {
    const lastPrefetch = new Map<string, number>();
    let fired = 0;
    let hits = 0;
    let errors = 0;
    let navigations = 0;

    return {
        recordPrefetch(key, at) {
            fired++;
            lastPrefetch.set(key, at);
        },
        recordError(_key, _at) {
            errors++;
        },
        recordNavigate(key, at) {
            navigations++;
            const t = lastPrefetch.get(key);
            if (t !== undefined && at >= t && at - t <= windowMs) {
                hits++;
                lastPrefetch.delete(key);
            }
        },
        snapshot() {
            return {
                fired,
                hits,
                errors,
                navigations,
                hitRate: fired === 0 ? 0 : hits / fired,
            };
        },
    };
}

/** Module-level singleton used by initForesight + ForesightLink. */
export const ledger: Ledger = createLedger();
```

`packages/foresight/src/index.ts` (grows in later tasks):

```ts
export { createLedger, ledger } from "./ledger.ts";
export type { Ledger, LedgerSnapshot } from "./ledger.ts";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/foresight/src/ledger.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 7: Typecheck the package**

Run: `bun run --cwd packages/foresight typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json bun.lock packages/foresight
git commit -m "feat(foresight): scaffold @ax/foresight package with hit-rate ledger (#661)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `initForesight` - idempotent init, SSR guard, dev ledger + devtools

**Files:**
- Create: `packages/foresight/src/init.ts`
- Modify: `packages/foresight/src/index.ts`
- Test: `packages/foresight/src/init.test.ts`

**Interfaces:**
- Consumes: `ledger` singleton from Task 1.
- Produces:
  - `initForesight(opts?: InitForesightOptions): boolean` - returns `true` only when this call performed initialization (false on server or repeat calls).
  - `type InitForesightOptions = { dev?: boolean; devtools?: boolean; settings?: Partial<import("js.foresight").UpdateForsightManagerSettings> }`
  - Dev mode (`dev: true`): subscribes `callbackCompleted` on the manager to feed `ledger` (status `"success"` → `recordPrefetch(name)`, `"error"` → `recordError(name)`), and exposes `window.__axForesight = () => ledger.snapshot()`.
  - `devtools: true`: dynamic-imports `js.foresight-devtools` and calls `ForesightDevtools.initialize()` (fire-and-forget; the chunk is code-split and only ever fetched when the flag is true at runtime).

Facts verified against `js.foresight@4.2.0` `.d.ts`: `ForesightManager.initialize(props?: Partial<UpdateForsightManagerSettings>)` (note the library's own typo "Forsight" in the type name), `ForesightManager.instance.addEventListener("callbackCompleted", listener)`, event payload has `{ state: { name }, status: "error" | "success", errorMessage }`. The library is SSR-safe at import time (all `window`/`document` access is inside guarded function bodies), but we still guard init so server code never subscribes listeners or touches `window`.

- [ ] **Step 1: Write the failing test**

`packages/foresight/src/init.test.ts` (bun test has no `window`/`document` - that IS the server environment, which is exactly what we assert):

```ts
import { describe, expect, test } from "bun:test";
import { initForesight } from "./init.ts";

describe("initForesight", () => {
    test("no-ops on the server (no window) and returns false", () => {
        expect(typeof window).toBe("undefined");
        expect(initForesight()).toBe(false);
    });

    test("repeat calls also return false", () => {
        expect(initForesight()).toBe(false);
        expect(initForesight({ dev: true })).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/foresight/src/init.test.ts`
Expected: FAIL - `Cannot find module './init.ts'`.

- [ ] **Step 3: Implement init**

`packages/foresight/src/init.ts`:

```ts
import { ForesightManager, type UpdateForsightManagerSettings } from "js.foresight";
import { ledger } from "./ledger.ts";

export type InitForesightOptions = {
    /** Wire the hit-rate ledger + window.__axForesight. Pass import.meta.env.DEV from the app. */
    dev?: boolean;
    /** Load the ForesightJS devtools overlay (lit-based, ~23KB gz - dev builds only). */
    devtools?: boolean;
    settings?: Partial<UpdateForsightManagerSettings>;
};

let initialized = false;

/**
 * Idempotent, browser-only ForesightJS boot. Returns true only when this
 * call performed the initialization. Safe to import server-side; safe to
 * call from prerender code paths (no-ops without a window).
 */
export function initForesight(opts: InitForesightOptions = {}): boolean {
    if (initialized || typeof window === "undefined") return false;
    initialized = true;

    ForesightManager.initialize(opts.settings);

    if (opts.dev) {
        ForesightManager.instance.addEventListener("callbackCompleted", (e) => {
            const key = e.state.name || "unnamed";
            if (e.status === "error") ledger.recordError(key, Date.now());
            else ledger.recordPrefetch(key, Date.now());
        });
        (window as Window & { __axForesight?: () => unknown }).__axForesight = () =>
            ledger.snapshot();
    }

    if (opts.devtools) {
        void import("js.foresight-devtools")
            .then(({ ForesightDevtools }) => ForesightDevtools.initialize())
            .catch(() => {
                // devtools are best-effort; never break the app over them
            });
    }

    return true;
}
```

Update `packages/foresight/src/index.ts`:

```ts
export { createLedger, ledger } from "./ledger.ts";
export type { Ledger, LedgerSnapshot } from "./ledger.ts";
export { initForesight } from "./init.ts";
export type { InitForesightOptions } from "./init.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/foresight/src`
Expected: all pass (ledger 6 + init 2).

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd packages/foresight typecheck`
Expected: exit 0. If the `UpdateForsightManagerSettings` import name errors, check the actual export name in `node_modules/js.foresight/dist/index.d.mts` (the library has a known "Forsight" typo) and match it.

- [ ] **Step 6: Commit**

```bash
git add packages/foresight/src
git commit -m "feat(foresight): initForesight with SSR guard, dev ledger wiring, devtools opt-in (#661)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `<ForesightLink>` - TanStack Router link with predictive prefetch

**Files:**
- Create: `packages/foresight/src/foresight-link.tsx`
- Modify: `packages/foresight/src/index.ts`

**Interfaces:**
- Consumes: `ledger` (Task 1); `useForesight` from `@foresightjs/react`.
- Produces:
  - `ForesightLink(props: ForesightLinkProps): ReactNode`
  - `type ForesightLinkProps = LinkProps & { prefetchData?: () => Promise<unknown>; hitSlop?: number | { top: number; left: number; right: number; bottom: number }; reactivateAfter?: number; foresightName?: string }` where `LinkProps = React.ComponentProps<typeof Link>` from `@tanstack/react-router`.
  - Behavior contract (later tasks rely on this): on predicted intent it fires `router.preloadRoute({ to, params, search })` AND `prefetchData()` (both fire-and-forget, rejections → `ledger.recordError`); on click it calls `ledger.recordNavigate(key)`. `key` = `foresightName ?? stableKeyFrom(to, params)`. `reactivateAfter` defaults to `30_000` (matches studio's 30s React Query staleTime - a stale-again destination may be re-prefetched).

Facts: `useForesight<HTMLAnchorElement>({ callback, hitSlop, name, reactivateAfter })` returns `{ elementRef }` (a ref callback; null-safe on first render). TanStack Router `Link` accepts `ref` (React 19 ref-as-prop). Studio's `SpawnMarker` comment warns against mass hover-prefetch stampedes - ForesightJS only fires the callback on a *predicted* element (trajectory/tab/scroll hit), not on every rendered row, which is exactly the mitigation; plus `reactivateAfter` throttles repeats per element.

- [ ] **Step 1: Implement the component**

`packages/foresight/src/foresight-link.tsx`:

```tsx
import { useForesight } from "@foresightjs/react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { ledger } from "./ledger.ts";

type LinkProps = ComponentProps<typeof Link>;

export type ForesightLinkProps = LinkProps & {
    /** Warm the destination's data (e.g. queryClient.prefetchQuery thunk). */
    prefetchData?: () => Promise<unknown>;
    hitSlop?: number | { top: number; left: number; right: number; bottom: number };
    /** ms before the same element may prefetch again. Default 30s. */
    reactivateAfter?: number;
    /** Override the ledger/devtools key; defaults to to+params. */
    foresightName?: string;
};

function stableKeyFrom(to: unknown, params: unknown): string {
    const base = typeof to === "string" ? to : JSON.stringify(to ?? "");
    return params ? `${base}:${JSON.stringify(params)}` : base;
}

export function ForesightLink({
    prefetchData,
    hitSlop,
    reactivateAfter = 30_000,
    foresightName,
    onClick,
    ...linkProps
}: ForesightLinkProps): ReactNode {
    const router = useRouter();
    const key = foresightName ?? stableKeyFrom(linkProps.to, linkProps.params);

    const { elementRef } = useForesight<HTMLAnchorElement>({
        name: key,
        hitSlop,
        reactivateAfter,
        callback: () => {
            const tasks: Promise<unknown>[] = [
                router.preloadRoute({
                    to: linkProps.to,
                    params: linkProps.params,
                    search: linkProps.search,
                } as Parameters<typeof router.preloadRoute>[0]),
            ];
            if (prefetchData) tasks.push(prefetchData());
            for (const t of tasks) {
                t.catch(() => ledger.recordError(key, Date.now()));
            }
        },
    });

    return (
        <Link
            {...linkProps}
            ref={elementRef}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                ledger.recordNavigate(key, Date.now());
                onClick?.(e);
            }}
        />
    );
}
```

Note on the `as Parameters<...>` cast: `router.preloadRoute` is generically typed over the route tree; a shared package cannot know the consumer's tree, so the cast is the sanctioned escape hatch here (same reason `LinkProps` is the loose `ComponentProps<typeof Link>`). If typecheck rejects the spread/ref combination on the consumer side, prefer fixing prop types in the package, not casts at call sites.

Update `packages/foresight/src/index.ts` (final form):

```ts
export { createLedger, ledger } from "./ledger.ts";
export type { Ledger, LedgerSnapshot } from "./ledger.ts";
export { initForesight } from "./init.ts";
export type { InitForesightOptions } from "./init.ts";
export { ForesightLink } from "./foresight-link.tsx";
export type { ForesightLinkProps } from "./foresight-link.tsx";
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd packages/foresight typecheck`
Expected: exit 0. (No unit test for this component - it is a thin composition of two externally-tested libraries and needs a RouterProvider + DOM to render; the repo has no React test harness for packages. Behavior is verified end-to-end in Tasks 4-6 via the devtools overlay + network tab. The pure pieces it leans on - ledger, key derivation - are unit-tested.)

Also run the existing test suite still green: `bun test packages/foresight/src` → all pass.

- [ ] **Step 3: Commit**

```bash
git add packages/foresight/src
git commit -m "feat(foresight): ForesightLink wrapping TanStack Router Link with route+data prefetch (#661)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Studio wiring

**Files:**
- Modify: `apps/studio/package.json` (add dep)
- Modify: `apps/studio/src/main.tsx` (init call)
- Modify: `apps/studio/src/routes/session-inspect.tsx` (export PAGE_SIZE; migrate SpawnMarker; swap inspect link)
- Create: `apps/studio/src/prefetch.ts` (shared prefetch thunk)
- Modify: `apps/studio/src/routes/sessions.tsx` (swap 2 session links)
- Modify: `apps/studio/src/instrument/shell.tsx` (swap rail links)

**Interfaces:**
- Consumes: `initForesight`, `ForesightLink` from `@ax/foresight`.
- Produces: `prefetchSessionInspect(queryClient: QueryClient, sessionId: string): () => Promise<unknown>` in `apps/studio/src/prefetch.ts` - a thunk factory whose query key/fn EXACTLY matches what `SessionInspectView` mounts with (`["session-inspect", id]`, `api.sessionInspect(id, { turnOffset: 0, turnLimit: PAGE_SIZE })`). Key mismatch = prefetch wasted; this is the correctness-critical invariant of the whole studio side.

- [ ] **Step 1: Add dependency + init**

`apps/studio/package.json` dependencies - add:

```json
"@ax/foresight": "workspace:*",
```

`apps/studio/src/main.tsx` - after the `queryClient` construction (line ~20), before `createRoot`:

```ts
import { initForesight } from "@ax/foresight";

initForesight({ dev: import.meta.env.DEV, devtools: import.meta.env.DEV });
```

Run `bun install` from worktree root. Expected: `@ax/foresight` symlinked into studio's node_modules.

- [ ] **Step 2: Export PAGE_SIZE + create the prefetch thunk**

In `apps/studio/src/routes/session-inspect.tsx`, find the existing `const PAGE_SIZE` declaration and export it: `export const PAGE_SIZE = ...` (keep its current value; it is 100 today).

Create `apps/studio/src/prefetch.ts`:

```ts
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { PAGE_SIZE } from "./routes/session-inspect.tsx";

/**
 * Prefetch thunk for the session detail route. The queryKey + queryFn MUST
 * stay byte-identical to SessionInspectView's mount query (session-inspect.tsx)
 * or the prefetch warms a dead cache entry.
 */
export function prefetchSessionInspect(
    queryClient: QueryClient,
    sessionId: string,
): () => Promise<unknown> {
    return () =>
        queryClient.prefetchQuery({
            queryKey: ["session-inspect", sessionId],
            queryFn: () => api.sessionInspect(sessionId, { turnOffset: 0, turnLimit: PAGE_SIZE }),
            staleTime: 5 * 60_000,
        });
}
```

(If importing a `.tsx` route module from `prefetch.ts` creates an import cycle - session-inspect imports prefetch later - move `PAGE_SIZE` into `prefetch.ts` and import it FROM there in session-inspect.tsx instead. Either direction is fine; there must be exactly one definition.)

- [ ] **Step 3: Swap session-list links** (`apps/studio/src/routes/sessions.tsx`)

Both session links (id-cell at ~line 218 and open-arrow cell at ~line 265) currently look like:

```tsx
<Link
    to="/sessions/$sessionId"
    params={{ sessionId: sid }}
    preload="intent"
    className="sx-id-link"
    title={`Open ${s.id}`}
    onClick={(e) => e.stopPropagation()}
>
```

Replace `Link` with `ForesightLink`, keep `preload="intent"` (hover fallback composes with trajectory prediction), and add the data thunk. The component needs `useQueryClient`:

```tsx
import { ForesightLink } from "@ax/foresight";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchSessionInspect } from "../prefetch.ts";
// inside the row-rendering component:
const queryClient = useQueryClient();
// ...
<ForesightLink
    to="/sessions/$sessionId"
    params={{ sessionId: sid }}
    preload="intent"
    prefetchData={prefetchSessionInspect(queryClient, sid)}
    className="sx-id-link"
    title={`Open ${s.id}`}
    onClick={(e) => e.stopPropagation()}
>
```

Apply the same transformation to the second link (~line 265). If `useQueryClient` is already in scope in that component, reuse it.

- [ ] **Step 4: Migrate SpawnMarker + inspect link** (`apps/studio/src/routes/session-inspect.tsx`)

`SpawnMarker` (~lines 1316-1345) hand-rolls hover/focus prefetch:

```tsx
const queryClient = useQueryClient();
const onIntent = () => {
    void queryClient.prefetchQuery({
        queryKey: ["session-inspect", childBare],
        queryFn: () => api.sessionInspect(childBare),
        staleTime: 5 * 60_000,
    });
};
// <div onMouseEnter={onIntent} onFocus={onIntent} ...>
//   <Link to="/sessions/$sessionId/inspect" params={{ sessionId: childBare }} preload="intent" ...>
```

Replace: delete `onIntent` and the `onMouseEnter`/`onFocus` props from the wrapper div; swap the inner `Link` to:

```tsx
<ForesightLink
    to="/sessions/$sessionId/inspect"
    params={{ sessionId: childBare }}
    preload="intent"
    prefetchData={prefetchSessionInspect(queryClient, childBare)}
    style={{ color: "var(--rose)", fontWeight: 600 }}
>
```

Note this also FIXES a latent inconsistency: the old hand-rolled `queryFn` called `api.sessionInspect(childBare)` with no paging options while the mount query passes `{ turnOffset: 0, turnLimit: PAGE_SIZE }` - same key, different fn. Unifying through `prefetchSessionInspect` removes that drift. Keep the existing code comment about prefetch stampedes, updated to say ForesightJS's single-predicted-element model is the mitigation.

- [ ] **Step 5: Swap nav rail links** (`apps/studio/src/instrument/shell.tsx`, ~lines 50-57)

Swap `Link` → `ForesightLink` for the RAIL items (no `prefetchData` - studio routes are eagerly bundled and list queries vary; route preload is a cheap no-op, the ledger still learns rail hit rates):

```tsx
<ForesightLink key={r.to} to={r.to} title={r.label} aria-label={r.label}
    activeOptions={{ exact: (r as { exact?: boolean }).exact ?? false }}
    activeProps={{ className: "on" }}>
```

- [ ] **Step 6: Swap project drill-in links** (`apps/studio/src/routes/project.tsx`, ~lines 101-107 and ~136-142)

Two search-param links, currently:

```tsx
<Link to="/skills" search={{ q: s.skill }} style={{ textDecoration: "none" }}>
```

Mechanical swap to `ForesightLink` (no `prefetchData` - destination list queries key on search params with no shared thunk yet; route preload + ledger registration only, same rationale as the rail):

```tsx
<ForesightLink to="/skills" search={{ q: s.skill }} style={{ textDecoration: "none" }}>
```

Same for the `to="/tools"` link at ~line 136.

- [ ] **Step 7: Typecheck + tests + build**

Run: `bun run --cwd apps/studio typecheck`
Expected: exit 0.
Run: `bun test apps/studio` (existing studio tests, e.g. mission-control.test.tsx) - Expected: all pass.
Run: `bun run --cwd apps/studio build` (vite build) - Expected: builds clean; confirm the devtools chunk exists as a separate lazy asset and `index` bundle size didn't jump by ~23KB+ (grep the vite output).

- [ ] **Step 8: Commit**

```bash
git add apps/studio/package.json apps/studio/src bun.lock
git commit -m "feat(studio): predictive prefetch via ForesightLink on session links + nav rail (#661)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Site wiring

**Files:**
- Modify: `apps/site/package.json` (add dep)
- Modify: `apps/site/app/client.tsx` (init call - client-only entry)
- Create: `apps/site/app/profile-cache.ts` (memoized fetchProfile)
- Modify: `apps/site/app/routes/u.$login.tsx` (consume cache)
- Modify: `apps/site/app/routes/leaders.tsx` (roster-row ForesightLink + prefetch)
- Modify: `apps/site/app/components/landing-sections/site-header.tsx` (nav ForesightLinks)

**Interfaces:**
- Consumes: `initForesight`, `ForesightLink` from `@ax/foresight`; `fetchProfile` from `@ax/lib/shared/community`.
- Produces: `cachedFetchProfile(login: string): ReturnType<typeof fetchProfile>` and `prefetchProfile(login: string): Promise<unknown>` in `apps/site/app/profile-cache.ts`. The site has NO React Query - without this memo, a data prefetch warms nothing (raw `fetch` twice). Failed fetches are evicted so a real navigation retries.

- [ ] **Step 1: Add dependency + init**

`apps/site/package.json` dependencies - add:

```json
"@ax/foresight": "workspace:*",
```

`apps/site/app/client.tsx` - this file is the client-only hydration entry (never executed during prerender), so it is the safe init point:

```tsx
import { initForesight } from "@ax/foresight";

initForesight({ dev: import.meta.env.DEV, devtools: import.meta.env.DEV });
```

Place before the existing `startTransition(() => hydrateRoot(...))` call. Run `bun install` from worktree root.

- [ ] **Step 2: Profile cache**

`apps/site/app/profile-cache.ts`:

```ts
import { fetchProfile } from "@ax/lib/shared/community";

// The site has no query cache; this memo is what makes profile prefetch
// meaningful. Failed lookups are evicted so real navigation retries.
const cache = new Map<string, ReturnType<typeof fetchProfile>>();

export function cachedFetchProfile(login: string): ReturnType<typeof fetchProfile> {
    const key = login.toLowerCase();
    const existing = cache.get(key);
    if (existing) return existing;
    const p = fetchProfile(login);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
}

export function prefetchProfile(login: string): Promise<unknown> {
    return cachedFetchProfile(login).catch(() => undefined);
}
```

- [ ] **Step 3: Consume the cache in the profile route**

`apps/site/app/routes/u.$login.tsx` (~line 35-58): in the main `useEffect`, replace the direct `fetchProfile(login)` call with `cachedFetchProfile(login)` (import from `../profile-cache.ts`). Leave the identity-mismatch guard and the rest of the state machine untouched. Do NOT change the `vs=` compare effect (compare peers are not prefetched in v1).

- [ ] **Step 4: Leaders roster rows**

`apps/site/app/routes/leaders.tsx` (~lines 156-167). Current row link:

```tsx
<Link to="/u/$login" params={{ login: row.login }} search={{ vs: undefined }}>
```

Replace with:

```tsx
<ForesightLink
    to="/u/$login"
    params={{ login: row.login }}
    search={{ vs: undefined }}
    prefetchData={() => prefetchProfile(row.login)}
>
```

with imports `import { ForesightLink } from "@ax/foresight";` and `import { prefetchProfile } from "../profile-cache.ts";`.

- [ ] **Step 5: Header nav**

`apps/site/app/components/landing-sections/site-header.tsx`: swap internal `Link`s to `ForesightLink` (route-chunk preload only - site file-routes ARE code-split, so this is a real win): brand link, `/changelog` badge, Product dropdown (`/features`, `/routing`, `/how-it-works`), Community dropdown (`/showcases`, `/leaders`, `/patterns`), `/blog`, `/docs`, and the Install CTA. Leave the external GitHub `<a>` untouched. Mechanical rename `Link` → `ForesightLink`, import swapped to `@ax/foresight` (keep the `Link` import only if something else in the file still uses it).

- [ ] **Step 6: Typecheck + build**

Run: `bun run --cwd apps/site build` then `bun run --cwd apps/site typecheck` (site typecheck needs prior codegen/build - CLAUDE.md).
Expected: both exit 0. The build includes prerendering - a failure here most likely means something touched `window` during prerender; verify `initForesight` is only called from `client.tsx` and remember the package itself is import-safe server-side.

- [ ] **Step 7: Commit**

```bash
git add apps/site/package.json apps/site/app bun.lock
git commit -m "feat(site): predictive prefetch on nav + leaders roster with memoized profile cache (#661)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification + PR

**Files:**
- No new files. Repo-wide checks + manual verification + PR.

**Interfaces:**
- Consumes: everything above.
- Produces: green repo-wide gates + a PR closing #661.

- [ ] **Step 1: Repo-wide gates**

From the worktree root:

```bash
bun test
bun run typecheck
bun run --cwd packages/foresight typecheck
bun run --cwd apps/studio typecheck
```

Expected: all exit 0. (Root typecheck excludes the new package - that's by design; its own typecheck covers it.)

- [ ] **Step 2: Manual verify - studio**

Boot studio from the worktree in dev mode (`bun run --cwd apps/studio dev`, or against the local daemon if available). In the browser:

1. Foresight devtools overlay is visible (control panel custom element) and lists registered elements (rail links + session rows once `/sessions` renders).
2. Move the cursor toward a session row WITHOUT clicking: network tab shows `GET /api/sessions/<id>/inspect?...` firing before any click; devtools logs `callbackCompleted`.
3. Click that row: the session detail renders WITHOUT a loading spinner (cache hit).
4. `window.__axForesight()` in the console returns a snapshot with `fired > 0` and `hits > 0` after step 3.
5. Tab-navigate through the session list (keyboard): prefetch fires on tab proximity (tabOffset default 2).

- [ ] **Step 3: Manual verify - site**

`bun run --cwd apps/site dev`:

1. On `/leaders`, trajectory toward a roster row fires the registration+gist fetches (network tab: `raw.githubusercontent.com/.../users/<login>.json` then `gist.githubusercontent.com/...`) before click.
2. Click through: `/u/<login>` renders without its loading state.
3. Prod check: `bun run --cwd apps/site build && bun run --cwd apps/site preview` (or serve the output) - no devtools overlay, no `window.__axForesight`, no lit chunk fetched (network tab).

- [ ] **Step 4: Fix anything found, then final commit + PR**

Any fixes discovered in verification get their own focused commits. Then:

```bash
git push
gh pr create --title "feat: ForesightJS predictive prefetch for studio + site (#661)" --body "$(cat <<'EOF'
Closes #661.

Predicted user intent (mouse trajectory / tab stops / scroll / touch) now prefetches destination route chunks AND data before the click lands.

- New `@ax/foresight` package (recap-deck-style raw-TS shared React lib): `initForesight` (idempotent, SSR-guarded, dev-only devtools + hit-rate ledger), pure `ledger`, `ForesightLink` wrapping TanStack Router `Link` via `@foresightjs/react`.
- Studio: session links + SpawnMarker migrated (kills the hand-rolled hover prefetch and its key/fn drift), nav rail registered; data prefetch matches `["session-inspect", id]` key-for-key.
- Site: memoized `fetchProfile` cache (site has no React Query), leaders roster rows prefetch profiles on trajectory, header nav preloads route chunks. Init isolated to `client.tsx` (prerender-safe).
- Dev-only receipts: `window.__axForesight()` → `{ fired, hits, errors, navigations, hitRate }`; ForesightJS devtools overlay in dev builds.

Spec: docs/superpowers/specs/2026-07-02-foresight-prefetch-design.md
Plan: docs/superpowers/plans/2026-07-02-foresight-prefetch.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Wait for CI (repo-wide `bun test` + typecheck + site build). Merge only at `mergeStateStatus: CLEAN`. After merge: remove the worktree + local/remote branch from the primary tree.
