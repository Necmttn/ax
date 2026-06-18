import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { AxConfig, AxConfigTest } from "@ax/lib/config";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { ProcessServiceTest } from "@ax/lib/process";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import {
    renderSkillSparBrief,
    parseSkillSparBrief,
    isSkillSparBrief,
    resolveSkillSparTask,
    scoreSkillSpar,
    renderSkillSparReport,
    type SkillSparBrief,
    type ResolveSkillSparOpts,
} from "./skill-spar.ts";
import type { SparScore, SparMetrics } from "./spar.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_BRIEF: SkillSparBrief = {
    id: "abc12345-2026-06-16",
    createdAt: "2026-06-16T12:00:00.000Z",
    skill: "my-skill",
    skillDir: "/Users/user/.claude/skills/my-skill",
    originalHash: "deadbeef",
    parentSha: "cafebabe123456",
    baselineSession: "session:abc123",
    worktreeA: ".claude/worktrees/dojo-spar-abc12345-a",
    worktreeB: ".claude/worktrees/dojo-spar-abc12345-b",
    task: "Fix the thing so it works",
    originalSkill: "# My Skill\n\nThis is the original skill content.\n\nWith multiple paragraphs.",
    editedSkill: "",
};

// ---------------------------------------------------------------------------
// render → parse round-trips
// ---------------------------------------------------------------------------

