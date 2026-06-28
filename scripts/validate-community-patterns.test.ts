import { afterEach, describe, expect, test } from "bun:test";
import { validatePatternFiles } from "./validate-community-patterns.ts";

const dir = `/tmp/ax-community-patterns-${process.pid}`;
const base = `${dir}/base`;
const head = `${dir}/head`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const write = async (root: string, path: string, content: unknown): Promise<string> => {
    const full = `${root}/${path}`;
    await Bun.write(full, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    return full;
};

const validPattern = {
    category: "workflow",
    name: "small-review-loops",
    summary: "Review the diff in small increments before expanding scope.",
    evidence: { sessions: 4, confidence: 0.8, last_reinforced: "2026-06-20", trend: "stable" },
};

describe("validatePatternFiles", () => {
    test("accepts a valid new community pattern file", async () => {
        const path = await write(head, "community/patterns/workflow/small-review-loops.json", validPattern);

        expect(await validatePatternFiles({ files: [path], baseDir: base, headDir: head })).toEqual([]);
    });

    test("rejects unknown categories and missing evidence through the taste-pattern schema", async () => {
        const path = await write(head, "community/patterns/process/no-evidence.json", {
            category: "process",
            name: "no-evidence",
            summary: "missing evidence",
        });

        const errors = await validatePatternFiles({ files: [path], baseDir: base, headDir: head });

        expect(errors.some((e) => e.includes("unknown category"))).toBe(true);
        expect(errors.some((e) => e.includes("invalid taste pattern"))).toBe(true);
    });

    test("rejects files whose category/name fields do not match their path", async () => {
        const path = await write(head, "community/patterns/workflow/small-review-loops.json", {
            ...validPattern,
            name: "big-review-loops",
        });

        const errors = await validatePatternFiles({ files: [path], baseDir: base, headDir: head });

        expect(errors.some((e) => e.includes("name must match filename"))).toBe(true);
    });

    test("rejects a contribution that modifies an existing pattern path", async () => {
        await write(base, "community/patterns/workflow/small-review-loops.json", validPattern);
        const path = await write(head, "community/patterns/workflow/small-review-loops.json", {
            ...validPattern,
            summary: "changed",
        });

        const errors = await validatePatternFiles({ files: [path], baseDir: base, headDir: head });

        expect(errors.some((e) => e.includes("already exists"))).toBe(true);
    });
});
