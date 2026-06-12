# Nav Re-home + Ingest Splash (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the studio nav to Wrapped(`/`) · Improve · Sessions · Skills · Workflow + footer Lab; remove the Recall/Decisions/Live routes; replace the Live tab with an app-wide ingest splash overlay.

**Architecture:** Pure studio-SPA changes (no API changes, no capability bump). The Live tab's stream plumbing (`useIngestStream`, persisted stream URL, stage checklist) moves into an `IngestSplash` overlay mounted in `Shell.FullChrome`. Lab is a new minimal route hosting links to Canvas/Graph plus a small SQL console over the existing `POST /api/query`.

**Tech Stack:** React 18, TanStack Router/Query, Vite. Verification = `bunx turbo run build` + studio `tsc --noEmit` (no studio test infra).

**Spec:** `docs/superpowers/specs/2026-06-12-improve-first-dashboard-design.md` (PR2 scope; spec lives in main from PR1).

Already true (no work): Sessions multi-select → Compare shipped in the sessions list (checkboxes + `compareSelected()` → `/sessions/compare?ids=`); Graph/Canvas already have no nav entries to *remove* beyond Canvas's.

---

### Task 1: Nav re-home (Shell.tsx + router.tsx)

**Files:** Modify `apps/studio/src/Shell.tsx`, `apps/studio/src/router.tsx`; Delete `apps/studio/src/routes/recall.tsx`, `apps/studio/src/routes/decisions.tsx`.

- [ ] Shell `Tab.to` union → `"/" | "/improve" | "/sessions" | "/skills" | "/workflow"`. TABS → Wrapped (`to: "/"`, prefetch wrapped + public-preview), Improve, Sessions, Skills, Workflow (in that order). Active logic: `path === tab.to || (tab.to === "/" && path === "/wrapped")`.
- [ ] router.tsx: `StudioIndexRoute` renders `<WrappedRoute />` instead of `<SkillsRoute />` (share branch unchanged). Remove `recallRoute`, `decisionsRoute`, `ingestLiveRoute` defs + imports + routeTree entries (ingest-live file deleted in Task 3). Keep `/wrapped` route as alias.
- [ ] Delete `routes/recall.tsx` and `routes/decisions.tsx` (DecisionsSection lives in components/, embedded in Improve since PR1). rg for imports of both files first; fix any.
- [ ] Update the 404 copy in router.tsx ("only has the Skill Triage view") → point at `/` with label "← Back to dashboard".
- [ ] Gate: `bunx turbo run build && (cd apps/studio && bun run typecheck)`.
- [ ] Commit: `feat(studio): nav re-home - wrapped landing, five tabs, recall/decisions routes removed`

### Task 2: Lab route + footer

**Files:** Create `apps/studio/src/routes/lab.tsx`; Modify `apps/studio/src/api.ts` (add `query`), `apps/studio/src/router.tsx`, `apps/studio/src/Shell.tsx` (footer), `apps/studio/src/mock-fixtures.ts` (register `/api/query` → small canned result).

- [ ] api.ts: `query: (sql: string): Promise<unknown> => jsonFetch("/api/query", { method: "POST", body: JSON.stringify({ query: sql }) })` - check the exact body key the daemon expects in `apps/axctl/src/dashboard/router/routes/system.ts` `/api/query` decode (adjust `query` vs `sql` key + jsonFetch's init support; extend jsonFetch only if it doesn't take an init).
- [ ] lab.tsx: panel with (a) links to `/canvas` and `/graph` (TanStack Link, badge styling), (b) SQL console: textarea + Run button → `api.query` → `<pre>` JSON output, error div on reject. SELECT-only note in copy (daemon enforces).
- [ ] Register `/lab` route; Shell FullChrome gains `<footer className="shell-footer"><Link to="/lab">Lab</Link></footer>` (one muted link; styles.css gets a tiny `.shell-footer` block).
- [ ] Gate + commit: `feat(studio): lab route - canvas/graph links + sql console`

### Task 3: Ingest splash overlay

**Files:** Create `apps/studio/src/components/ingest-splash.tsx`; Modify `apps/studio/src/Shell.tsx`, `apps/studio/src/styles.css`; Delete `apps/studio/src/routes/ingest-live.tsx`.

- [ ] Move from ingest-live.tsx into ingest-splash.tsx (verbatim where possible): `STREAM_URL_KEY` + persist/read helpers, `STAGE_GLYPH`, `StageChecklist`, `SkippedFiles`, `formatEtaLeft`, the stream-driven query-invalidation effect, the stale-URL cleanup effect, the finished→clear-persist effect, and the `start()` trigger (POST /api/ingest, 503 → no overlay).
- [ ] `IngestSplash` behavior: rehydrate persisted stream URL on mount (mid-run landings get the overlay immediately); overlay visible while `streamUrl && !run.finished`; on finish show the final state ~1.5s then auto-dismiss + clear; manual "Continue in background" dismiss hides overlay for the rest of the run (floating pill not needed v0). Renders: backdrop + centered panel with header "Ingesting…", StageChecklist, dismiss button.
- [ ] Trigger entry: masthead gains a small "Ingest" button next to the live-indicator (FullChrome) - visible only when `api.version().live_ingest !== false` (reuse `shouldPollFallback` logic inverted; hidden on compiled binaries with title hint "run ax ingest in a terminal"). Clicking starts a run + opens the overlay. CountTiles move into the overlay body (poll prop dropped - SSE invalidation in use-ingest-events still refreshes app queries on compiled binaries, per poll-fallback.ts the polling only mattered for the dead Live tab).
- [ ] Mount `<IngestSplash />` inside FullChrome only. Delete routes/ingest-live.tsx; remove its router.tsx import remnants (def removed in Task 1).
- [ ] styles.css: `.ingest-splash` fixed inset-0 backdrop (rgba(0,0,0,.45)), centered panel max-width 560px, reuse existing `.panel` look.
- [ ] Gate + commit: `feat(studio): ingest splash overlay replaces live tab`

### Task 4: Final gate + PR

- [ ] `bun test` (axctl unaffected - confirm), `bun run typecheck`, `bunx turbo run build`, studio typecheck.
- [ ] Live smoke: `AX_DATA_DIR=/tmp/ax-smoke-pr2 ./apps/axctl/bin/axctl serve --port=8799` → `/` serves; `/api/version` ok; trigger POST /api/ingest, confirm stream URL returns (sidecar present from source). Stop daemon.
- [ ] Push + PR referencing spec PR2 scope; merge only at CLEAN.
