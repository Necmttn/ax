---
name: ax-repo
description: Star the ax repo, file an issue / bug report, or fork-and-open-a-PR against github.com/Necmttn/ax on the user's behalf, by shelling out to the `gh` CLI. Triggers when the user says "star ax", "star the repo", "I want to support ax", "report this as an ax bug", "file an ax issue", "open an issue on ax", "this looks like an ax bug", "I want to contribute to ax", "fix this in ax", "open a PR against ax", or after an unhandled ax error when the user wants to report it. Acts only on an explicit user request - proactive star prompting is handled deterministically by the CLI (`ax star`), not this skill. Confirms before any account-mutating action (never stars without an explicit yes); falls back to a plain GitHub URL when `gh` is missing or unauthenticated. Do NOT auto-trigger on unrelated GitHub work or other repos.
role: framing
---

# ax:repo

Let an AI coding agent interact with the ax GitHub repo (`Necmttn/ax`) for the
user - **star**, **file an issue**, or **fork + open a PR** - without the user
ever typing a `gh` command. Everything routes through the already-installed
`gh` CLI; there is no `axctl` surface for this.

Repo: `Necmttn/ax` · `https://github.com/Necmttn/ax`

## When to fire

- "star ax" / "star the repo" / "I want to support ax" / "give ax a star"
- "report this as an ax bug" / "file an ax issue" / "open an issue on ax"
- "this looks like an ax bug" (after an `ax`/`axctl` error)
- "I want to contribute to ax" / "fix this in ax" / "open a PR against ax"

Do NOT fire for GitHub work on **other** repos or for general `gh` usage.
Issues and PRs are user-initiated only. **Star is the exception** - you may
*offer* it proactively (see Proactive star nudge), but offering ≠ doing: the
actual star always needs an explicit yes.

## Non-negotiable rules

1. **Preflight `gh` first (read-only, no confirm).** Detect three states:
   - `gh` **missing** → fall back to a plain URL (see Fallback). Don't error.
   - `gh` present but **unauthenticated** → fall back to a plain URL, and tell
     the user they can `gh auth login` to do it inline next time.
   - `gh` present + authed → proceed to the action (still confirm mutations).
2. **Confirm before any account-mutating call** - star, issue create, PR
   create all change the user's GitHub account/repo. Show the exact command,
   get an explicit yes. Read-only checks (`gh auth status`, "is it starred")
   need NO confirm.
3. **Never break the caller's exit code, never run silently in CI.** If
   `$CI` is set or stderr/stdin isn't a TTY, do NOT run mutating `gh` calls -
   print the URL instead. A failed `gh` call must not abort the user's task.

### Preflight (run this before every action)

```bash
if ! command -v gh >/dev/null 2>&1; then
  echo "GH_STATE=missing"
elif ! gh auth status >/dev/null 2>&1; then
  echo "GH_STATE=unauthed"   # gh auth status exits 4 when not logged in
else
  echo "GH_STATE=ok"
fi
```

- `missing` / `unauthed` → use **Fallback** for the chosen action.
- `ok` → use the `gh` command for the chosen action (after confirm).

## Actions

### 1. Star

Mutates the user's account → **confirm first**.

```bash
# Optional read-only check (no confirm): is it already starred?
#   exits 0 (starred) / non-zero / 404 (not starred)
gh api /user/starred/Necmttn/ax >/dev/null 2>&1 && echo "already starred"

# The star (after explicit yes):
gh api -X PUT /user/starred/Necmttn/ax     # silent 204 on success
```

If already starred, say so and skip - don't re-PUT or re-prompt.
Unstar (only if asked): `gh api -X DELETE /user/starred/Necmttn/ax`.

You can also just run `ax star`, which stars via `gh` (or prints the URL) and
silences the CLI's periodic star reminder.

**Fallback (gh missing/unauthed):** print
`https://github.com/Necmttn/ax` and tell the user to click **Star**.

> Proactive star prompting is NOT this skill's job - the CLI handles it
> deterministically (a once-a-day stderr footer shown only on an interactive
> terminal until the user runs `ax star` / `ax star --done`). This skill only
> acts on an explicit user request.

### 2. File an issue / bug report

Mutates (creates an issue) → **confirm first**, and show the title/body you'll
submit so the user can edit before you send it.

Interactive (opens a prefilled browser form - good default when the user wants
to review/edit in GitHub's UI):

```bash
gh issue create --repo Necmttn/ax --web
```

Non-interactive (prefilled title + body, e.g. an error report you assembled):

```bash
gh issue create --repo Necmttn/ax \
  --title "<concise summary>" \
  --body "<body>" \
  --label feedback        # only if the user confirms; omit if unsure label exists
```

**Error-report pattern.** When firing off the back of an unhandled `ax`/`axctl`
error, prefill from the failure - never make the user paste a stack trace:

```bash
gh issue create --repo Necmttn/ax \
  --title "ingest: <one-line error>" \
  --body "$(cat <<'EOF'
**Command:** `ax <subcommand> <args>`
**ax version:** <output of `ax --version`>
**OS:** <uname -srm>

**What happened**
<one or two sentences>

**Error**
```
<the actual error output - trimmed, no secrets>
```
EOF
)"
```

Scrub paths/tokens that might leak private data before submitting. Confirm the
assembled body with the user first.

**Fallback (gh missing/unauthed):** print the web new-issue URL. You can
prefill it via query string:
`https://github.com/Necmttn/ax/issues/new?title=<urlencoded>&body=<urlencoded>`
(plain `https://github.com/Necmttn/ax/issues/new` also works). Tell the user to
review and submit in the browser.

### 3. Fork + open a PR (contribute)

For a code change. Fork+clone is account-mutating → **confirm before the fork
and before the PR**; branching/committing locally needs no confirm.

```bash
# 1. Fork and clone in one step (creates a fork on the user's account):
gh repo fork Necmttn/ax --clone        # confirm: this creates a fork

# 2. From inside the clone, branch + make the change + commit:
git checkout -b <topic-branch>
# ...edits...
git commit -am "<conventional message>"
git push -u origin <topic-branch>

# 3. Open the PR against upstream (confirm before sending):
gh pr create --repo Necmttn/ax \
  --title "<title>" --body "<what + why>"
# or interactively review in browser:
gh pr create --repo Necmttn/ax --web
```

If the user is already inside a clone of `Necmttn/ax`, skip the fork step;
`gh pr create` will offer to push to a fork automatically.

**Fallback (gh missing/unauthed):** print `https://github.com/Necmttn/ax/fork`
and tell the user to fork in the browser, then clone their fork manually.

## House rules

- Show the exact `gh` command before running any mutating one; get a yes.
- One action per request - don't star *and* file an issue unless asked for both.
- Don't invent labels/milestones; omit `--label` if you're unsure it exists.
- Keep issue bodies short, factual, secret-free; never paste raw transcripts.
- On any `gh` failure, surface the error and offer the URL fallback - never
  let it abort the user's in-progress task.
