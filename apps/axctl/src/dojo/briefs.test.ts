// apps/axctl/src/dojo/briefs.test.ts
import { describe, expect, test } from "bun:test";
import { classifyBriefFile } from "./briefs.ts";

describe("classifyBriefFile", () => {
    test("classify brief without primary_role is an unfilled item", () => {
        const item = classifyBriefFile("classify-superpowers__tdd.md", "---\nax_classify: superpowers:tdd\nprimary_role:\n---\n");
        expect(item).not.toBeNull();
        expect(item?.kind).toBe("brief_unfilled");
        expect(item?.id).toBe("brief:classify-superpowers__tdd.md");
        expect(item?.commands).toEqual([
            "$EDITOR .ax/tasks/classify-superpowers__tdd.md  # fill primary_role + rationale",
            "ax skills lint",
        ]);
    });

    test("classify brief WITH primary_role filled returns null (nothing to do)", () => {
        const item = classifyBriefFile(
            "classify-superpowers__tdd.md",
            "---\nax_classify: superpowers:tdd\nprimary_role: verifier\n---\n",
        );
        expect(item).toBeNull();
    });

    test("routing-tune brief is an open routing_backtest item", () => {
        const item = classifyBriefFile("routing-tune-2026-06-10.md", "| id | pattern |\n");
        expect(item?.kind).toBe("routing_backtest");
        expect(item?.commands).toContain("ax routing tune --apply=<ids from brief> --days=30");
    });

    test("improve accept brief is an unfilled item pointing at improve lint", () => {
        const item = classifyBriefFile("a1b2c3d4.md", "---\nax_id: a1b2c3d4\n---\n");
        expect(item?.kind).toBe("brief_unfilled");
        expect(item?.commands).toEqual([
            "$EDITOR .ax/tasks/a1b2c3d4.md  # act on the brief in the target files",
            "ax improve lint",
        ]);
    });

    test("non-markdown files return null", () => {
        expect(classifyBriefFile(".DS_Store", "")).toBeNull();
    });
});
