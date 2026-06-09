# Proud-session seed prompt

Paste this as the **first message of a fresh session** when you need to upload
"a coding-agent session you're proud of" (e.g. YC Startup School). The session
*is* the demo: one prompt in, the agent drives `ax` to find a genuinely
productive session, and ends on a public share URL. Two birds - showcases how
ax works *and* grounds a real shipped session.

```
Using ax, find the coding-agent session I should be most proud of from my work
on ax itself, and publish it as a shareable link.

Do it properly - don't pick by turn count alone:
- Use ax to list my sessions in this repo, then cross-check against what
  actually shipped (git commits / merged work) so "productive" means real,
  verifiable output.
- Among the productive ones, prefer a session that SHOWCASES WELL when shared -
  the trace should be visibly rich, not a flat back-and-forth. Favor a session
  that has:
    · subagents being dispatched (parallel builds, scouts, side-by-side work)
    · correction loops - where I caught something wrong and the agent
      verified, found the real cause, and fixed it (the recovery arc)
    · live dogfooding (browser/tool verification against real data)
    · a measurable shipped result (a perf win, a feature, numbers)
- Show me your evidence for the pick: what it shipped, the numbers, and which
  of the above signals it has (subagents dispatched, corrections recovered).
- Then publish it as a PUBLIC ax share and give me the URL as your final line,
  with one sentence on why this session is worth being proud of.

Keep it tight - this whole session is itself the demo.
```

## Why each line is there

| Beat | Line | Effect on the trace |
|------|------|---------------------|
| tool-dense, short | "Keep it tight" | forces `ax sessions here` → `git log` → `ax sessions show` → `ax share`; reviewer watches ax get driven |
| self-correction on camera | "cross-check against what shipped" | agent rejects turn-count and re-grounds - reads as rigor |
| share-viewer richness | the four `·` signals | steers the pick toward a visibly dense shared trace |
| ends on the artifact | "URL as your final line" | session closes on the thing the reviewer clicks |
| human hook | "one sentence on why" | gives the upload a caption |

## Subagent rendering - fixed in v0.16.0 (#145)

As of **ax 0.16.0** the share export is a multi-file bundle (`schema_version: 3`):
`index.json` manifest + `session.json` + one `subagent-*.json` per child, each
with full turns + timeline. Heavy-subagent sessions now render their parallel
work in the shared view - pick them freely; the richness criteria above all
show up. (Resolves https://github.com/Necmttn/ax/issues/145.)

> Note: on a fresh/large DB `ax share` can take ~100s, and the `ax-watch` daemon's
> background `ingest --since=1` can wedge SurrealDB and starve it. If `share`
> hangs, check `pgrep -fl "ingest --since=1"` and kill a stalled watcher run
> (it re-fires automatically).
