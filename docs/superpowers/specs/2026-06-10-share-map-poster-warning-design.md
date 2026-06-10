# Share Map, ASCII Poster, And Stale Usage Warning Design

Date: 2026-06-10
Branch: `feat/share-map-poster-warning`

## Goal

Improve public session shares in three focused ways:

1. Add the first production slice of the F2 session map.
2. Polish the OG poster with an ASCII `AX` logo treatment.
3. Warn when `ax share` is exporting stale usage data that can make cost rails look empty.

This pass deliberately avoids the larger F2 digest export for commit ticks and chapter bands. The session map must be useful from data already present in the multi-file share manifest.

## User-Facing Behavior

### F2 Session Map

Shared-session Studio pages show a compact `Session map` strip near the existing share hero/header when the manifest has subagents.

The map renders from `index.json` only:

- Root duration from `session.started_at` / `session.ended_at` and `totals.duration_ms`.
- Subagent cards from `subagents[]`.
- Horizontal placement from `spawn_turn_seq` when present, falling back to start time relative to the root session window, then stable order as a last fallback.
- Bar width from `duration_ms` when present, with a minimum visible width.
- Color intensity from `cost_usd` relative to the highest known subagent cost.
- Failure state from `stats.failures`.
- Labels and tooltips from `task_label`, `model`, `cost_usd`, duration, and failure count.

Interaction:

- Clicking a subagent lane selects that subagent using the existing share deep-link behavior (`?sub=<file>`).
- The map is keyboard reachable through buttons or equivalent focusable controls.
- Empty space on the map does not change selection.
- The map is hidden for shares with zero subagents.

The visual language follows the current share viewer: flat, utilitarian, light theme, restrained colors, no decorative grid texture.

### OG Poster

The default poster replaces the current serif `ax` header wordmark with a small ASCII `AX` logo in the top-left header. The poster remains content-first: title, totals, fleet, and cost anatomy still dominate.

A debug/render variant is available with `?variant=watermark`. It renders a larger background ASCII watermark so it can be inspected and iterated without making the louder treatment the default social card.

The OG implementation must keep the known `workers-og` / satori constraints:

- No raw SVG children.
- Avoid parser-hostile style properties already identified in the handoff.
- Use hex colors and integer pixel values.
- Bump the OG cache key when the template changes.

### Stale Ingest Warning

`ax share` emits a non-blocking stderr warning when the exported root or descendant sessions have session-level usage but no turn-level usage rows.

Detection:

- Traverse the redacted exported share tree before building the bundle.
- Treat session-level usage as present when `token_usage.estimated_cost_usd` or `token_usage.estimated_tokens` is a positive number.
- Treat turn-level usage as present when any exported turn in the root or descendants has `turn.token_usage`.
- Warn only when session-level usage is present and turn-level usage is absent everywhere in the exported tree.

Suggested warning text:

```text
axctl share: warning: this share has session-level cost but no per-turn usage rows; cost rails may render as $0.
Re-run ingest with AX_REDERIVE_CLAUDE=1 AX_REDERIVE_SUBAGENTS=1 ax ingest here --stages=claude,subagents --since=N
```

The warning never blocks `--dry-run`, preview, or publish.

## Implementation Shape

### Studio Share Viewer

The hosted Studio share viewer is currently shipped as static assets under `apps/site/public/studio/`. The implementation should first identify whether those assets have an authored source elsewhere in the repo. If they do, edit the source and rebuild. If the static assets are the source of truth for now, keep edits minimal and include a note in the PR.

Add a small map renderer that accepts the manifest object and current selected subagent file. It should be pure enough to test with sample manifest objects.

Expected helpers:

- `buildSessionMapLanes(manifest)` or equivalent pure data shaper.
- Formatting helpers for cost and duration reused from existing share viewer code when available.
- DOM/render integration near the existing share hero.

### OG Function

Edit both:

- `apps/site/functions/og/[owner]/[gistId].ts`
- repo-root `functions/og/[owner]/[gistId].ts` only if the root file needs anything beyond its existing re-export.

The ASCII logo should be a small preformatted block or explicit line stack in the header. Prefer line-stack HTML if `pre` proves fragile in `workers-og`.

Add `variant=watermark` handling inside the same function and include the variant in the cache key alongside the bumped render revision.

### CLI Share Warning

Add a small pure helper in `apps/axctl/src/cli/share.ts` or `apps/axctl/src/share/format.ts`:

- It receives an `AxSessionShare`.
- It traverses `children`.
- It returns `true` when the stale condition is met.

`cmdShareWithDeps` writes the warning to stderr after redaction and before dry-run/preview output, so dry-run users see it too.

## Testing

Focused tests:

- `apps/axctl/src/cli/share.test.ts`: warning emitted for session-level usage with no turn usage; no warning when turn usage exists; no warning when there is no session usage.
- `apps/axctl/src/share/manifest.test.ts` if map support requires additional manifest shaping.
- Site/Studio test coverage if an authored source test harness exists.

Verification:

- `bun test apps/axctl/src/cli/share.test.ts`
- Relevant share/manifest tests after edits.
- Site build/typecheck for Studio/OG edits.
- Browser verification against a local or deployed share URL.
- OG verification via `/og/Necmttn/a6d4c2215bbe0998c93b38ad11db2ccb?debug=min` and the default render; also inspect `?variant=watermark`.

## Out Of Scope

- Commit ticks in the session map.
- Chapter bands derived from classifier/session-section output.
- Re-exporting the canonical demo gist.
- Making the watermark poster the default social image.
- Fixing unrelated known share-viewer bugs such as the docked inspector pinning issue.
