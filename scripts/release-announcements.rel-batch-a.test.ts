import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const releases = [
    { version: "0.25.0", date: "2026-06-11" },
    { version: "0.30.0", date: "2026-06-15" },
    { version: "0.31.0", date: "2026-06-15" },
    { version: "0.32.0", date: "2026-06-16" },
    { version: "0.33.0", date: "2026-06-17" },
] as const;

const draftMarkers = [
    "Replace this",
    "Release range evidence",
    "If you are an agent",
    "Rewrite this draft",
    "Visual evidence",
    "/releases/assets/example.png",
];

describe("rel-batch-a release announcements", () => {
    for (const release of releases) {
        test(`v${release.version} is a rendered announcement page, not a scaffold`, () => {
            const path = join(process.cwd(), "docs", "releases", `v${release.version}.md`);

            expect(existsSync(path)).toBe(true);

            const markdown = readFileSync(path, "utf8");
            expect(markdown).toContain(`version: "${release.version}"`);
            expect(markdown).toContain(`date: "${release.date}"`);
            expect(markdown).toMatch(/title: "[^"]{12,}"/);
            expect(markdown).toMatch(/summary: "[^"]{40,}"/);
            expect(markdown).toContain("### How we got here");
            expect(markdown).toContain("### What changed");
            expect(markdown).toContain("### Why it matters");
            expect(markdown.length).toBeGreaterThan(1_200);

            for (const marker of draftMarkers) {
                expect(markdown).not.toContain(marker);
            }
        });
    }
});