describe("renderSkillSparBrief / parseSkillSparBrief round-trip", () => {
    test("empty editedSkill: all fields round-trip, editedSkill === ''", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        const parsed = parseSkillSparBrief(rendered);

        expect(parsed).not.toBeNull();
        expect(parsed!.id).toBe(BASE_BRIEF.id);
        expect(parsed!.createdAt).toBe(BASE_BRIEF.createdAt);
        expect(parsed!.skill).toBe(BASE_BRIEF.skill);
        expect(parsed!.skillDir).toBe(BASE_BRIEF.skillDir);
        expect(parsed!.originalHash).toBe(BASE_BRIEF.originalHash);
        expect(parsed!.parentSha).toBe(BASE_BRIEF.parentSha);
        expect(parsed!.baselineSession).toBe(BASE_BRIEF.baselineSession);
        expect(parsed!.worktreeA).toBe(BASE_BRIEF.worktreeA);
        expect(parsed!.worktreeB).toBe(BASE_BRIEF.worktreeB);
        expect(parsed!.task).toBe(BASE_BRIEF.task);
        expect(parsed!.originalSkill).toBe(BASE_BRIEF.originalSkill);
        expect(parsed!.editedSkill).toBe("");
    });

    test("filled editedSkill round-trips correctly", () => {
        const brief: SkillSparBrief = {
            ...BASE_BRIEF,
            editedSkill: "# My Skill (v2)\n\nThis is the **edited** skill.\n\n## Usage\n\nUse it better.",
        };
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);

        expect(parsed).not.toBeNull();
        expect(parsed!.editedSkill).toBe(brief.editedSkill);
        // Other fields unaffected
        expect(parsed!.id).toBe(brief.id);
        expect(parsed!.originalSkill).toBe(brief.originalSkill);
    });

    test("multiline task round-trips", () => {
        const brief: SkillSparBrief = {
            ...BASE_BRIEF,
            task: "Step 1: do the first thing\nStep 2: do the second thing\nStep 3: profit",
        };
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);

        expect(parsed).not.toBeNull();
        expect(parsed!.task).toBe(brief.task);
    });

    test("opts.worktreeAAbs and worktreeBAbs appear in commands (quoted), frontmatter stays relative", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF, {
            worktreeAAbs: "/abs/repo/.claude/worktrees/dojo-spar-abc12345-a",
            worktreeBAbs: "/abs/repo/.claude/worktrees/dojo-spar-abc12345-b",
            snapshotPathAbs: "/tmp/ax-spar-abc12345-snapshot.md",
            editedPathAbs: "/tmp/ax-spar-abc12345-edited.md",
        });

        // Absolute paths appear in the worktree commands, shell-quoted
        expect(rendered).toContain(`git worktree add "/abs/repo/.claude/worktrees/dojo-spar-abc12345-a"`);
        expect(rendered).toContain(`git worktree add "/abs/repo/.claude/worktrees/dojo-spar-abc12345-b"`);
        // Snapshot path appears in swap-out command; edited path in swap-in
        expect(rendered).toContain(`cp "/tmp/ax-spar-abc12345-snapshot.md"`);
        expect(rendered).toContain(`cp "/tmp/ax-spar-abc12345-edited.md"`);

        // Frontmatter keeps relative worktree paths
        expect(rendered).toContain(`worktree_a: ${BASE_BRIEF.worktreeA}`);
        expect(rendered).toContain(`worktree_b: ${BASE_BRIEF.worktreeB}`);

        const parsed = parseSkillSparBrief(rendered);
        expect(parsed!.worktreeA).toBe(BASE_BRIEF.worktreeA);
        expect(parsed!.worktreeB).toBe(BASE_BRIEF.worktreeB);
    });

    test("opts absent: fallback placeholder paths render, round-trip still valid", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        expect(rendered).toContain("(snapshot path)");
        expect(rendered).toContain("(edited skill path)");
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.id).toBe(BASE_BRIEF.id);
    });

    // DEFECT 1: a SKILL.md carrying its own code fences must round-trip exactly.
    test("originalSkill containing ```bash/```ts fences and ~~~ runs round-trips exactly", () => {
        const skillWithFences = [
            "# My Skill",
            "",
            "Run this:",
            "",
            "```bash",
            "echo hi",
            "ls -la",
            "```",
            "",
            "And some TS:",
            "",
            "```ts",
            "const x = 1;",
            "```",
            "",
            "A tilde run: ~~~ and a longer one ~~~~~",
            "",
            "Inline ``code`` too.",
        ].join("\n");
        const brief: SkillSparBrief = { ...BASE_BRIEF, originalSkill: skillWithFences };
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.originalSkill).toBe(skillWithFences);
    });

    // DEFECT 1 (edited side): edited skill with fences round-trips exactly too.
    test("editedSkill containing a ```bash fence round-trips exactly", () => {
        const editedWithFence = "# Edited\n\n```bash\nrun --it\n```\n\ndone";
        const brief: SkillSparBrief = { ...BASE_BRIEF, editedSkill: editedWithFence };
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.editedSkill).toBe(editedWithFence);
    });

    // DEFECT 2: swap-in and swap-out must reference DIFFERENT files even when the
    // snapshot path lacks the literal "snapshot" substring.
    test("snapshot path without the word 'snapshot' still yields distinct swap-in/swap-out", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF, {
            snapshotPathAbs: "/tmp/ax-orig-abc.md",
            editedPathAbs: "/tmp/ax-new-abc.md",
        });
        // swap-in copies the EDITED file; swap-out copies the ORIGINAL snapshot.
        expect(rendered).toContain(`cp "/tmp/ax-new-abc.md"`);
        expect(rendered).toContain(`cp "/tmp/ax-orig-abc.md"`);
        // The two cp sources must differ (arm B must NOT run the original skill).
        const cpLines = rendered.split("\n").filter((l) => l.trimStart().startsWith("cp "));
        const sources = cpLines.map((l) => l.split('"')[1]);
        expect(new Set(sources).size).toBeGreaterThan(1);
    });

    // DEFECT 3: a task body with its own `## ` subheading must round-trip whole.
    test("task containing a '## Notes' subheading round-trips whole", () => {
        const taskWithSubheading = [
            "Implement the feature.",
            "",
            "## Notes",
            "",
            "- be careful with edge cases",
            "- keep it small",
        ].join("\n");
        const brief: SkillSparBrief = { ...BASE_BRIEF, task: taskWithSubheading };
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.task).toBe(taskWithSubheading);
    });

    // New: How to run step 0 - operator must write edited skill to editedPath file
    test("## How to run contains step 0 instructing write of edited SKILL.md to editedPath", () => {
        const editedPath = "/tmp/ax-spar-abc12345-edited.md";
        const rendered = renderSkillSparBrief(BASE_BRIEF, {
            editedPathAbs: editedPath,
        });
        expect(rendered).toContain(`Write your edited SKILL.md to \`${editedPath}\``);
        // Step 0 must appear in the How to run section
        const howToIdx = rendered.indexOf("## How to run");
        expect(howToIdx).toBeGreaterThan(-1);
        const howToSection = rendered.slice(howToIdx);
        expect(howToSection).toContain(`Write your edited SKILL.md to \`${editedPath}\``);
    });

    // New: swap-in command block has test -f guard before cp
    test("swap-in command block contains test -f guard before cp", () => {
        const editedPath = "/tmp/ax-spar-abc12345-edited.md";
        const rendered = renderSkillSparBrief(BASE_BRIEF, {
            editedPathAbs: editedPath,
        });
        // The guard line must appear in the rendered output
        expect(rendered).toContain(`test -f "${editedPath}"`);
        // The guard must appear BEFORE the cp line
        const guardIdx = rendered.indexOf(`test -f "${editedPath}"`);
        const cpIdx = rendered.indexOf(`cp "${editedPath}"`);
        expect(guardIdx).toBeGreaterThan(-1);
        expect(cpIdx).toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(cpIdx);
    });

    // New: editedPath in guard and cp must be the same path as the save-target note
    test("editedPath in guard/cp matches the path given in the save-to note (consistency)", () => {
        const editedPath = "/Users/user/.ax/dojo/spar/my-skill-abc123-2026-06-16.skill.edited.md";
        const rendered = renderSkillSparBrief(BASE_BRIEF, {
            editedPathAbs: editedPath,
        });
        // All three occurrences of the path must be identical (guard, cp source, note)
        const occurrences = [...rendered.matchAll(new RegExp(editedPath.replace(/[/.-]/g, "\\$&"), "g"))];
        // At minimum: the note, the guard, and the cp source = 3 occurrences
        expect(occurrences.length).toBeGreaterThanOrEqual(3);
    });

    // New: ## Edited skill heading line is stable (parser untouched)
    test("## Edited skill heading is exactly '## Edited skill' on its own line", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        const lines = rendered.split("\n");
        const headingLine = lines.find((l) => l.startsWith("## Edited skill"));
        expect(headingLine).toBe("## Edited skill");
    });

    // New: parser still works when editedPath note is present below ## Edited skill
    test("parser still extracts editedSkill correctly when draft-area note is present", () => {
        const brief: SkillSparBrief = {
            ...BASE_BRIEF,
            editedSkill: "# My Skill v2\n\nEdited content here.",
        };
        const rendered = renderSkillSparBrief(brief, {
            editedPathAbs: "/tmp/ax-edited.md",
        });
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.editedSkill).toBe(brief.editedSkill);
    });
});

