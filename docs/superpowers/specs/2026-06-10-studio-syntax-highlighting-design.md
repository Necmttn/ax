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

## Increment 2: stdout enrichment (2026-06-11)

Tool output blocks read as one pale slab. Data facts: stored outputs carry no
ANSI codes; Read results are `NNN<tab>code` (cat -n) lines; Bash outputs are
mostly paths/logs. So:

- **Dark theme** - second Shiki theme `catppuccin-mocha` (its editor bg
  #1e1e2e === `--term-bg`), threaded as a `theme` param through
  tokenize/useHighlightTokens/HighlightedCode.
- **Read results** (`numbered-code.tsx`) - strip the line-number gutter,
  highlight the code with `langFromPath(file_path)` on the dark theme,
  re-attach the gutter dim. Unnumbered tails survive verbatim.
- **Everything else** (`log-line.tsx`) - tiny synchronous log tokenizer:
  file paths (blue), error/warn words (red/amber), numbers-with-units
  (peach), diff +/- lines (green/red, only when the text looks like a
  unified diff). Applied in the tool-card output block and ToolResultView.
- **Skill cards** - injected SKILL.md renders as dark-theme markdown.

Same invariants as increment 1: rendered text === input, >50KB renders plain.

## Risks

- Shiki async load: handled by plain-text fallback state.
- Very long sessions: highlighting bounded to command lines, edit args, fence interiors; >50KB guard.
