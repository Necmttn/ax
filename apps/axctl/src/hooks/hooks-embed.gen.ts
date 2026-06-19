// AUTO-GENERATED stub - replaced with the embedded, pre-bundled SDK hooks during
// the binary build (`bun run build` → scripts/build-axctl.ts → gen-hooks-embed.ts),
// then restored to this stub afterwards so the committed copy stays empty.
//
// Committed empty so a fresh clone, `tsc`, and `bun test` all resolve this
// module. When the map is empty, `ax hooks init` from source scaffolds editable
// `.ts` hooks + a `file:` dep on packages/hooks-sdk instead. The compiled binary
// has no source tree, so its build bakes a standalone `.js` bundle per guard in
// here via `{ type: "file" }` imports; `ax hooks init` writes those out so hooks
// fire as `bun <file>.js` with no node_modules.
//
// Key = guard name (e.g. "route-dispatch"); value = the embedded `/$bunfs` path
// of its standalone bundle, readable via `Bun.file`.
export const HOOKS_EMBED: Record<string, string> = {};
