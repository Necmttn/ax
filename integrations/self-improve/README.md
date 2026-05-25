# self-improve integration

Hooks for `~/.claude/self-improve/` (the user's weekly skill self-improvement
pipeline) that consume `ax`'s telemetry DB.

Two scripts:

- **`ax-ingest.ts`** - runs `axctl ingest --since=14` to refresh the
  SurrealDB. Logs to `<RUN_DIR>/ax-ingest.log`. Designed to slot into
  `run.sh` as the `ax-ingest` step, immediately before `extract`.

- **`deprecate-helper.ts`** - runs `axctl unused --days=90`, parses its
  output, filters out anything in `~/.claude/self-improve/keep.txt`, and writes
  `<RUN_DIR>/deprecation-candidates.json`. Intended to be called from the
  `deprecate` step (or run on demand).

Both scripts are **graceful**: if `axctl` isn't on `PATH`, they write a
"skipped" / "unavailable" record and exit 0, so an absent `axctl` won't
break the self-improve cron.

## Install

The self-improve runner expects step scripts at `~/.claude/self-improve/lib/`.
Symlink or copy these scripts in:

```bash
SELF_IMPROVE_HOME="$HOME/.claude/self-improve"
AX_REPO="$HOME/Projects/ax"

# Symlink the ingest step (preferred - picks up upstream fixes automatically)
ln -sf "$AX_REPO/integrations/self-improve/ax-ingest.ts" \
       "$SELF_IMPROVE_HOME/lib/ax-ingest.ts"

# deprecate-helper is invoked by lib/deprecate.ts; symlink alongside lib/
ln -sf "$AX_REPO/integrations/self-improve/deprecate-helper.ts" \
       "$SELF_IMPROVE_HOME/lib/ax-deprecate-helper.ts"
```

Then add the step to `run.sh` immediately before `extract`:

```bash
run_step ax-ingest
print_budget
run_step extract
# ...
```

The `deprecate` step should call the helper and merge its output with the
existing `deprecations.json`. See `lib/deprecate.ts` in the self-improve repo.

## Configuration

Environment variables read by `ax-ingest.ts`:

| Var                          | Default | Meaning                          |
| ---------------------------- | ------- | -------------------------------- |
| `AX_INGEST_SINCE_DAYS`       | `14`    | Days back for `--since=N`        |

`deprecate-helper.ts` accepts `--days=N` (default `90`).

## Output schemas

### `<RUN_DIR>/ax-ingest.log`

Plain text; combined stdout/stderr of `axctl ingest`, prefixed with
`[ax-ingest]` lifecycle markers.

### `<RUN_DIR>/deprecation-candidates.json`

```json
{
  "generated_at": "2026-05-08T12:00:00.000Z",
  "days": 90,
  "source": "ax",
  "candidates": [
    {
      "slug": "old-skill-name",
      "scope": "project",
      "total_invocations": 3,
      "last_used": "2025-11-15T03:21:55.000Z"
    }
  ],
  "kept": ["protected-skill"]
}
```

When `axctl` is missing, `source` is `"unavailable"` and both arrays are
empty.
