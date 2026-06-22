// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { ProcessService } from "@ax/lib/process";
import { prettyPrint } from "@ax/lib/json";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import {
    buildRecallNext,
} from "../../nav/next-links.ts";
import { printNextLinks } from "../next-format.ts";
import { fetchRecall, normalizeRecallParams, resolveRecallSources, type RecallSource, type RecallScope } from "../../dashboard/recall.ts";
import { resolveStudioTarget } from "../../dashboard/serve-instance.ts";
import { resolvePwdRepository } from "../../pwd.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, parseCsvFlag } from "./shared.ts";
import { ALL_CONTENT_CATEGORIES } from "../../ingest/content-type-classify.ts";

const VALID_SOURCES: ReadonlySet<string> = new Set(["turn", "commit", "skill"]);
const VALID_TYPES: ReadonlySet<string> = new Set<string>(ALL_CONTENT_CATEGORIES);

function parseSourcesFlag(raw: string | null): ReadonlyArray<RecallSource> | null {
    if (!raw) return null;
    const parts = parseCsvFlag(raw);
    const invalid = parts.filter((p) => !VALID_SOURCES.has(p));
    if (invalid.length > 0) {
        fail(`axctl recall: unknown source(s): ${invalid.join(", ")}. Valid: turn, commit, skill`);
    }
    return parts as ReadonlyArray<RecallSource>;
}

type ValidateTypesResult =
    | { readonly ok: true; readonly types: ReadonlyArray<string> }
    | { readonly ok: false; readonly invalid: ReadonlyArray<string> };

/**
 * Pure validator for content-type category names. Exported for unit tests
 * because parseTypeFlag calls fail() which exits the process (not throwable).
 */
export function validateTypes(parts: ReadonlyArray<string>): ValidateTypesResult {
    const invalid = parts.filter((p) => !VALID_TYPES.has(p));
    if (invalid.length > 0) return { ok: false, invalid };
    return { ok: true, types: parts };
}

/** Parse --type=csv flag into a validated list of content-type categories. */
export function parseTypeFlag(raw: string | null): ReadonlyArray<string> | null {
    if (!raw) return null;
    const parts = parseCsvFlag(raw);
    if (parts.length === 0) return null;
    const result = validateTypes(parts);
    if (!result.ok) {
        fail(
            `axctl recall: unknown content type(s): ${result.invalid.join(", ")}. ` +
            `Valid: ${ALL_CONTENT_CATEGORIES.join(", ")}`,
        );
    }
    return result.types;
}

interface RecallCliOpts {
    readonly query: string;
    readonly project: string | null;
    readonly skill: string | null;
    readonly since: string | null;
    readonly sources: string | null;
    readonly scopeFlag: string | null;
    readonly type: string | null;
    readonly json: boolean;
}

/**
 * Resolve `--scope` flag + cwd into a RecallScope.
 *
 * Rules:
 *  - `--scope=all`  → { kind: "all" } (no DB lookup)
 *  - `--scope=here` → look up cwd repository; error if not a git repo
 *  - omitted        → auto-detect: try `here`; fall back to `all` silently
 */
const resolveScope = (
    scopeFlag: string | null,
): Effect.Effect<
    RecallScope,
    DbError | import("@ax/lib/process").ProcessError,
    SurrealClient | ProcessService | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        if (scopeFlag === "all") return { kind: "all" } as RecallScope;

        if (scopeFlag === "here" || scopeFlag === null) {
            const resolution = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) => {
                    if (scopeFlag === "here") {
                        // explicit --scope=here outside a git repo → error
                        fail(`axctl recall: --scope=here requires a git repo (cwd=${err.cwd})`);
                    }
                    // auto-detect: not a git repo → silent fall-through to all
                    return Effect.succeed(null as import("../../pwd.ts").PwdResolution | null);
                }),
            );
            if (resolution === null) return { kind: "all" } as RecallScope;
            return {
                kind: "here",
                repositoryKey: resolution.repositoryRecordId.id as string,
            } as RecallScope;
        }

        fail(`axctl recall: unknown --scope value "${scopeFlag}". Valid: here, all`);
    });

/**
 * Resolve a user-supplied filter (project slug, skill name) into the
 * canonical value stored in the DB. Three behaviours:
 *  - exact match → return immediately
 *  - "?" or empty value with TTY → interactive picker (numbered list)
 *  - substring → match against pretty + raw forms; on 0/many, list & exit
 */