// ---------------------------------------------------------------------------
// isSkillSparBrief
// ---------------------------------------------------------------------------

describe("isSkillSparBrief", () => {
    test("true for a rendered skill brief", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        expect(isSkillSparBrief(rendered)).toBe(true);
    });

    test("false for a code-delta brief (no kind field)", () => {
        // A minimal spar.ts-style brief has no kind: line at all
        const codeDelta = [
            "---",
            "id: ab12cd34-2026-06-13",
            "created_at: 2026-06-13T10:00:00.000Z",
            "parent_sha: ab12cd34",
            "baseline_session: session:base",
            "worktree: .claude/worktrees/dojo-spar-ab12cd34",
            "baseline_is_subagent: false",
            "---",
            "",
            "# Spar: ab12cd34",
        ].join("\n");
        expect(isSkillSparBrief(codeDelta)).toBe(false);
    });

    test("false for non-frontmatter garbage", () => {
        expect(isSkillSparBrief("not a brief at all")).toBe(false);
        expect(isSkillSparBrief("## Task\n\nsome task\n\n## Other")).toBe(false);
        expect(isSkillSparBrief("")).toBe(false);
    });

    test("false for kind: code (not skill)", () => {
        const wrongKind = "---\nid: x\nkind: code\n---\n\n# not a skill spar\n";
        expect(isSkillSparBrief(wrongKind)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// parseSkillSparBrief null guards
// ---------------------------------------------------------------------------

describe("parseSkillSparBrief null guards", () => {
    test("non-frontmatter → null", () => {
        expect(parseSkillSparBrief("not a brief")).toBeNull();
        expect(parseSkillSparBrief("## Task\n\nsome task")).toBeNull();
        expect(parseSkillSparBrief("")).toBeNull();
    });

    test("missing skill_dir → null", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        const withoutField = rendered.replace(/^skill_dir:.*$/m, "");
        expect(parseSkillSparBrief(withoutField)).toBeNull();
    });

    test("missing original_hash → null", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        const withoutField = rendered.replace(/^original_hash:.*$/m, "");
        expect(parseSkillSparBrief(withoutField)).toBeNull();
    });

    test("missing worktree_a → null", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        const withoutField = rendered.replace(/^worktree_a:.*$/m, "");
        expect(parseSkillSparBrief(withoutField)).toBeNull();
    });

    test("frontmatter-only (no fenced blocks) → null", () => {
        const noBlocks = [
            "---",
            "id: abc12345-2026-06-16",
            "created_at: 2026-06-16T12:00:00.000Z",
            "kind: skill",
            "skill: my-skill",
            "skill_dir: /Users/user/.claude/skills/my-skill",
            "original_hash: deadbeef",
            "parent_sha: cafebabe",
            "baseline_session: session:abc",
            "worktree_a: .claude/worktrees/a",
            "worktree_b: .claude/worktrees/b",
            "---",
            "",
        ].join("\n");
        expect(parseSkillSparBrief(noBlocks)).toBeNull();
    });

    test("placeholder editedSkill parses back to empty string", () => {
        const rendered = renderSkillSparBrief(BASE_BRIEF);
        // editedSkill is empty → placeholder written → parses back to ""
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed!.editedSkill).toBe("");
    });
});

// ---------------------------------------------------------------------------
// oneLine guard (CR/LF injection safety)
// ---------------------------------------------------------------------------

