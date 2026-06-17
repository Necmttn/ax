import { expect, test } from "bun:test";
import { renderProfileInterviewBrief } from "./interview-brief.ts";

test("brief lists prefilled skills and hooks and the submit command", () => {
    const md = renderProfileInterviewBrief({
        date: "2026-06-17",
        skills: [{ name: "tdd", source: "superpowers" }, { name: "efficient-dispatch", source: "ax" }],
        hooks: ["enforce-worktree", "route-dispatch"],
    });
    expect(md).toContain("tdd (superpowers)");
    expect(md).toContain("enforce-worktree");
    expect(md).toContain("ax profile interview submit");
    expect(md).toContain("2026-06-17");
    // draft-then-confirm interaction is spelled out
    expect(md.toLowerCase()).toContain("confirm");
});

test("brief handles an empty rig gracefully", () => {
    const md = renderProfileInterviewBrief({ date: "2026-06-17", skills: [], hooks: [] });
    expect(md).toContain("ax profile interview submit");
});