async function pickFromList(
    label: string,
    candidates: ReadonlyArray<{ readonly value: string; readonly hint: string }>,
): Promise<string | null> {
    if (!process.stdin.isTTY) {
        fail(`axctl recall: --${label} requires a value (stdin is not a TTY)`);
    }
    if (candidates.length === 0) {
        fail(`no ${label}s found`);
    }
    process.stderr.write(`\nPick a ${label}:\n`);
    candidates.forEach((c, i) => {
        const idx = String(i + 1).padStart(2);
        process.stderr.write(`  ${idx}. ${c.value}  \x1b[2m${c.hint}\x1b[0m\n`);
    });
    process.stderr.write(`\nNumber (or empty to skip): `);
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    const answer = (await rl.question("")).trim();
    rl.close();
    if (!answer) return null;
    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
        fail(`invalid selection: ${answer}`);
    }
    return candidates[n - 1]!.value;
}

const resolveProject = (input: string | null) =>
    Effect.gen(function* () {
        if (input === null) return null;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT project, count() AS c FROM session
             WHERE project IS NOT NONE
             GROUP BY project ORDER BY c DESC LIMIT 200;`,
        );
        const all = (rows?.[0] ?? [])
            .map((r) => ({
                slug: String(r.project ?? ""),
                count: Number(r.c ?? 0),
            }))
            .filter((r) => r.slug.length > 0);
        const trimmed = input.trim();
        if (trimmed === "" || trimmed === "?") {
            return yield* Effect.promise(() =>
                pickFromList(
                    "project",
                    all.slice(0, 30).map((r) => ({
                        value: r.slug,
                        hint: `${prettifyProjectSlug(r.slug)} · ${r.count} sessions`,
                    })),
                ),
            );
        }
        const exact = all.find((r) => r.slug === trimmed);
        if (exact) return exact.slug;
        const lower = trimmed.toLowerCase();
        const matches = all.filter(
            (r) =>
                r.slug.toLowerCase().includes(lower) ||
                prettifyProjectSlug(r.slug).toLowerCase().includes(lower),
        );
        if (matches.length === 1) return matches[0]!.slug;
        if (matches.length === 0) {
            fail(`axctl recall: no project matches "${trimmed}". Try: axctl recall ... --project=?`);
        }
        return yield* Effect.promise(() =>
            pickFromList(
                "project",
                matches.slice(0, 30).map((r) => ({
                    value: r.slug,
                    hint: `${prettifyProjectSlug(r.slug)} · ${r.count} sessions`,
                })),
            ),
        );
    });

const resolveSkill = (input: string | null) =>
    Effect.gen(function* () {
        if (input === null) return null;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT out.name AS name, count() AS c FROM invoked
             WHERE out.name IS NOT NONE
             GROUP BY name ORDER BY c DESC LIMIT 500;`,
        );
        const all = (rows?.[0] ?? [])
            .map((r) => ({ name: String(r.name ?? ""), count: Number(r.c ?? 0) }))
            .filter((r) => r.name.length > 0);
        const trimmed = input.trim();
        if (trimmed === "" || trimmed === "?") {
            return yield* Effect.promise(() =>
                pickFromList(
                    "skill",
                    all.slice(0, 30).map((r) => ({
                        value: r.name,
                        hint: `${r.count} invocations`,
                    })),
                ),
            );
        }
        const exact = all.find((r) => r.name === trimmed);
        if (exact) return exact.name;
        const lower = trimmed.toLowerCase();
        const matches = all.filter((r) => r.name.toLowerCase().includes(lower));
        if (matches.length === 1) return matches[0]!.name;
        if (matches.length === 0) {
            fail(`axctl recall: no skill matches "${trimmed}". Try: axctl recall ... --skill=?`);
        }
        return yield* Effect.promise(() =>
            pickFromList(
                "skill",
                matches.slice(0, 30).map((r) => ({
                    value: r.name,
                    hint: `${r.count} invocations`,
                })),
            ),
        );
    });

