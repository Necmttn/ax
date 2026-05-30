#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const versionArg = process.argv[2]?.replace(/^v/, "");

if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)) {
    console.error("usage: bun scripts/create-release-announcement.ts <X.Y.Z> [--force]");
    process.exit(2);
}

const force = process.argv.includes("--force");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp(`^## \\[?${versionArg.replace(/\./g, "\\.")}\\]?.*$`, "m");
const match = changelog.match(heading);

if (!match || match.index === undefined) {
    console.error(`release ${versionArg} was not found in CHANGELOG.md`);
    process.exit(1);
}

const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## /m);
const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
const releaseRange = resolveReleaseRange(match[0], versionArg);
const bullets = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("* "))
    .map((line) => line.slice(2).trim());

const today = new Date().toISOString().slice(0, 10);
const outDir = join("docs", "releases");
const outPath = join(outDir, `v${versionArg}.md`);

if (existsSync(outPath) && !force) {
    console.error(`${outPath} already exists; pass --force to overwrite`);
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const highlightLines = bullets.length > 0
    ? bullets.map((line) => `* ${line}`).join("\n")
    : "* Replace this with the main user-visible changes.";

const rangeCommands = releaseRange
    ? `BASE_REF=${releaseRange.baseRef}
HEAD_REF=${releaseRange.headRef}

git diff --name-status "$BASE_REF..$HEAD_REF"
git log --reverse --format='%h %cs %s' "$BASE_REF..$HEAD_REF"
ax ingest here --since=30d
ax sessions here --days=30
ax sessions near <important-sha-from-range>
ax recall "<changed subsystem or decision>" --sources=turn,commit --scope=here`
    : `# Could not infer the previous release range from CHANGELOG.md.
git tag --sort=-version:refname
git diff --name-status <previous-tag>..HEAD
git log --reverse --format='%h %cs %s' <previous-tag>..HEAD
ax ingest here --since=30d
ax sessions here --days=30
ax sessions near <important-sha-from-range>
ax recall "<changed subsystem or decision>" --sources=turn,commit --scope=here`;

const changedFilesBlock = releaseRange?.changedFiles
    ? releaseRange.changedFiles
    : "# Run the git diff command above and paste the file list here if this draft was generated before tags were available.";

const commitBlock = releaseRange?.commits
    ? releaseRange.commits
    : "# Run the git log command above and use the output as the commit range map.";

const draft = `---
version: "${versionArg}"
date: "${today}"
title: "Release ${versionArg}"
summary: "Replace this with a one-sentence user-facing summary."
---

Release ${versionArg} is ready to announce.

If you are an agent, use the \`ax:release-announcement\` skill before rewriting
this draft.

Rewrite this draft into a topical release announcement. Keep the generated
changelog factual, but explain the user-visible change in product language and
show how the release came together.

Before writing, reconstruct the path to the release:

1. Run repo-scoped ingest if needed:

\`\`\`bash
ax ingest here --since=14d
\`\`\`

2. Determine the release range, all changed files, and all commits since the
   previous version:

\`\`\`bash
${rangeCommands}
\`\`\`

3. Use the changed-file list to identify the touched subsystems. Use the commit
   list to identify the important SHAs. For each high-impact SHA or subsystem,
   inspect nearby agent sessions with \`ax sessions near <sha>\` and search the
   transcript graph with \`ax recall\`.

4. Use the session evidence to write the announcement as a decision path:
   the problem, the options or tradeoffs, the decision, and what changed.
   Do not invent motivation that is not visible in commits, issues, sessions,
   or docs. If session evidence is missing, say what the commits prove instead.

Use the generated bullets below as references, not as the announcement shape.

### Release range evidence

Base: ${releaseRange?.baseRef ?? "Replace with previous release tag"}
Head: ${releaseRange?.headRef ?? "Replace with release head or tag"}

Changed files:

\`\`\`text
${changedFilesBlock}
\`\`\`

Commit range:

\`\`\`text
${commitBlock}
\`\`\`

### Highlights

${highlightLines}

### How we got here

Explain the short decision tree behind the release. Name the user-visible
problem, the alternatives considered, and the reason the final shape won.

### What changed

Group changes by topic. For each topic, connect the narrative to concrete
commits, issues, commands, screens, or docs. Prefer a few specific references
over a broad undifferentiated list.

### Example

Add a short code or CLI example when the release changes a command, API,
configuration, schema, workflow, or output format.

\`\`\`bash
# Replace this with the smallest useful before/after or new workflow.
ax sessions here --days=14
\`\`\`

### Visual evidence

Add an image when the release changes a website, dashboard, TUI, CLI output, or
workflow that benefits from seeing the shape. Store website-visible assets under
\`site/public/releases/assets/\` and reference them with an absolute path.

![Replace with a focused screenshot or diagram alt text](/releases/assets/example.png)

### Why it matters

Explain the practical impact for someone using ax day to day.
`;

writeFileSync(outPath, draft);
console.log(`wrote ${outPath}`);

type ReleaseRange = {
    baseRef: string;
    headRef: string;
    changedFiles: string;
    commits: string;
};

function resolveReleaseRange(headingLine: string, version: string): ReleaseRange | null {
    const compareMatch = headingLine.match(/compare\/([^\s)]+?)\.\.\.([^\s)]+)/);
    const baseRef = compareMatch?.[1];
    const releaseTag = compareMatch?.[2] ?? `v${version}`;
    if (!baseRef) return null;

    const headRef = gitRefExists(releaseTag) ? releaseTag : "HEAD";
    const range = `${baseRef}..${headRef}`;
    const changedFiles = runGit(["diff", "--name-status", range]);
    const commits = runGit(["log", "--reverse", "--format=%h %cs %s", range]);

    return {
        baseRef,
        headRef,
        changedFiles: changedFiles.trim(),
        commits: commits.trim(),
    };
}

function gitRefExists(ref: string): boolean {
    try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

function runGit(args: string[]): string {
    try {
        return execFileSync("git", args, { encoding: "utf8" });
    } catch {
        return "";
    }
}
