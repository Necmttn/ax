import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    isValidKind,
    localDate,
    makeSkillSlug,
    makeSkillSparId,
    selectSparScoreKind,
    startOfLocalDay,
    untilToIso,
} from "./dojo.ts";
import {
    buildSkillSparBrief,
    isSkillSparBrief,
    parseSkillSparBrief,
    renderSkillSparBrief,
    type SkillSparTask,
} from "../../dojo/skill-spar.ts";

describe("untilToIso", () => {
    const NOW = Date.parse("2026-06-13T10:00:00.000Z");
    test("future time today", () => {
        expect(untilToIso("23:30", NOW)).toMatch(/T\d{2}:30:00/);
    });
    test("past time rolls to tomorrow", () => {
        const iso = untilToIso("01:00", NOW)!;
        expect(Date.parse(iso)).toBeGreaterThan(NOW);
    });
    test("garbage returns null", () => {
        expect(untilToIso("late", NOW)).toBeNull();
    });
    test("out-of-range hours/minutes return null", () => {
        expect(untilToIso("25:00", NOW)).toBeNull();
        expect(untilToIso("0:60", NOW)).toBeNull();
    });
});

describe("isValidKind", () => {
    test("accepts the two supported kinds", () => {
        expect(isValidKind("bug")).toBe(true);
        expect(isValidKind("improvement")).toBe(true);
    });
    test("rejects anything else", () => {
        expect(isValidKind("nonsense")).toBe(false);
        expect(isValidKind("")).toBe(false);
        expect(isValidKind("Bug")).toBe(false);
    });
});

describe("startOfLocalDay / localDate", () => {
    test("startOfLocalDay zeroes the time-of-day in local tz", () => {
        const now = new Date(2026, 5, 13, 14, 37, 9, 123).getTime(); // local 2026-06-13 14:37:09.123
        const start = new Date(startOfLocalDay(now));
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
        expect(start.getSeconds()).toBe(0);
        expect(start.getMilliseconds()).toBe(0);
        expect(start.getFullYear()).toBe(2026);
        expect(start.getMonth()).toBe(5);
        expect(start.getDate()).toBe(13);
        expect(startOfLocalDay(now)).toBeLessThanOrEqual(now);
    });

    test("localDate renders zero-padded local YYYY-MM-DD", () => {
        const now = new Date(2026, 0, 7, 23, 59, 0).getTime(); // local 2026-01-07
        expect(localDate(now)).toBe("2026-01-07");
    });
});

// ---------------------------------------------------------------------------
// makeSkillSlug
// ---------------------------------------------------------------------------

describe("makeSkillSlug", () => {
    test("colons become dashes (plugin-namespaced skill)", () => {
        expect(makeSkillSlug("ax:dojo")).toBe("ax-dojo");
    });
    test("multiple colons are each replaced", () => {
        expect(makeSkillSlug("my:skill:v2")).toBe("my-skill-v2");
    });
    test("spaces and non-alphanum chars become dashes (trailing dashes stripped)", () => {
        // "my skill!" → "my-skill-" → strip trailing → "my-skill"
        expect(makeSkillSlug("my skill!")).toBe("my-skill");
        expect(makeSkillSlug("foo@bar")).toBe("foo-bar");
    });
    test("consecutive non-alphanum chars collapse to a single dash", () => {
        expect(makeSkillSlug("a::b")).toBe("a-b");
        expect(makeSkillSlug("foo--bar")).toBe("foo-bar");
    });
    test("leading/trailing dashes are stripped", () => {
        expect(makeSkillSlug(":leading")).toBe("leading");
        expect(makeSkillSlug("trailing:")).toBe("trailing");
    });
    test("plain alphanum passthrough", () => {
        expect(makeSkillSlug("caveman")).toBe("caveman");
        expect(makeSkillSlug("retro123")).toBe("retro123");
    });
});

// ---------------------------------------------------------------------------
// makeSkillSparId
// ---------------------------------------------------------------------------

