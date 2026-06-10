import { describe, expect, test } from "bun:test";
import type { NavLink } from "@ax/lib/shared/nav-link";
import { printNextFooter, renderNextFooter } from "./next-format.ts";

const link = (over: Partial<NavLink>): NavLink => ({
    description: "do thing",
    cmd: "ax sessions show abc",
    ...over,
});

describe("renderNextFooter", () => {
    test("renders cmd links with dim description comments", () => {
        const out = renderNextFooter([
            link({ cmd: "codex resume abc", description: "resume it" }),
        ]);
        expect(out).toContain("next:");
        expect(out).toContain("codex resume abc");
        expect(out).toContain("# resume it");
    });

    test("call-only links are skipped; empty result when none have cmd", () => {
        const out = renderNextFooter([
            { description: "mcp only", call: { tool: "recall", arguments: {} } },
        ]);
        expect(out).toBe("");
    });

    test("sorts by priority desc and caps at 4", () => {
        const links = [1, 2, 3, 4, 5].map((p) =>
            link({ cmd: `cmd-${p}`, ui: { priority: p } }),
        );
        const out = renderNextFooter(links);
        expect(out).toContain("cmd-5");
        expect(out).not.toContain("cmd-1");
        expect(out.indexOf("cmd-5")).toBeLessThan(out.indexOf("cmd-2"));
    });
});

describe("printNextFooter", () => {
    test("writes to stderr (survives stdout | head truncation), not stdout", () => {
        const written: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // @ts-expect-error - test stub narrows the overloaded signature
        process.stderr.write = (chunk: string) => {
            written.push(String(chunk));
            return true;
        };
        try {
            printNextFooter([link({ cmd: "codex resume abc" })]);
        } finally {
            process.stderr.write = orig;
        }
        expect(written.join("")).toContain("codex resume abc");
    });

    test("writes nothing when no link has a cmd", () => {
        const written: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // @ts-expect-error - test stub narrows the overloaded signature
        process.stderr.write = (chunk: string) => {
            written.push(String(chunk));
            return true;
        };
        try {
            printNextFooter([
                { description: "mcp only", call: { tool: "recall", arguments: {} } },
            ]);
        } finally {
            process.stderr.write = orig;
        }
        expect(written).toHaveLength(0);
    });
});
