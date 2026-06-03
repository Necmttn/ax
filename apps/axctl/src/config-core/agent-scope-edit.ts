import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { writeFileAtomic } from "@ax/lib/atomic-write";
import { parseFrontmatter, readList, setFrontmatterList } from "./frontmatter.ts";
import { ConfigParseError, ScopeTargetError } from "./errors.ts";

/**
 * Write side of skill↔agent scoping, shared by `ax skills scope` and
 * `ax agents scope`. Both edit the SAME surface: the `skills:` frontmatter list
 * in an agent definition file. Splice is text-targeted (see frontmatter.ts), the
 * write is atomic + `.bak`, and the result is validated by re-parsing before the
 * swap commits.
 */

const SKILLS_KEY = "skills";

const dedupeSorted = (xs: readonly string[]): string[] =>
    Array.from(new Set(xs)).sort();

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

/** Apply `mutate` to an agent file's `skills:` list. No-op write when unchanged. */
export const editAgentSkills = (
    agentFile: string,
    mutate: (current: string[]) => string[],
): Effect.Effect<
    { changed: boolean; skills: string[] },
    PlatformError | ScopeTargetError | ConfigParseError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (!(yield* fs.exists(agentFile))) {
            return yield* new ScopeTargetError({ agentFile, reason: "agent file not found" });
        }
        const content = yield* fs.readFileString(agentFile);
        const parsed = parseFrontmatter(content);
        const current = readList(parsed.frontmatter, SKILLS_KEY);
        const next = dedupeSorted(mutate(current));
        if (sameList(dedupeSorted(current), next)) {
            return { changed: false, skills: next };
        }

        const updated = setFrontmatterList(content, SKILLS_KEY, next);
        yield* writeFileAtomic(agentFile, updated, {
            validate: (text) =>
                Effect.gen(function* () {
                    const after = readList(parseFrontmatter(text).frontmatter, SKILLS_KEY);
                    if (!sameList(dedupeSorted(after), next)) {
                        return yield* new ConfigParseError({
                            file: agentFile,
                            reason: "post-write skills list did not round-trip",
                        });
                    }
                }),
        });
        return { changed: true, skills: next };
    });

export const addSkillToAgent = (agentFile: string, skill: string) =>
    editAgentSkills(agentFile, (cur) => [...cur, skill]);

export const removeSkillFromAgent = (agentFile: string, skill: string) =>
    editAgentSkills(agentFile, (cur) => cur.filter((s) => s !== skill));