describe("oneLine guard: CR/LF in field cannot break frontmatter", () => {
    test("LF in skill name collapsed to space", () => {
        const brief: SkillSparBrief = { ...BASE_BRIEF, skill: "foo\nbar" };
        const rendered = renderSkillSparBrief(brief);

        // The rendered frontmatter must have skill on a single line
        const skillLine = rendered.split("\n").find((l) => l.startsWith("skill: "));
        expect(skillLine).toBeDefined();
        expect(skillLine).toBe("skill: foo bar");

        // Round-trip reads back the sanitized value
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.skill).toBe("foo bar");
    });

    test("CRLF in id collapsed to two spaces", () => {
        const brief: SkillSparBrief = { ...BASE_BRIEF, id: "id-with\r\nnewline" };
        const rendered = renderSkillSparBrief(brief);

        // Both \r and \n become separate spaces → "id-with  newline"
        const idLine = rendered.split("\n").find((l) => l.startsWith("id: "));
        expect(idLine).toBeDefined();
        expect(idLine).toBe("id: id-with  newline");

        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.id).toBe("id-with  newline");
    });

    test("LF in skillDir cannot split the frontmatter line", () => {
        const brief: SkillSparBrief = {
            ...BASE_BRIEF,
            skillDir: "/some/path\n/injected-line",
        };
        const rendered = renderSkillSparBrief(brief);

        // The injected newline is replaced with a space
        const sdLine = rendered.split("\n").find((l) => l.startsWith("skill_dir: "));
        expect(sdLine).toBeDefined();
        expect(sdLine).toBe("skill_dir: /some/path /injected-line");

        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.skillDir).toBe("/some/path /injected-line");
    });
});

// ---------------------------------------------------------------------------
// resolveSkillSparTask - Effect glue tests
// ---------------------------------------------------------------------------

const SKILL_DIR = "/Users/user/.claude/skills/my-skill";
const SKILL_MD_CONTENT = "# My Skill\n\nDo the thing.";

