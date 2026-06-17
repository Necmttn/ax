import { describe, expect, test } from "bun:test";

// Source-grep test: repo-root `bun test` cannot resolve the `~/` alias chain
// this component imports, so we assert against the file's source text rather
// than rendering it (same convention as profile-duel.test.tsx).
const src = await Bun.file(new URL("./profile-dossier.tsx", import.meta.url)).text();

describe("dossier renders highlights inside the Taste section", () => {
    test("references each highlights sub-block", () => {
        expect(src).toContain("highlights");
        expect(src).toContain("In their words");      // taste lede label
        expect(src).toContain("Secret weapons");
        expect(src).toContain("Learn the rig");
        expect(src).toContain("Shipped");
    });
    test("Taste section renders when highlights OR mined patterns exist", () => {
        // guard widened from `p.taste && ...` to also fire on highlights
        expect(src).toMatch(/p\.highlights\s*\|\|\s*\(p\.taste/);
    });
    test("setup links guard the scheme", () => {
        expect(src).toContain("https");        // scheme check present
        expect(src).toContain("noopener");
    });
});
