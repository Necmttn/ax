import { describe, expect, test } from "bun:test";
import type { NavLink } from "@ax/lib/shared/nav-link";
import { printNextLinks, renderNextFooter } from "./next-format.ts";

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

    test("renders url-only links (the Studio deeplink transport)", () => {
        const out = renderNextFooter([
            {
                description: "Open this session in ax Studio",
                url: "http://localhost:1738/sessions/abc",
                ui: { group: "navigate" },
            },
        ]);
        expect(out).toContain("http://localhost:1738/sessions/abc");
        expect(out).toContain("# Open this session in ax Studio");
    });

    test("cmd wins over url when a link carries both", () => {
        const out = renderNextFooter([
            { description: "dual", cmd: "ax sessions show abc", url: "http://x/y" },
        ]);
        expect(out).toContain("ax sessions show abc");
        expect(out).not.toContain("http://x/y");
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

describe("printNextLinks", () => {
    test("writes the block to STDOUT (printed before data, so | head keeps it)", () => {
        const written: string[] = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            printNextLinks([link({ cmd: "codex resume abc" })]);
        } finally {
            process.stdout.write = orig;
        }
        const out = written.join("");
        expect(out).toContain("codex resume abc");
        // No leading blank line - the block opens the output.
        expect(out.startsWith("next:")).toBe(true);
    });

    test("writes nothing when no link has a cmd", () => {
        const written: string[] = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        try {
            printNextLinks([
                { description: "mcp only", call: { tool: "recall", arguments: {} } },
            ]);
        } finally {
            process.stdout.write = orig;
        }
        expect(written).toHaveLength(0);
    });
});
