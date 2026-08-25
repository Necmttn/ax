/**
 * `ax prompts` - reverse search over the prompts YOU typed.
 *
 *   ax prompts [-q TEXT] [--days=N] [--limit=N] [--here|--project=PATH]
 *              [--json] [--tsv]
 *
 * Browse with no query, search with one. Cross-harness (claude, codex, pi,
 * opencode, cursor), deduped, newest first, with a repeat count.
 *
 * WHY `--tsv` EXISTS AND WHY THIS COMMAND HAS NO TUI. The point of a reverse
 * search is the interactive picker, and ax should not ship one: `fzf` and
 * `atuin` are already installed, already have the muscle memory, and already do
 * fuzzy/exact/negation better than anything added here would. So the deliverable
 * is a clean line-oriented stream and the picker stays the user's choice:
 *
 *   ax prompts --tsv --days=365 \
 *     | fzf --delimiter='\t' --with-nth=1,2,4 \
 *           --preview="printf '%s' {4} | sed 's/\\\\n/\\n/g'" \
 *     | cut -f4- | sed 's/\\n/\n/g' | pbcopy
 *
 * `--tsv` escapes newlines to a literal `\n` so every prompt is exactly one
 * line - multi-line prompt handling is the specific thing Claude Code's own
 * Ctrl+R gets wrong, and a line-oriented consumer cannot fix it after the fact.
 * `--json` carries the real text unescaped.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import {
    fetchPrompts,
    PROMPTS_DEFAULT_LIMIT,
    PROMPTS_DEFAULT_WINDOW_DAYS,
} from "../../queries/prompts.ts";
import { resolvePwdIdentity } from "../../pwd.ts";
import { projectRootForHere } from "./sessions.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";
import { stderrExit } from "../output.ts";

/**
 * `--here` means THE GIT REPO, not the literal cwd - the same meaning it carries
 * in `ax sessions here` and `ax ingest here`, via the same `projectRootForHere`
 * helper (which also rolls a `.claude/worktrees/*` worktree up to the primary
 * checkout, with the caveats documented on it).
 *
 * Using `process.cwd()` here was the first version and it was wrong in the exact
 * place a developer stands: run it inside a worktree and it reported "no prompts"
 * for a repo with hundreds, because no session's `cwd` was ever that directory.
 * An empty result that looks like an answer is worse than an error.
 */
const scopeForHere = () =>
    Effect.gen(function* () {
        const pwd = yield* resolvePwdIdentity().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                stderrExit(`ax prompts: --here requires a git repository (cwd=${err.cwd})\n`, 2),
            ),
        );
        return projectRootForHere(pwd);
    });

/** One display line: newlines shown as a glyph so a row cannot wrap the table. */
const oneLine = (text: string): string => text.replace(/\s*\n+\s*/g, " ⏎ ").trim();

/** TSV cell: escape the separators, so a prompt can never break the contract. */
const tsvCell = (text: string): string =>
    text.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, " ");

const clip = (text: string, width: number): string =>
    text.length <= width ? text : `${text.slice(0, width - 1)}…`;

const cmdPrompts = (input: {
    readonly query: string | undefined;
    readonly sinceDays: number;
    readonly limit: number;
    readonly here: boolean;
    readonly project: string | undefined;
    readonly json: boolean;
    readonly tsv: boolean;
}) =>
    Effect.gen(function* () {
        const scope = input.here ? yield* scopeForHere() : input.project;
        const result = yield* fetchPrompts({
            sinceDays: input.sinceDays,
            limit: input.limit,
            query: input.query,
            scope,
        });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (input.tsv) {
            // ts \t source \t cwd \t text. No header: this stream is for a pipe.
            for (const row of result.rows) {
                console.log(
                    [
                        row.ts.slice(0, 16).replace("T", " "),
                        row.source,
                        row.cwd ?? "?",
                        tsvCell(row.text),
                    ].join("\t"),
                );
            }
            return;
        }

        if (result.rows.length === 0) {
            console.log(
                input.query
                    ? `(no prompts matching "${input.query}" in the last ${result.since_days} days)`
                    : `(no prompts in the last ${result.since_days} days)`,
            );
            // A genuinely empty window and a stale snapshot look identical here,
            // so say which check settles it rather than leaving it ambiguous.
            console.log("(prompts come from ingested transcripts - run `ax ingest` if this looks short)");
            return;
        }

        console.log(
            `${"when".padEnd(16)}  ${"harness".padEnd(9)}  ${"×".padStart(3)}  prompt`,
        );
        for (const row of result.rows) {
            console.log(
                `${row.ts.slice(0, 16).replace("T", " ").padEnd(16)}  ` +
                `${row.source.slice(0, 9).padEnd(9)}  ` +
                `${(row.repeats > 1 ? String(row.repeats) : "").padStart(3)}  ` +
                clip(oneLine(row.text), 96),
            );
        }

        const shown = result.rows.length;
        const scopeNote = result.scope ? ` under ${result.scope}` : "";
        console.log(
            shown < result.total
                ? `\n(${shown} of ${result.total} distinct prompts, last ${result.since_days} days${scopeNote} - raise --limit)`
                : `\n(${shown} distinct prompt${shown === 1 ? "" : "s"}, last ${result.since_days} days${scopeNote})`,
        );
    });

export const promptsCommand = Command.make(
    "prompts",
    {
        query: Flag.string("query").pipe(
            Flag.withAlias("q"),
            Flag.withDescription("case-insensitive substring to match"),
            Flag.optional,
        ),
        days: Flag.integer("days").pipe(Flag.withDefault(PROMPTS_DEFAULT_WINDOW_DAYS)),
        limit: Flag.integer("limit").pipe(Flag.withDefault(PROMPTS_DEFAULT_LIMIT)),
        here: Flag.boolean("here").pipe(
            Flag.withDescription("scope to this git repo (worktrees roll up to the primary checkout)"),
        ),
        project: Flag.string("project").pipe(
            Flag.withDescription("scope to an absolute path and everything under it"),
            Flag.optional,
        ),
        json: jsonFlag,
        tsv: Flag.boolean("tsv").pipe(
            Flag.withDescription("tab-separated stream for fzf/atuin (newlines escaped to \\n)"),
        ),
    },
    ({ query, days, limit, here, project, json, tsv }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax prompts: --days must be a positive integer (got "${days}")`);
        }
        if (!Number.isInteger(limit) || limit <= 0) {
            fail(`ax prompts: --limit must be a positive integer (got "${limit}")`);
        }
        const explicit = project._tag === "Some" ? project.value : undefined;
        if (here && explicit !== undefined) {
            fail("ax prompts: pass --here or --project=PATH, not both");
        }
        if (json && tsv) {
            fail("ax prompts: pass --json or --tsv, not both");
        }
        return cmdPrompts({
            query: query._tag === "Some" ? query.value : undefined,
            sinceDays: days,
            limit,
            here,
            project: explicit,
            json,
            tsv,
        });
    },
).pipe(
    Command.withDescription(
        "Reverse search the prompts you typed, across every harness. Browse with no query, " +
        "search with --query=TEXT. --days=N (default 90)  --limit=N (default 40)  " +
        "--here|--project=PATH  --json  --tsv (pipe into fzf)",
    ),
);

export const axPromptsRuntime: RuntimeManifest = {
    prompts: {
        runtime: "cache",
        hidden: false,
    },
};
