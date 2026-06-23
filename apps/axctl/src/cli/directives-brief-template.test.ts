import { expect, test } from "bun:test";
import { renderDirectivesBrief } from "./directives-brief-template.ts";

test("renderDirectivesBrief lists each candidate with marker, lift, clickable source, and a fill block", () => {
  const md = renderDirectivesBrief(
    [
      { turnKey: "t1", sessionId: "sess-abc", text: "remember to dogfood before showing me", pattern: "remember to", ts: "2026-06-01T00:00:00Z", score: 8.5, source: "lift" },
      { turnKey: "t2", sessionId: "sess-def", text: "always wrap copy in code blocks", pattern: "always-verb", ts: "2026-06-02T00:00:00Z", score: 0, source: "seed" },
    ],
    { date: "2026-06-22", days: 90 },
  );
  expect(md).toContain("# "); // a header
  expect(md.toLowerCase()).toContain("directive"); // names the task
  expect(md).toContain("remember to dogfood before showing me"); // candidate text
  expect(md).toContain("sess-abc"); // clickable source session
  expect(md).toMatch(/lift|score/i); // shows the lift/score signal
  // a per-candidate fill block with the decision fields
  expect(md.toLowerCase()).toContain("is_directive");
  expect(md.toLowerCase()).toMatch(/landing/);
  expect(md.toLowerCase()).toMatch(/memory|guidance|hook/);
});

test("renderDirectivesBrief handles empty candidate list without crashing", () => {
  const md = renderDirectivesBrief([], { date: "2026-06-22", days: 90 });
  expect(typeof md).toBe("string");
  expect(md.length).toBeGreaterThan(0);
});
