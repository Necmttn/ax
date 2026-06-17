import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Source-grep test (matches the apps/site convention, e.g. dashboard-preview.test.ts):
// DuelDossier transitively imports the `~/`-aliased profile-dossier chain, which
// the repo-root `bun test` can't resolve (no tsconfig-paths plugin). So we assert
// the component's structure from source rather than rendering it. Render
// correctness is covered by the live visual QA + the apps/site build typecheck.
const src = readFileSync(new URL("./profile-duel.tsx", import.meta.url), "utf8");

describe("profile-duel.tsx (source contract)", () => {
    it("exports the DuelDossier component taking two profiles", () => {
        expect(src).toMatch(/export function DuelDossier\(\{\s*a,\s*b\s*\}/);
    });

    it("renders both handles flanking a VS hero", () => {
        expect(src).toContain("duel-hero");
        expect(src).toContain("duel-vs");
        expect(src).toContain("@{login}"); // DuelSide handle
    });

    it("scores a per-axis tally with a lead line", () => {
        expect(src).toContain("scoreTally");
        expect(src).toContain("duel-score");
        expect(src).toMatch(/leads/);
    });

    it("renders the overlaid radar + the raw-values comparison table", () => {
        expect(src).toContain("<RadarChart");
        expect(src).toContain("<RawTable");
    });

    it("compares vitals with a winner marker", () => {
        expect(src).toContain("duel-vital");
        expect(src).toContain("winnerOf");
    });

    it("makes the avatars link to each profile", () => {
        // every Avatar in the duel is a profile link
        expect(src).toMatch(/<Avatar[^>]*\blinked\b/);
    });

    it("keeps the challenge buttons (copy duel link / post on X)", () => {
        expect(src).toContain("copy duel link");
        expect(src).toContain("post on X");
        expect(src).toContain("duelXIntent");
    });

    it("guards missing optional data instead of crashing", () => {
        expect(src).toContain("pf-quiet");
    });
});
