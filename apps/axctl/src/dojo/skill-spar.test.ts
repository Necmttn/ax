import { describe, expect, test } from "bun:test";
import {
    renderSkillSparBrief,
    parseSkillSparBrief,
    isSkillSparBrief,
    type SkillSparBrief,
} from "./skill-spar.ts";

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
