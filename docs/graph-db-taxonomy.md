# Graph DB Taxonomy

## File Evidence

File evidence uses shared graph relations regardless of transcript provider:

```text
turn      -> edited        -> file
tool_call -> read_file     -> file
tool_call -> searched_file -> file
turn      -> mentioned_file -> file
```

`edited`, `read_file`, and `searched_file` all use local-path file identity
when the transcript only exposes a checkout path. Writers preserve both the
raw `path_seen` from tool arguments and the cwd-resolved
`absolute_path_seen`.

## Provider Parity

| Provider | Edit evidence | Read evidence | Search evidence | Notes |
| --- | --- | --- | --- | --- |
| Claude | Implemented from `Edit`, `Write`, `MultiEdit`, `NotebookEdit` tool inputs. | Implemented from `Read` tool inputs. | Implemented from `Grep` and `Glob` tool inputs. | Existing Claude edit extraction is now backed by the shared writer path. |
| Codex | Implemented for `apply_patch` patch headers when present in function-call arguments. | Shared helper supports structured read paths when present. | Shared helper supports structured search paths when present. | Shell command path parsing beyond structured args is intentionally deferred. |
| Pi | Implemented from structured tool-call path fields. | Implemented from structured `read` tool-call path fields. | Implemented from structured `grep`/`glob` path fields. | Uses the same `tool_call -> file` relation writer as Codex and Claude. |
| OpenCode | Pending. | Pending. | Pending. | Concrete tool-call extraction is owned by #88 before this provider can emit reliable file evidence. |
| Cursor | Pending. | Pending. | Pending. | Concrete tool-call extraction is owned by #89 before this provider can emit reliable file evidence. |

The read side should query these relation tables directly. It should not branch
on provider names to answer "what did this session edit/read/search?".
