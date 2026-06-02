# OSS CLI feedback & growth mechanics - research for `ax`

Research date: 2026-06-02. Grounding for light, organic, user-driven promotion of
`ax` (`axctl` CLI + installable Claude Code skill). Focus: feedback/star/issue
prompts from inside the CLI, `gh`-as-growth-surface, the raycast fork-model, the
`ax share` gist loop, and sharing "taste" via fork/star.

---

## 1. CLI-driven feedback & growth - how popular CLIs prompt from inside the tool

Concrete patterns, ordered roughly from most-respectful to most-controversial.

- **npm `funding` field + `npm fund` subcommand** - the *reference* respectful
  pattern. Maintainers add a `funding` field to `package.json`; after install npm
  prints a single aggregate line ("N packages are looking for funding, run
  `npm fund`"). No per-package terminal spam; opt-in detail on demand; `--no-fund`
  silences it. This replaced postinstall messages industry-wide.
  https://blog.opencollective.com/beyond-post-install/ ·
  https://benjamincrozat.com/npm-fund
- **Homebrew anonymous analytics, opt-out with a pre-collection notice** - on the
  *first* `brew update`/install Homebrew prints a one-time notice pointing to the
  analytics doc, and **no data is sent until after that notice is shown**, so a
  user can opt out before anything leaves the machine. Disable via
  `HOMEBREW_NO_ANALYTICS=1` or `brew analytics off`.
  https://docs.brew.sh/Analytics
- **GitHub CLI (`gh`) opt-out telemetry (v2.91.0, Apr 2026)** - client-side usage
  telemetry, on by default, with a clearly documented opt-out (env var or config)
  and a dedicated Telemetry doc page. Note: even GitHub shipping *default-on*
  telemetry drew pushback (The Register coverage), so default-on is the risky end.
  https://github.blog/changelog/2026-04-22-github-cli-opt-out-usage-telemetry/ ·
  https://www.theregister.com/2026/04/22/github_opts_all_cli_users
- **GitHub Copilot CLI `/feedback` slash command** - in-session command that opens
  the feedback/issue flow without making the user hunt for the repo. Good model
  for an interactive nudge that's pull-not-push (user invokes it).
  https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli
- **"Effortless bug reports" via prepopulated issue URL** - the Node.js CLI Apps
  Best Practices guide (§6.5) recommends: on error, print a URL to open an issue
  **with the title/body/stack prepopulated** so reporting is one click. (§8.1:
  analytics must be strict opt-in with disclosure.) This is the canonical "make
  feedback frictionless" recommendation, widely cited.
  https://github.com/lirantal/nodejs-cli-apps-best-practices
- **`gh-star` / `gh-stars` extensions** - community `gh` extensions that star or
  search-starred-repos from the terminal, proving users accept "star from CLI" UX.
  https://github.com/maggie-j-liu/gh-star · https://github.com/Link-/gh-stars
- **core-js postinstall message - the cautionary anti-pattern** - Denis Pushkarev's
  "please consider supporting / I'm looking for a job" postinstall banner generated
  "hundreds of hateful messages per day," broke `npm ci` in CI, and is the canonical
  example of why per-install terminal ads are now considered spam. Multiple GitHub
  issues demanded its removal ("Get rid of postinstall message" #548).
  https://www.thestack.technology/core-js-maintainer-denis-pusharev-license-broke-angry/ ·
  https://github.com/zloirock/core-js/issues/548
- **OpenCollective itself stopped recommending postinstall messages** after the
  backlash - they pivoted to the `npm fund` field. Strong signal: the ecosystem
  has *already litigated* this and landed on quiet, opt-in, on-demand.
  https://blog.opencollective.com/beyond-post-install/

### Respectful vs. spammy - the line

- **Respectful:** one-time / first-run only; aggregate not per-dependency; on a
  command the user *invoked* (`--feedback`, `/feedback`); silenceable by env var;
  never breaks CI exit codes; never repeats every run.
- **Spammy:** prints on *every* install/run; emitted during `postinstall` (hits CI,
  non-interactive); changes exit code; ASCII-art donation/job banners; no opt-out.

### What ax could do

- Add a one-time **first-run notice** (after first successful `ax ingest`), gated
  the same way the existing `AX_PROGRESS` TTY check is - only on an interactive
  stderr, never in the LaunchAgent/cron path. One line: "ax is open source - star
  or report issues: github.com/Necmttn/ax · `ax feedback`". Persist a
  `~/.ax/first-run-seen` flag so it never repeats.
- Add an **`ax feedback`** subcommand (pull, not push) that shells to `gh issue
  create` with a prepopulated template (see §2), mirroring Copilot CLI `/feedback`
  and the Node best-practices §6.5 prepopulated-URL pattern.
- On **unhandled error**, print a prepopulated "report this" URL
  (`github.com/Necmttn/ax/issues/new?title=...&body=...`) including the failing
  command + ax version - never a stack-dump the user has to copy.
- Keep any telemetry **strict opt-in** with a Homebrew-style pre-collection notice;
  do NOT follow `gh`'s default-on choice given ax's privacy-sensitive transcript data.

---

## 2. Using `gh` CLI as a growth surface

`gh` is already installed/authed for most of ax's target users (Claude Code devs),
so shelling out to it is low-friction and needs no token handling in ax itself.

### Exact commands ax can embed

- **Star the repo:** `gh api -X PUT /user/starred/Necmttn/ax`
  (unstar: `gh api -X DELETE /user/starred/Necmttn/ax`) - verified against the
  `gh-star` extension source. https://github.com/maggie-j-liu/gh-star
- **Open an issue (prepopulated):**
  `gh issue create --repo Necmttn/ax --title "..." --body "..." [--label feedback]`
  https://cli.github.com/manual/gh_issue_create
- **Open the web issue form prepopulated (no gh required):**
  `gh issue create --web` or just open
  `https://github.com/Necmttn/ax/issues/new?title=...&body=...&labels=feedback`
- **Fork + clone for contribution:** `gh repo fork Necmttn/ax --clone`
  (single command forks and clones - the on-ramp for §3/§5 contributions).
  https://cli.github.com/manual
- **Check if starred (to avoid re-prompting):**
  `gh api /user/starred/Necmttn/ax` returns 204 if starred, 404 if not.

### Auth/UX caveats

- Requires `gh` installed **and** `gh auth login` completed. ax must detect both
  (`command -v gh` + `gh auth status`) and **fall back to printing a plain URL**
  (`open`/`xdg-open` or just echo) when absent - never error out.
- Starring/issue creation mutate the user's GitHub account → **always confirm**
  ("Star Necmttn/ax? [y/N]") before the PUT. Silent starring would be the new spam.
- Non-interactive contexts (CI, LaunchAgent) must skip entirely.

### Sketch: `ax feedback` / `ax star` / `ax issue`

```
ax star                 # confirm → gh api -X PUT /user/starred/Necmttn/ax
                        #   (fallback: open repo URL in browser)
ax issue ["title"]      # gh issue create --repo Necmttn/ax --web,
                        #   body prefilled with ax version + last command + os
ax feedback             # interactive menu: [star] [bug] [idea] [share session]
                        #   each routes to the gh command above, gh-absent→URL
```

Detection helper (one place, reused): if `gh auth status` ok → use `gh`; else
open/echo the equivalent `github.com/...` URL.

---

## 3. The raycast-extensions fork-model - and analogous fork-magnets

### How raycast/extensions works

- **Single public monorepo** holds *all* community extensions; contributing an
  extension = fork + add a folder + PR. The repo is huge (>20 GB), so they ship
  tooling (sparse-checkout / "Forked Extensions" tool) to fork just one extension.
  https://github.com/raycast/extensions ·
  https://developers.raycast.com/information/developer-tools/forked-extensions
- **In-product fork action:** the "Fork Extension" command *inside Raycast* pulls
  an extension's source locally - the fork is initiated from the tool, not GitHub.
  https://developers.raycast.com/basics/contribute-to-an-extension
- **Manifest-driven:** each extension is a folder with a `package.json` manifest
  (name, contributors, categories) + `CHANGELOG.md`. Contributors add themselves
  to the `contributors` array and bump the changelog as part of the PR.
- **Dev loop:** `npm install && npm run dev` runs the extension live in Raycast;
  publish is a validated PR. On merge, the extension **auto-publishes to the Store**
  - the reward loop is immediate and visible.
  https://developers.raycast.com/basics/publish-an-extension
- Net effect: every contributor *must* fork → thousands of forks, and each is a
  durable backlink + a person invested in the repo.

### Analogous models and their contribution surface

- **Homebrew taps/casks:** add software = PR a `Formula`/`Cask` Ruby file (or run
  your own tap repo). "Compare across forks" PR into `Homebrew/homebrew-cask`.
  https://docs.brew.sh/Adding-Software-to-Homebrew ·
  https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- **Obsidian community plugins:** PR / web submission adds an entry to
  `community-plugins.json` in `obsidianmd/obsidian-releases`; a **bot validates**
  the repo's `manifest.json` + release assets automatically.
  https://github.com/obsidianmd/obsidian-releases ·
  https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- **n8n community nodes:** node = npm package named `n8n-nodes-*` with an `n8n`
  attribute in `package.json`; verified nodes publish via a GitHub Action with
  provenance and get listed in the Creator portal.
  https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/
- **oh-my-zsh (2,500+ contributors):** plugins/themes live in-repo (PR to add) +
  an "External plugins/themes" **wiki** for the long tail. The in-repo + wiki split
  keeps the core curated while letting anyone list theirs.
  https://github.com/ohmyzsh/ohmyzsh/wiki/Plugins ·
  https://github.com/ohmyzsh/ohmyzsh/wiki/External-plugins
- **Starship presets:** "have a preset to share? submit a PR updating the presets
  file" - a single registry file edit. https://starship.rs/presets/

### Common ingredients that turn a repo into a fork-magnet

1. **A registry/manifest as the unit of contribution** - one JSON/folder/file you
   add (raycast folder, Obsidian `community-plugins.json`, starship presets file).
2. **Fork+PR is the *only* contribution path** → forks scale 1:1 with contributors.
3. **Low friction tooling** - `gh repo fork --clone`, sparse-checkout, sample
   templates (`obsidian-sample-plugin`), `npm run dev` live loop.
4. **Bot validation** of the manifest so maintainers don't hand-review boilerplate.
5. **Immediate, visible reward** - auto-publish to a store/gallery on merge.
6. **"Add your X here" framing** in the README that makes the PR feel expected.

### What ax could adopt

- Create a **`ax-skills` (or `ax-gallery`) registry repo**: a folder/JSON-manifest
  per community-contributed **skill / taste-profile / classifier**. Contributing =
  `gh repo fork --clone` + add `skills/<name>/SKILL.md` (or `profiles/<user>.json`)
  + PR. Mirrors raycast exactly and turns each contributor into a fork+backlink.
- Ship `ax skills new <name>` / `ax classifier new <name>` scaffolders (like
  `obsidian-sample-plugin` + `npm run dev`) so the local dev loop is one command.
- Add a **validation GitHub Action** on the registry repo (schema-check the
  manifest, lint the SKILL.md) so PRs self-review - Obsidian/n8n pattern.
- README "Add your skill" section + `ax skills publish` that runs the fork+PR for
  the user. The existing `npx skills add Necmttn/ax` install path is the consume
  side; add the *contribute* side.

---

## 4. Gist share → repo loop (`ax share`)

`ax share` publishes a session as a JSON gist. Gists support **multiple files**, so
the lever is: ship a self-documenting header + a human-readable companion file that
both explain the artifact and pull the finder toward the repo.

### Patterns / prior art for self-documenting, self-promoting shared output

- **asciinema `.cast`** - lightweight human-readable JSON with a header line
  (`version`, `width`, `term`, etc.); recordings are shareable/embeddable and the
  format is documented, so a found `.cast` is self-explaining.
  https://docs.asciinema.org/how-it-works/
- **Val.Town** - every val embed/share carries provenance: forks are tracked in-DB
  (was a `// Forked from @x.val` comment), source URL is derivable via
  `import.meta.url.replace("esm.town","val.town")`, and shares get OpenGraph
  preview images. Forking and back-linking are first-class.
  https://docs.val.town/guides/embed/ ·
  https://blog.val.town/blog/redesigning-val-pages/
- **GitHub gist + README** - a gist whose first file is `README.md` renders the
  markdown at the top of the gist page, so a `README.md` "what is this?" file is the
  natural explainer slot. https://gist.github.com/benstr/8744304
- carbon.now.sh / ray.so / tldraw / excalidraw share links similarly embed
  source-tool branding/URLs into the shared artifact so the artifact advertises the
  tool (watermark / "open in" link) - same principle: the share *is* the ad.

### Proposed gist structure for `ax share`

Publish a **multi-file gist**:

1. `README.md` (first file → renders on top):
   ```
   # ax session share
   Generated by **ax** - local taste & telemetry graph for AI coding agents.
   What this is → https://github.com/Necmttn/ax
   Schema (v1) → https://github.com/Necmttn/ax/blob/main/docs/share-schema.md
   Reproduce locally: `npx axctl ...`
   ```
2. `session.json` with a top-level `_ax` envelope block so the JSON is
   self-describing even out of context:
   ```jsonc
   {
     "_ax": {
       "tool": "ax",
       "generated_by": "axctl",
       "version": "0.1.x",
       "schema": "ax.session/1",
       "repo": "https://github.com/Necmttn/ax",
       "docs": "https://github.com/Necmttn/ax/blob/main/docs/share-schema.md",
       "created_at": "2026-06-02T..."
     },
     "session": { /* ... existing payload ... */ }
   }
   ```

This makes any leaked/found gist (a) parseable by a future ax version (schema +
version), (b) human-understandable (README), (c) a backlink to the repo + docs.

### What ax could do

- Inject the `_ax` envelope into the gist JSON **today** (small, additive, no schema
  break for consumers that read `.session`).
- Add the `README.md` companion file to the gist (gist API accepts multiple files
  in one create call - `gh gist create file1 file2`).
- Add a public **`docs/share-schema.md`** so the `docs` URL resolves.
- Optional: a "view this share" web route on the site that renders a gist URL
  prettily (asciinema-style player) → stronger pull than raw JSON.

---

## 5. Sharing "taste" via fork/star instead of (or alongside) gist

Ephemeral gists are throwaway; the owner wants taste-profiles to live as durable,
forkable, star-able artifacts. Prior art for user config living in a forked repo or
a PR to a central registry:

- **Starship presets** - share a preset by PRing the presets file; users discover +
  copy. https://starship.rs/presets/
- **Dotfiles repos** - the entire "fork my dotfiles" culture: config lives as files
  in a personal repo that others fork/star (oh-my-zsh external-themes wiki is the
  registry layer over this). https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
- **Neovim distros (LazyVim/AstroNvim/NvChad)** - users fork the distro and commit
  their config on top; the distro repo accrues forks = users = backlinks.
- **raycast/Obsidian/n8n registries** (§3) - the "PR your manifest" model applied to
  config rather than code.

### Proposed mechanisms for ax (pick 1–2)

1. **`ax share --to-repo` → PR a profile into a gallery repo.** Opens a PR adding
   `profiles/<github-user>.json` to `Necmttn/ax-gallery` (via `gh repo fork --clone`
   + branch + `gh pr create`). Durable, indexable, each PR = a contributor +
   backlink. Tradeoff: needs **moderation** (spam/abuse) and a **PII scrub** step -
   the profile must export *taste signals* (which skills/tools/roles you use,
   weighted), NOT raw transcripts or telemetry. Add a schema + bot-validation Action
   (Obsidian pattern) so PRs self-check.
2. **A forkable "taste gallery" template repo.** `Necmttn/ax-taste-template` that
   users `gh repo fork` and `ax export-profile > profile.json` into. They keep
   ownership/privacy (their repo, their visibility); ax discovers profiles via a
   GitHub topic (e.g. `ax-taste-profile`) or a registry PR. Lower moderation burden
   (each lives in the user's own repo); weaker central discovery.
3. **Star-to-share, gist-as-snapshot hybrid.** Keep `ax share` (gist) as the quick
   ephemeral path, but on share, prompt: "Make this durable? Open a PR to the ax
   gallery" → routes into mechanism 1. Best of both: low-friction default + durable
   opt-in.

### Tradeoffs to design around

- **Privacy:** taste-profiles must be *derived signals* (counts, roles, weights),
  never raw `~/.claude` transcripts. Make the export explicitly redacted and show a
  preview/diff before any PR.
- **Moderation/spam:** a central gallery PR stream needs CODEOWNERS + a validation
  Action + maybe `profiles/` size/format limits. The forkable-template model (mech.
  2) sidesteps most of this.
- **Consent:** publishing must be an explicit, confirmed action (same bar as `ax
  star`), never automatic from ingest.

---

## Recommended next steps for ax (ranked by impact / effort)

1. **`ax feedback` + `ax star` + `ax issue` subcommands** shelling to `gh` with
   URL fallback. *(High impact, low effort.)* Exact commands in §2; reuse the
   existing TTY/non-interactive gating from `withIngest`.
2. **Inject `_ax` envelope + `README.md` into `ax share` gists.** *(High impact,
   low effort.)* Makes every existing share a self-documenting backlink. §4.
3. **One-time first-run star/feedback notice** (interactive stderr only, persisted
   flag, env-silenceable) + prepopulated "report this" URL on unhandled errors.
   *(Med impact, low effort.)* Follow Homebrew's pre-collection-notice restraint;
   avoid core-js's per-install spam. §1.
4. **`ax-gallery` registry repo + `ax share --to-repo`** (fork+PR a redacted
   `profiles/<user>.json`) with a schema-validation Action. *(High impact, med
   effort.)* The raycast fork-magnet model applied to taste-profiles. §3/§5.
5. **`ax skills publish` / `ax skills new` scaffold + "Add your skill" registry**
   so community skills/classifiers arrive as fork+PRs, mirroring raycast/Obsidian.
   *(High impact, higher effort - biggest long-term fork-count lever.)* §3.
6. **Strict opt-in telemetry only, Homebrew-style.** *(Defensive.)* Given ax
   ingests private transcripts, do NOT copy `gh`'s default-on telemetry; pre-notice
   + explicit opt-in. §1.