/** Default process mock: HEAD → "headsha123", <sha>^ → "parentsha456". */
const defaultProcMock = ProcessServiceTest({
    route: (cmd, args) => {
        if (cmd === "git") {
            const last = args[args.length - 1] ?? "";
            if (last === "HEAD") return { stdout: "headsha123\n", stderr: "", code: 0 };
            if (last.endsWith("^")) return { stdout: "parentsha456\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "unexpected", code: 1 };
    },
});

const defaultFs = layerTestFileSystem({ [`${SKILL_DIR}/SKILL.md`]: SKILL_MD_CONTENT });

/** Run resolveSkillSparTask and unwrap the result. */
const runResolve = (
    skillName: string,
    opts: ResolveSkillSparOpts | undefined,
    tc: ReturnType<typeof makeTestSurrealClient>,
    proc: Layer.Layer<import("@ax/lib/process").ProcessService> = defaultProcMock,
    fs: Layer.Layer<import("effect").FileSystem.FileSystem> = defaultFs,
    repositoryKey: string | null = null,
) =>
    Effect.runPromise(
        resolveSkillSparTask(skillName, "/repo", repositoryKey, opts).pipe(
            Effect.provide(Layer.mergeAll(tc.layer, proc, fs)),
        ),
    );

/** Run and expect a SparCaptureError with the given message substring. */
const runExpectCaptureFail = async (
    skillName: string,
    opts: ResolveSkillSparOpts | undefined,
    tc: ReturnType<typeof makeTestSurrealClient>,
    msgSubstring: string,
    proc: Layer.Layer<import("@ax/lib/process").ProcessService> = defaultProcMock,
    fs: Layer.Layer<import("effect").FileSystem.FileSystem> = defaultFs,
    repositoryKey: string | null = null,
) => {
    const exit = await Effect.runPromiseExit(
        resolveSkillSparTask(skillName, "/repo", repositoryKey, opts).pipe(
            Effect.provide(Layer.mergeAll(tc.layer, proc, fs)),
        ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
        // Stringify the cause to check message content
        const causeStr = JSON.stringify(exit.cause);
        expect(causeStr).toContain(msgSubstring);
    }
};

describe("resolveSkillSparTask", () => {
    // -----------------------------------------------------------------------
    // Test 1: invoked-only history → resolves to the invoking session
    // -----------------------------------------------------------------------
    test("invoked-only: resolves to the most-recent invoking session", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                // invoked + loaded multi-statement: invoked has one row, loaded is empty
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                // session bulk fetch: source only (first_user_message derived from turn)
                "source FROM": [
                    [{ id: "session:s1", source: "claude" }],
                ],
                // turn text_excerpt for the picked session
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Fix the bug" }]],
            },
        });

        const result = await runResolve("my-skill", undefined, tc);
        expect(result.baselineSession).toBe("session:s1");
        expect(result.task).toBe("Fix the bug");
        expect(result.skill).toBe("my-skill");
        expect(result.skillDir).toBe(SKILL_DIR);
        expect(result.originalSkill).toBe(SKILL_MD_CONTENT);
        expect(result.originalHash).toBeTruthy();
        expect(result.parentSha).toBe("headsha123");
    });

    // -----------------------------------------------------------------------
    // Test 2: loaded-only history → resolves to the loading session
    // -----------------------------------------------------------------------
    test("loaded-only: resolves to the most-recent loading session", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                // invoked empty, loaded has one row
                "FROM invoked WHERE out": [
                    [],
                    [{ sid: "session:s2", ts: "2026-02-05T00:00:00.000Z" }],
                ],
                "source FROM": [
                    [{ id: "session:s2", source: "claude" }],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Do the loaded task" }]],
            },
        });

        const result = await runResolve("my-skill", undefined, tc);
        expect(result.baselineSession).toBe("session:s2");
        expect(result.task).toBe("Do the loaded task");
    });

    // -----------------------------------------------------------------------
    // Test 3: both invoked + loaded → max ts wins
    // -----------------------------------------------------------------------
    test("both invoked + loaded: most-recent edge-ts wins", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                // s1 invoked on Jan 10, s2 loaded on Jan 15 → s2 should win
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [{ sid: "session:s2", ts: "2026-01-15T00:00:00.000Z" }],
                ],
                "source FROM": [
                    [
                        { id: "session:s1", source: "claude" },
                        { id: "session:s2", source: "claude" },
                    ],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Newer task" }]],
            },
        });

        const result = await runResolve("my-skill", undefined, tc);
        expect(result.baselineSession).toBe("session:s2");
        expect(result.task).toBe("Newer task");
    });

    // -----------------------------------------------------------------------
    // Test 4: no history → SparCaptureError
    // -----------------------------------------------------------------------
    test("no invoked/loaded history → SparCaptureError", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [[], []],
            },
        });

        await runExpectCaptureFail("my-skill", undefined, tc, "no sessions found");
    });

    // -----------------------------------------------------------------------
    // Test 5: unknown skill → SparCaptureError
    // -----------------------------------------------------------------------
    test("unknown skill → SparCaptureError", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [[]],
            },
        });

        await runExpectCaptureFail("ghost-skill", undefined, tc, "unknown skill ghost-skill");
    });

    // -----------------------------------------------------------------------
    // Test 6: synthetic skill → SparCaptureError
    // -----------------------------------------------------------------------
    test("synthetic skill → SparCaptureError", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:bash", name: "Bash", dir_path: "(synthetic)" }],
                ],
            },
        });

        await runExpectCaptureFail("Bash", undefined, tc, "synthetic/tool skill");
    });

    // -----------------------------------------------------------------------
    // Test 7: explicit opts.sessionId → uses it directly (no invoked/loaded)
    // -----------------------------------------------------------------------
    test("opts.sessionId: uses specified session directly, skips edge history", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                // Session existence check (no first_user_message - derived from turn)
                "FROM session:": [
                    [{ id: "session:s42" }],
                ],
                // Turn text_excerpt for the explicit session
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Custom task" }]],
            },
        });

        const result = await runResolve("my-skill", { sessionId: "session:s42" }, tc);
        expect(result.baselineSession).toBe("session:s42");
        expect(result.task).toBe("Custom task");

        // The invoked/loaded queries must NOT have been issued
        expect(tc.captured.some((sql) => sql.includes("FROM invoked"))).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Test 8: opts.sha → parentSha is <sha>^
    // -----------------------------------------------------------------------
    test("opts.sha: parentSha resolved as sha^", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                "source FROM": [
                    [{ id: "session:s1", source: "claude" }],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Task text" }]],
            },
        });

        // proc mock that verifies the sha^ call
        const capturedArgs: string[][] = [];
        const shaProcMock = ProcessServiceTest({
            route: (cmd, args) => {
                if (cmd === "git") capturedArgs.push([...args]);
                const last = args[args.length - 1] ?? "";
                if (last.endsWith("^")) return { stdout: "parentsha456\n", stderr: "", code: 0 };
                return { stdout: "headsha123\n", stderr: "", code: 0 };
            },
        });

        const result = await runResolve("my-skill", { sha: "abc1234" }, tc, shaProcMock);
        expect(result.parentSha).toBe("parentsha456");
        // Must have called git rev-parse ... abc1234^
        expect(capturedArgs.some((a) => a.includes("abc1234^"))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Test 9: no opts → parentSha is HEAD
    // -----------------------------------------------------------------------
    test("no opts: parentSha resolved from HEAD", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                "source FROM": [
                    [{ id: "session:s1", source: "claude" }],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "HEAD task" }]],
            },
        });

        const capturedArgs: string[][] = [];
        const headProcMock = ProcessServiceTest({
            route: (cmd, args) => {
                if (cmd === "git") capturedArgs.push([...args]);
                const last = args[args.length - 1] ?? "";
                if (last === "HEAD") return { stdout: "headsha999\n", stderr: "", code: 0 };
                return { stdout: "parentsha\n", stderr: "", code: 0 };
            },
        });

        const result = await runResolve("my-skill", undefined, tc, headProcMock);
        expect(result.parentSha).toBe("headsha999");
        expect(capturedArgs.some((a) => a.includes("HEAD"))).toBe(true);
        // Must NOT have been called with ^
        expect(capturedArgs.some((a) => a.some((arg) => arg.endsWith("^")))).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Test 10: missing SKILL.md → SparCaptureError
    // -----------------------------------------------------------------------
    test("no SKILL.md → SparCaptureError", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
            },
        });

        // Empty FS: no SKILL.md
        const emptyFs = layerTestFileSystem({});
        await runExpectCaptureFail("my-skill", undefined, tc, "no SKILL.md", defaultProcMock, emptyFs);
    });

    // -----------------------------------------------------------------------
    // Test: same session in BOTH invoked + loaded with different ts → max wins
    // -----------------------------------------------------------------------
    test("same session in invoked AND loaded: per-session max-edge-ts wins the pick", async () => {
        // s1 appears in BOTH tables: invoked early (Jan 1), loaded late (Jan 20).
        // s2 appears once (invoked Jan 10). If the cross-table merge keeps the
        // MAX ts for s1 (Jan 20), s1 beats s2; if it wrongly kept s1's invoked
        // ts (Jan 1), s2 (Jan 10) would win. Asserting s1 locks the max merge.
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [
                        { sid: "session:s1", ts: "2026-01-01T00:00:00.000Z" },
                        { sid: "session:s2", ts: "2026-01-10T00:00:00.000Z" },
                    ],
                    [{ sid: "session:s1", ts: "2026-01-20T00:00:00.000Z" }],
                ],
                "source FROM": [
                    [
                        { id: "session:s1", source: "claude" },
                        { id: "session:s2", source: "claude" },
                    ],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Winner via loaded ts" }]],
            },
        });

        const result = await runResolve("my-skill", undefined, tc);
        expect(result.baselineSession).toBe("session:s1");
        expect(result.task).toBe("Winner via loaded ts");
    });

    // -----------------------------------------------------------------------
    // Test: repositoryKey scopes the candidate fetch (record-literal WHERE)
    // -----------------------------------------------------------------------
    test("repositoryKey emits a repository = repository:<key> filter on the session fetch", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                "source FROM": [
                    [{ id: "session:s1", source: "claude" }],
                ],
                "text_excerpt, seq FROM turn WHERE session": [[{ text_excerpt: "Repo task" }]],
            },
        });

        // repositoryKey provided → scoping WHERE clause must be emitted on the bulk-fetch.
        await Effect.runPromise(
            resolveSkillSparTask("my-skill", "/repo", "local__abc").pipe(
                Effect.provide(Layer.mergeAll(tc.layer, defaultProcMock, defaultFs)),
            ),
        );
        const fetchSql = tc.captured.find((s) => s.includes("source FROM"));
        expect(fetchSql).toBeDefined();
        expect(fetchSql).toContain("WHERE repository = repository:`local__abc`");
    });

    // -----------------------------------------------------------------------
    // Test 11: non-claude sessions filtered, remaining none → SparCaptureError
    // -----------------------------------------------------------------------
    test("only non-claude sessions in history → SparCaptureError", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                // source = codex, not claude
                "source FROM": [
                    [{ id: "session:s1", source: "codex" }],
                ],
            },
        });

        await runExpectCaptureFail("my-skill", undefined, tc, "no main (source=claude) sessions");
    });

    // -----------------------------------------------------------------------
    // Task 12: auto-pick session has no first user turn → SparCaptureError
    // -----------------------------------------------------------------------
    test("auto-pick session with no first user turn → SparCaptureError (empty-task guard)", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM invoked WHERE out": [
                    [{ sid: "session:s1", ts: "2026-01-10T00:00:00.000Z" }],
                    [],
                ],
                "source FROM": [
                    [{ id: "session:s1", source: "claude" }],
                ],
                // turn query returns empty: no user turns in this session
                "text_excerpt, seq FROM turn WHERE session": [[]],
            },
        });

        await runExpectCaptureFail("my-skill", undefined, tc, "has no first user message");
    });

    // -----------------------------------------------------------------------
    // Task 13: explicit sessionId with no first user turn → SparCaptureError
    // -----------------------------------------------------------------------
    test("explicit sessionId with no first user turn → SparCaptureError (empty-task guard)", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM skill WHERE name": [
                    [{ id: "skill:myskill", name: "my-skill", dir_path: SKILL_DIR }],
                ],
                "FROM session:": [
                    [{ id: "session:s42" }],
                ],
                // turn query returns empty
                "text_excerpt, seq FROM turn WHERE session": [[]],
            },
        });

        await runExpectCaptureFail("my-skill", { sessionId: "session:s42" }, tc, "has no first user message");
    });
});