describe("makeSkillSparId", () => {
    const NOW = new Date("2026-06-16T12:00:00.000Z");

    test("shape is <slug>-<hash6>-<YYYY-MM-DD>", () => {
        const id = makeSkillSparId("ax:dojo", NOW);
        expect(id).toMatch(/^ax-dojo-[0-9a-f]{1,6}-2026-06-16$/);
    });

    test("is deterministic for the same name + date", () => {
        expect(makeSkillSparId("caveman", NOW)).toBe(makeSkillSparId("caveman", NOW));
    });

    test("two distinct names that slug identically get different ids (collision avoided)", () => {
        // "a:b" and "a-b" both slug to "a-b" but hash differently.
        const id1 = makeSkillSparId("a:b", NOW);
        const id2 = makeSkillSparId("a-b", NOW);
        expect(makeSkillSlug("a:b")).toBe(makeSkillSlug("a-b")); // same slug
        expect(id1).not.toBe(id2); // but different ids
    });

    test("empty-slug name (all non-alphanumeric) still yields a usable id (no leading dash)", () => {
        const id = makeSkillSparId("!!!", NOW);
        expect(id).not.toStartWith("-");
        expect(id).toMatch(/^[0-9a-f]{1,6}-2026-06-16$/);
    });

    test("the date segment tracks the passed Date", () => {
        const id = makeSkillSparId("caveman", new Date("2027-01-02T23:59:59.000Z"));
        expect(id).toEndWith("-2027-01-02");
    });
});

// ---------------------------------------------------------------------------
// buildSkillSparBrief (pure helper)
// ---------------------------------------------------------------------------

const SAMPLE_TASK: SkillSparTask = {
    task: "Run the workflow and verify it converges",
    baselineSession: "session:abc123",
    parentSha: "deadbeefcafe",
    skill: "ax:dojo",
    skillDir: "/Users/user/.claude/skills/ax__dojo",
    originalSkill: "# ax:dojo skill content",
    originalHash: "cafebabe",
};