const cmdRecall = (opts: RecallCliOpts) =>
    Effect.gen(function* () {
        if (!opts.query.trim()) {
            console.error("axctl recall: missing query");
            process.exit(1);
        }
        const project = yield* resolveProject(opts.project);
        const skill = yield* resolveSkill(opts.skill);
        const sources = parseSourcesFlag(opts.sources);
        const scope = yield* resolveScope(opts.scopeFlag);
        const types = parseTypeFlag(opts.type);
        const result = yield* fetchRecall(normalizeRecallParams({
            q: opts.query,
            project,
            skill,
            since: opts.since,
            ...(sources !== null ? { sources } : {}),
            scope,
            ...(types !== null ? { types } : {}),
        }));
        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const { hits, next } = buildRecallNext(result, {
            requestedSources: resolveRecallSources(sources),
            studio,
        });
        if (opts.json) {
            console.log(prettyPrint({ ...result, hits, next }));
            return;
        }

        const multiSource = (result.commits.length > 0 || result.skills.length > 0);

        // --- turns section ---
        if (result.hits.length === 0 && !multiSource) {
            console.log(`no matches for "${opts.query}"`);
            // Errors-as-teaching: name the broader queries to try next.
            printNextLinks(next);
            return;
        }
        // next: block prints FIRST - placement beats `| head` truncation and
        // `2>&1` stream-folding (see printNextLinks).
        printNextLinks(next);
        if (result.hits.length > 0) {
            if (multiSource) console.log("\n\x1b[1mturns\x1b[0m");
            const more = result.total_count > result.hits.length
                ? ` (showing first ${result.hits.length} of ${result.total_count})`
                : "";
            console.log(`${result.hits.length} match${result.hits.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.hits) {
                const ts = hit.ts ?? "?";
                const proj = hit.project ? prettifyProjectSlug(hit.project) : "?";
                const sid = hit.session_id
                    .replace(/^session:⟨/, "")
                    .replace(/⟩$/, "")
                    .slice(0, 12);
                const role = (hit.role ?? "?").padEnd(9);
                const src = (hit.source ?? "?").padEnd(15);
                console.log(`\n\x1b[2m${ts}  ${src} ${role} ${proj}  ${sid}\x1b[0m`);
                const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                console.log(`  ${snippet}`);
            }
        }

        // --- commits section ---
        if (result.commits.length > 0) {
            console.log(`\n\x1b[1mcommits\x1b[0m`);
            const more = result.total_counts.commit > result.commits.length
                ? ` (showing first ${result.commits.length} of ${result.total_counts.commit})`
                : "";
            console.log(`${result.commits.length} match${result.commits.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.commits) {
                const ts = hit.ts ?? "?";
                const repo = hit.repo ?? "?";
                const sha = hit.sha.slice(0, 8);
                console.log(`\n\x1b[2m${ts}  ${repo}  ${sha}\x1b[0m`);
                const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                console.log(`  ${snippet}`);
            }
        }

        // --- skills section ---
        if (result.skills.length > 0) {
            console.log(`\n\x1b[1mskills\x1b[0m`);
            const more = result.total_counts.skill > result.skills.length
                ? ` (showing first ${result.skills.length} of ${result.total_counts.skill})`
                : "";
            console.log(`${result.skills.length} match${result.skills.length === 1 ? "" : "es"}${more}`);
            for (const hit of result.skills) {
                const desc = hit.description ? `  \x1b[2m${hit.description.slice(0, 80)}\x1b[0m` : "";
                console.log(`  ${hit.name}${desc}`);
                if (hit.snippet && hit.snippet !== hit.name) {
                    const snippet = hit.snippet.replace(/\s+/g, " ").trim();
                    console.log(`    ${snippet}`);
                }
            }
        }
    });

export const recallCommand = Command.make(
    "recall",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        project: Flag.string("project").pipe(Flag.optional),
        skill: Flag.string("skill").pipe(Flag.optional),
        since: Flag.string("since").pipe(Flag.optional),
        sources: Flag.string("sources").pipe(Flag.optional),
        scope: Flag.string("scope").pipe(Flag.optional),
        type: Flag.string("type").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ query, project, skill, since, sources, scope, type, json }) =>
        cmdRecall({
            query: query.join(" "),
            project: Option.getOrNull(project),
            skill: Option.getOrNull(skill),
            since: Option.getOrNull(since),
            sources: Option.getOrNull(sources),
            scopeFlag: Option.getOrNull(scope),
            type: Option.getOrNull(type),
            json,
        }),
).pipe(
    Command.withDescription(
        "Cross-session text search (BM25). --sources=turn,commit,skill chooses record types (default turn). " +
        "--scope=here filters to the current repo (auto-detected); --scope=all overrides. " +
        "--type=<csv> restricts turns to sessions whose tool outputs include the given content-type categories " +
        "(e.g. --type=code,json; valid: json,code,diff,markdown,yaml,config,log,filelist,text,binary,empty,unknown). " +
        "--project=? / --skill=? opens an interactive picker. " +
        "See the ax:extract-workflow skill for narrating workflows behind shipped artifacts. " +
        "Output ends with a `next:` footer of copy-paste follow-up commands (drill into a session, resume it in its harness); --json carries the same links in a `next` field.",
    ),
);

export const recallRuntime: RuntimeManifest = {
    recall: "db",
};