// ---------------------------------------------------------------------------
// scoreSkillSpar - Effect glue tests
// ---------------------------------------------------------------------------

describe("scoreSkillSpar", () => {
    // AxConfig is required by fetchSessionMetrics (churn scan reads AxConfig.knobs).
    const configLayer = AxConfigTest({}).pipe(Layer.provide(BunFileSystem.layer));

    const runScore = <A>(
        eff: Effect.Effect<A, unknown, SurrealClient | AxConfig>,
        tcLayer: Layer.Layer<SurrealClient>,
    ): Promise<A> =>
        Effect.runPromise(eff.pipe(Effect.provide(Layer.mergeAll(tcLayer, configLayer))));

    const MAIN_ROOT = "/main/repo";

    // Brief uses relative worktree paths; scoreSkillSpar joins them against MAIN_ROOT.
    const SCORE_BRIEF: SkillSparBrief = {
        ...BASE_BRIEF,
        worktreeA: ".claude/worktrees/spar-arm-a",
        worktreeB: ".claude/worktrees/spar-arm-b",
    };

    // -----------------------------------------------------------------------
    // Test 1: both arm sessions found → known verdict
    // -----------------------------------------------------------------------
    test("both arms present → score returned with known verdict (regression on empty metrics)", async () => {
        // Route by cwd substring: findVariantSession SQL includes the absolute cwd.
        // spar-arm-a / spar-arm-b appear only in those two queries; all other
        // queries fall through to the default [[]] → null/0/false metrics.
        // With empty metrics: variant.landed = false → verdict = "regression".
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "spar-arm-a": [[{ id: "session:arm-a" }]],
                "spar-arm-b": [[{ id: "session:arm-b" }]],
                // stamp SELECT labels → null (will issue UPDATE, but query is OK)
            },
        });

        const result = await runScore(
            scoreSkillSpar(SCORE_BRIEF, MAIN_ROOT, new Date("2026-06-01T00:00:00.000Z")),
            tc.layer,
        );

        expect(result.sessionA).toBe("session:arm-a");
        expect(result.sessionB).toBe("session:arm-b");
        // With all-empty DB responses: both sessions have landed=false.
        // scoreSpar(a, b) with variant.landed=false → verdict = "regression".
        expect(result.score.verdict).toBe("regression");
        expect(result.a).toBeDefined();
        expect(result.b).toBeDefined();

        // Both sessions got stampSparSession calls (SELECT labels + UPDATE each).
        const stampUpdates = tc.captured.filter((s) => s.startsWith("UPDATE"));
        expect(stampUpdates.length).toBeGreaterThanOrEqual(2);
    });

    // -----------------------------------------------------------------------
    // Test 2: arm A session missing → SparCaptureError mentioning "arm A"
    // -----------------------------------------------------------------------
    test("arm A session missing → SparCaptureError mentioning 'arm A'", async () => {
        // No route for spar-arm-a → default [[]] → findVariantSession → null
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "spar-arm-b": [[{ id: "session:arm-b" }]],
            },
        });

        const exit = await Effect.runPromiseExit(
            scoreSkillSpar(SCORE_BRIEF, MAIN_ROOT, new Date()).pipe(
                Effect.provide(Layer.mergeAll(tc.layer, configLayer)),
            ),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain("arm A");
        }
    });

    // -----------------------------------------------------------------------
    // Test 3: arm B session missing → SparCaptureError mentioning "arm B"
    // -----------------------------------------------------------------------
    test("arm B session missing → SparCaptureError mentioning 'arm B'", async () => {
        // Arm A is found; arm B has no route → findVariantSession returns null.
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "spar-arm-a": [[{ id: "session:arm-a" }]],
            },
        });

        const exit = await Effect.runPromiseExit(
            scoreSkillSpar(SCORE_BRIEF, MAIN_ROOT, new Date()).pipe(
                Effect.provide(Layer.mergeAll(tc.layer, configLayer)),
            ),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain("arm B");
        }
    });

    // -----------------------------------------------------------------------
    // Test 4: A=baseline / B=variant wiring is correct (asymmetric → "win")
    // -----------------------------------------------------------------------
    test("A is baseline, B is variant: B cheaper + both landed → 'win' (swap would flip to regression)", async () => {
        // Both arms land; arm B (variant) is clearly cheaper than arm A
        // (baseline). scoreSpar(A, B): deltas.costUsd = 0.8 - 2.0 = -1.2 (past
        // -COST_TOL), no extra repair → "win". A SWAPPED wiring (B baseline /
        // A variant) would give +1.2 → "regression", so this asserts the seam.
        //
        // findVariantSession routes by cwd substring (spar-arm-a / spar-arm-b).
        // The cost + produced queries are shared across both metric fetches;
        // each carries BOTH sessions' rows and the per-call clean-id lookup
        // picks the right one (mirrors spar.test.ts's metric-row idiom).
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "spar-arm-a": [[{ id: "session:arm-a" }]],
                "spar-arm-b": [[{ id: "session:arm-b" }]],
                // cost: arm-a = $2.00 (baseline), arm-b = $0.80 (variant, cheaper)
                "FROM session_token_usage": [[
                    { session: "session:arm-a", model: "claude", estimated_cost_usd: 2.0 },
                    { session: "session:arm-b", model: "claude", estimated_cost_usd: 0.8 },
                ]],
                // both arms produced a commit → landed = true for both
                "FROM produced": [[
                    { session: "session:arm-a", commit: "commit:ca" },
                    { session: "session:arm-b", commit: "commit:cb" },
                ]],
                "FROM touched": [[
                    { commit: "commit:ca", file: "file:f1", path: "src/a.ts", additions: 10, deletions: 2 },
                    { commit: "commit:cb", file: "file:f2", path: "src/b.ts", additions: 10, deletions: 2 },
                ]],
                // turns/wall: shared bare object (symmetric, not the asymmetry axis)
                "AS turn_count": [
                    { turn_count: 15, s: "2026-06-01T00:00:00.000Z", e: "2026-06-01T00:05:00.000Z" },
                ],
            },
        });

        const result = await runScore(
            scoreSkillSpar(SCORE_BRIEF, MAIN_ROOT, new Date("2026-06-01T00:00:00.000Z")),
            tc.layer,
        );

        expect(result.sessionA).toBe("session:arm-a");
        expect(result.sessionB).toBe("session:arm-b");
        // Baseline = arm A ($2.00), variant = arm B ($0.80), both landed.
        expect(result.a.costUsd).toBe(2.0);
        expect(result.b.costUsd).toBe(0.8);
        expect(result.a.landed).toBe(true);
        expect(result.b.landed).toBe(true);
        // scoreSpar(A, B): cheaper variant + landed + no extra repair → win.
        expect(result.score.verdict).toBe("win");
        expect(result.score.baseline.costUsd).toBe(2.0);
        expect(result.score.variant.costUsd).toBe(0.8);
        expect(result.score.deltas.costUsd).toBeCloseTo(-1.2, 5);
    });

    // -----------------------------------------------------------------------
    // Test 5: malformed created_at → SparCaptureError (no RangeError escape)
    // -----------------------------------------------------------------------
    test("malformed created_at → SparCaptureError before any session lookup", async () => {
        const tc = makeTestSurrealClient({ denyWrites: true });
        const badBrief: SkillSparBrief = { ...SCORE_BRIEF, createdAt: "not-a-date" };

        const exit = await Effect.runPromiseExit(
            scoreSkillSpar(badBrief, MAIN_ROOT, new Date()).pipe(
                Effect.provide(Layer.mergeAll(tc.layer, configLayer)),
            ),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain("malformed created_at");
        }
        // Failed before issuing any query (no findVariantSession call).
        expect(tc.captured.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// renderSkillSparReport (pure)
// ---------------------------------------------------------------------------

describe("renderSkillSparReport", () => {
    const metrics = (o: Partial<SparMetrics> = {}): SparMetrics => ({
        costUsd: 1.20,
        turns: 18,
        wallMs: 600_000,
        repairLines: 40,
        episodes: 3,
        landed: true,
        ...o,
    });

    test("header has skill name + id + 'skill edit'; table has 6 metric rows; verdict present", () => {
        const score: SparScore = {
            id: "",
            variantSession: "",
            baseline: metrics(),
            variant: metrics({ costUsd: 0.80, turns: 15, wallMs: 450_000, repairLines: 30, episodes: 2 }),
            deltas: {
                costUsd: -0.40,
                turns: -3,
                wallMs: -150_000,
                repairLines: -10,
                episodes: -1,
            },
            verdict: "win",
        };

        const md = renderSkillSparReport(score, BASE_BRIEF);

        // Header includes the brief id
        expect(md).toContain(`# Skill spar report: ${BASE_BRIEF.id}`);
        // Skill-aware lines
        expect(md).toContain(`skill: ${BASE_BRIEF.skill}`);
        expect(md).toContain("skill edit");
        expect(md).toContain(BASE_BRIEF.originalHash);
        // Table has all 6 metric rows
        expect(md).toContain("| cost |");
        expect(md).toContain("| turns |");
        expect(md).toContain("| wall (ms) |");
        expect(md).toContain("| repair |");
        expect(md).toContain("| episodes |");
        expect(md).toContain("| landed |");
        // Verdict line
        expect(md).toContain("verdict: **WIN**");
    });

    test("regression verdict formats correctly", () => {
        const score: SparScore = {
            id: "",
            variantSession: "",
            baseline: metrics(),
            variant: metrics({ landed: false }),
            deltas: { costUsd: null, turns: null, wallMs: null, repairLines: 0, episodes: 0 },
            verdict: "regression",
        };
        const md = renderSkillSparReport(score, BASE_BRIEF);
        expect(md).toContain("verdict: **REGRESSION**");
        expect(md).toContain("| landed | yes | no |");
    });
});