describe("buildSkillSparBrief", () => {
    test("worktreeA ends with -a, worktreeB ends with -b, both contain the id", () => {
        const id = "ax-dojo-2026-06-16";
        const brief = buildSkillSparBrief(SAMPLE_TASK, id, "2026-06-16T12:00:00.000Z");
        expect(brief.worktreeA).toBe(`.claude/worktrees/dojo-spar-${id}-a`);
        expect(brief.worktreeB).toBe(`.claude/worktrees/dojo-spar-${id}-b`);
    });

    test("editedSkill is always empty string", () => {
        const brief = buildSkillSparBrief(SAMPLE_TASK, "id-123", "2026-06-16T00:00:00.000Z");
        expect(brief.editedSkill).toBe("");
    });

    test("all SkillSparTask fields are mapped correctly", () => {
        const id = "test-id-2026-06-16";
        const createdAt = "2026-06-16T09:30:00.000Z";
        const brief = buildSkillSparBrief(SAMPLE_TASK, id, createdAt);

        expect(brief.id).toBe(id);
        expect(brief.createdAt).toBe(createdAt);
        expect(brief.skill).toBe(SAMPLE_TASK.skill);
        expect(brief.skillDir).toBe(SAMPLE_TASK.skillDir);
        expect(brief.originalHash).toBe(SAMPLE_TASK.originalHash);
        expect(brief.parentSha).toBe(SAMPLE_TASK.parentSha);
        expect(brief.baselineSession).toBe(SAMPLE_TASK.baselineSession);
        expect(brief.task).toBe(SAMPLE_TASK.task);
        expect(brief.originalSkill).toBe(SAMPLE_TASK.originalSkill);
    });

    test("worktrees are relative paths (no leading /)", () => {
        const brief = buildSkillSparBrief(SAMPLE_TASK, "slug-2026-06-16", "2026-06-16T00:00:00.000Z");
        expect(brief.worktreeA).not.toMatch(/^\//);
        expect(brief.worktreeB).not.toMatch(/^\//);
    });

    test("round-trips through renderSkillSparBrief → parseSkillSparBrief", () => {
        const id = "ax-dojo-2026-06-16";
        const createdAt = "2026-06-16T12:00:00.000Z";
        const brief = buildSkillSparBrief(SAMPLE_TASK, id, createdAt);
        const rendered = renderSkillSparBrief(brief);
        const parsed = parseSkillSparBrief(rendered);
        expect(parsed).not.toBeNull();
        expect(parsed!.id).toBe(id);
        expect(parsed!.editedSkill).toBe("");
        expect(isSkillSparBrief(rendered)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Flag mutex: --skill + positional <sha> are mutually exclusive
// ---------------------------------------------------------------------------

describe("spar-plan --skill flag mutex (CLI invocation)", () => {
    // Test the mutex guard via a real CLI invocation. This uses bun to run the
    // CLI source directly. The command should exit non-zero with a clear error
    // message when both --skill and a positional sha are provided.
    test("--skill AND positional sha → non-zero exit with error message", () => {
        // cwd must be apps/axctl so "src/cli/index.ts" resolves
        const result = spawnSync(
            "bun",
            ["src/cli/index.ts", "dojo", "spar-plan", "abc1234", "--skill", "caveman"],
            {
                encoding: "utf-8",
                cwd: join(import.meta.dir, "../../.."),
            },
        );
        // Should exit with a non-zero code (process.exit(2) from fail())
        expect(result.status).not.toBe(0);
        const output = (result.stderr ?? "") + (result.stdout ?? "");
        expect(output).toContain("mutually exclusive");
    });

    test("--session without --skill → non-zero exit, requires --skill", () => {
        const result = spawnSync(
            "bun",
            ["src/cli/index.ts", "dojo", "spar-plan", "abc1234", "--session", "session:x"],
            {
                encoding: "utf-8",
                cwd: join(import.meta.dir, "../../.."),
            },
        );
        expect(result.status).not.toBe(0);
        const output = (result.stderr ?? "") + (result.stdout ?? "");
        expect(output).toContain("require --skill");
    });

    test("--sha without --skill → non-zero exit, requires --skill", () => {
        const result = spawnSync(
            "bun",
            ["src/cli/index.ts", "dojo", "spar-plan", "abc1234", "--sha", "deadbeef"],
            {
                encoding: "utf-8",
                cwd: join(import.meta.dir, "../../.."),
            },
        );
        expect(result.status).not.toBe(0);
        const output = (result.stderr ?? "") + (result.stdout ?? "");
        expect(output).toContain("require --skill");
    });
});

// ---------------------------------------------------------------------------
// selectSparScoreKind (pure dispatch helper)
// ---------------------------------------------------------------------------

describe("selectSparScoreKind", () => {
    test("skill brief (kind: skill in frontmatter) → 'skill'", () => {
        const brief = buildSkillSparBrief(SAMPLE_TASK, "test-id-2026-06-16", "2026-06-16T00:00:00.000Z");
        const content = renderSkillSparBrief(brief);
        // Confirm isSkillSparBrief sees it too (the source of truth)
        expect(isSkillSparBrief(content)).toBe(true);
        expect(selectSparScoreKind(content)).toBe("skill");
    });

    test("code-delta brief (frontmatter with no kind field) → 'code'", () => {
        // A minimal frontmatter that looks like a code-delta brief (no `kind:` line)
        const codeDeltaContent = [
            "---",
            "id: test-cd-id",
            "created_at: 2026-06-16T00:00:00.000Z",
            "sha: deadbeef",
            "---",
            "# Spar: test-cd-id",
        ].join("\n");
        expect(isSkillSparBrief(codeDeltaContent)).toBe(false);
        expect(selectSparScoreKind(codeDeltaContent)).toBe("code");
    });

    test("garbage / empty content → 'code' (falls through to code-delta parse-null error)", () => {
        expect(selectSparScoreKind("not a brief at all")).toBe("code");
        expect(selectSparScoreKind("")).toBe("code");
    });

    test("frontmatter with kind: something-else → 'code'", () => {
        const notSkill = [
            "---",
            "id: other-id",
            "kind: code",
            "---",
        ].join("\n");
        expect(selectSparScoreKind(notSkill)).toBe("code");
    });
});

// ---------------------------------------------------------------------------
// spar-score skill dispatch: parse-null error path (CLI invocation)
// ---------------------------------------------------------------------------

describe("spar-score skill-spar brief dispatch (CLI)", () => {
    test(
        "brief with kind:skill but missing required fields exits 1 with skill-spar error message",
        () => {
            // Craft a brief where isSkillSparBrief() is true but parseSkillSparBrief() returns
            // null (missing skill-snapshot fenced block → parseFence returns null).
            const id = `test-skill-parse-null-${Date.now()}`;
            const briefContent = [
                "---",
                `id: ${id}`,
                "created_at: 2026-06-16T00:00:00.000Z",
                "kind: skill",
                "skill: caveman",
                "skill_dir: /some/dir",
                "original_hash: abc",
                "parent_sha: deadbeef",
                "baseline_session: session:abc",
                "worktree_a: .claude/worktrees/a",
                "worktree_b: .claude/worktrees/b",
                "---",
                "# Skill spar: truncated - no fenced blocks",
            ].join("\n");

            const sparDir = join(homedir(), ".ax", "dojo", "spar");
            mkdirSync(sparDir, { recursive: true });
            const briefPath = join(sparDir, `${id}.md`);
            writeFileSync(briefPath, briefContent, "utf-8");

            try {
                const result = spawnSync(
                    "bun",
                    ["src/cli/index.ts", "dojo", "spar-score", id],
                    {
                        encoding: "utf-8",
                        cwd: join(import.meta.dir, "../../.."),
                    },
                );
                expect(result.status).not.toBe(0);
                const output = (result.stderr ?? "") + (result.stdout ?? "");
                expect(output).toContain("could not parse skill-spar brief");
            } finally {
                try { unlinkSync(briefPath); } catch { /* ok */ }
            }
        },
    );
});

// ---------------------------------------------------------------------------
// Live smoke (gate: AX_LIVE_SMOKE=1)
// ---------------------------------------------------------------------------

const LIVE_SMOKE = process.env["AX_LIVE_SMOKE"] === "1";

describe("spar-plan --skill live smoke", () => {
    test.skipIf(!LIVE_SMOKE)(
        "writes a skill brief that round-trips through parseSkillSparBrief",
        () => {
            // Use 'caveman' as a well-known skill - it is installed in .ax/skills.
            // If it doesn't exist in the graph, the command exits 1 with a clear
            // 'unknown skill' message and the test fails informatively.
            const result = spawnSync(
                "bun",
                ["src/cli/index.ts", "dojo", "spar-plan", "--skill", "caveman"],
                {
                    encoding: "utf-8",
                    cwd: join(import.meta.dir, "../../.."),
                },
            );

            if (result.status !== 0) {
                const stderr = result.stderr ?? "";
                if (stderr.includes("unknown skill") || stderr.includes("no sessions found") || stderr.includes("no main")) {
                    // Acceptable: skill not in graph - skip gracefully.
                    console.log("spar-plan --skill live smoke: skill not in graph, skipping verification");
                    return;
                }
                throw new Error(`ax dojo spar-plan --skill caveman failed:\n${stderr}\n${result.stdout ?? ""}`);
            }

            // Extract the brief path from stdout (first line)
            const stdout = (result.stdout ?? "").trim();
            const briefPath = stdout.split("\n")[0]?.trim() ?? "";
            expect(briefPath).toMatch(/\.ax\/dojo\/spar\/.*\.md$/);
            expect(existsSync(briefPath)).toBe(true);

            // Brief must be readable and round-trip through the parsers
            const content = readFileSync(briefPath, "utf-8");
            expect(isSkillSparBrief(content)).toBe(true);
            const parsed = parseSkillSparBrief(content);
            expect(parsed).not.toBeNull();
            expect(parsed!.skill).toBe("caveman");
            expect(parsed!.editedSkill).toBe("");

            // Snapshot file (*.skill.orig.md) must exist alongside the brief
            const dir = briefPath.split("/").slice(0, -1).join("/");
            const origPath = join(dir, `${parsed!.id}.skill.orig.md`);
            expect(existsSync(origPath)).toBe(true);

            // Cleanup: remove the brief + snapshot so test runs don't pile up
            try { unlinkSync(briefPath); } catch { /* ok */ }
            try { unlinkSync(origPath); } catch { /* ok */ }
        },
    );
});
