import { expect, test } from "bun:test";
import { renderWorkflowsBrief } from "./workflows-brief-template.ts";

test("renderWorkflowsBrief lists each arc with steps, support, and a fill block", () => {
  const md = renderWorkflowsBrief(
    [{ steps: ["brainstorming", "writing-plans", "subagent-driven-development", "review"], support: 7 }],
    { date: "2026-06-23" },
  );
  expect(md).toContain("# ");                       // header
  expect(md.toLowerCase()).toContain("workflow");
  expect(md).toContain("brainstorming");            // a step
  expect(md).toMatch(/7/);                          // support shown
  expect(md.toLowerCase()).toContain("is_workflow"); // fill block
  expect(md.toLowerCase()).toMatch(/skill_name|landing/);
});

test("renderWorkflowsBrief handles empty arc list", () => {
  const md = renderWorkflowsBrief([], { date: "2026-06-23" });
  expect(typeof md).toBe("string");
  expect(md.length).toBeGreaterThan(0);
});
