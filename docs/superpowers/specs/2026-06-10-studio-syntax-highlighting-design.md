# Studio syntax highlighting - design

2026-06-10. Approved scope: Bash commands, Edit/Write tool args, fenced code blocks in turn text. Explicitly out: tool output blocks, theme toggle, server-side highlighting.

## Why

Session/share transcript views render all code as plain `<pre>` text. Commands, file edits, and fenced blocks in assistant prose are hard to scan.

## Library

Shiki v3, fine-grained bundle: `createHighlighterCore` from `shiki/core` + `createJavaScriptRegexEngine` from `shiki/engine/javascript` (no wasm). One light theme (`github-light`) - transcript surfaces are light; dark terminal output blocks are out of scope. Grammars dynamic-imported per language through a literal loader map so Vite splits each into its own lazy chunk; base bundle grows ~40KB gz.

## Core module - `apps/studio/src/highlight/`

- `lang.ts` (pure, tested):
  - `langFromPath(path)` - extension → grammar id (`.ts`/`.tsx`/`.js`/`.jsx`/`.json`/`.py`/`.rs`/`.go`/`.sql`/`.surql`→sql/`.md`/`.yaml`/`.sh`/`.css`/`.html`…), `null` when unknown.
  - `resolveLang(info)` - fence info-string aliases (`ts`→typescript, `sh|bash|zsh|shell`→shellscript, …).
  - `parseFences(text)` - full-coverage segmentation into `{ type: "text", raw }` and `{ type: "fence", raw, lang, body, openLine, closeLine }`. Unclosed fence runs to end of input. Reconstruction invariant: concatenated `raw` === input.
- `highlighter.ts` - module-level singleton `HighlighterCore` promise; `loadLang(lang)` resolves false for unsupported ids; tokenization via `codeToTokens`.
- `HighlightedCode.tsx` - `useHighlightTokens(code, lang)` hook returning themed token lines or `null` while loading; component renders plain text until tokens arrive (no layout shift - same font/whitespace), then colored spans. No `dangerouslySetInnerHTML`. Inputs >50KB render plain permanently.

## Integration

1. **Bash commands** - `tool-row.tsx` command `<pre>`: body becomes `<HighlightedCode lang="shellscript">`; `$` prefix and dim base color kept.
2. **Edit/Write args** - args grid in `tool-row.tsx`: for `Edit`/`Write`, values of `old_string`/`new_string`/`content` render as `HighlightedCode` with `langFromPath(input.file_path)`; `Edit` rows additionally get red (old) / green (new) row tint for a diff feel. Other tools/args unchanged.
3. **Fenced blocks in turn text** - `AnnotatedRawText` (session-inspect.tsx): each block slice runs through `parseFences`; text segments keep symbol-ref bolding, fence interiors render highlighted (no symbol bolding inside code), fence marker lines render dim. The annotated wrapper span (hover/click inspect targeting) is unchanged. The plain `Span` fallback path gets the same fence treatment.

Both live session-inspect and public share routes render through shared `Transcript` → `Turn`, so one change covers both views.

## Testing

- `lang.test.ts` - ext map, alias resolution, fence parsing (basic / unclosed / no-fence / reconstruction invariant).
- `tool-row.test.tsx` - command + Edit/Write arg rendering still emit code text (SSR renders the plain fallback; token swap is client-only).

## Risks

- Shiki async load: handled by plain-text fallback state.
- Very long sessions: highlighting bounded to command lines, edit args, fence interiors; >50KB guard.
