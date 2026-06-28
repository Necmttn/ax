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
    test("weapons + skills use native <details> click-toggle for the detail", () => {
        // headline + summary in <summary>, detail revealed on toggle.
        expect(src).toMatch(/<details className="pf-weapon"/);
        expect(src).toMatch(/<summary className="pf-weapon-summary"/);
        expect(src).toContain("pf-weapon-detail");      // the revealed area
        expect(src).toMatch(/<details className="pf-learn-row"/);
        expect(src).toMatch(/<summary className="pf-learn-summary"/);
        expect(src).toContain("pf-toggle");             // disclosure chevron
    });
});

describe("dossier renders guardrail receipts", () => {
    test("Guardrails block reads guardrail_receipts and renders per-hook receipts", () => {
        expect(src).toContain("guardrail_receipts");
        expect(src).toContain("HookReceiptLine");
        expect(src).toContain("pf-hook-receipt");
        expect(src).toContain("still earning");
    });

    test("no_longer_needed verdicts are labeled without claiming the cause", () => {
        expect(src).toContain("resolved or never fired");
    });
});

describe("dossier supports multi-profile radar compare", () => {
    test("the sign section builds a profile list and renders every member archetype", () => {
        expect(src).toContain("compareEntries");
        expect(src).toContain("pf-sign-archetypes");
        expect(src).toContain("archetypeFor(entry.axes, entry.profile)");
    });

    test("the raw-values table accepts N profiles and uses strict raw-value leaders", () => {
        expect(src).toContain("rawValueLeaders");
        expect(src).toMatch(/profiles:\s*readonly/);
        expect(src).toContain("leaderIndexes");
    });

    test("compare load failures are rendered per peer instead of replacing the whole comparison", () => {
        expect(src).toContain("vs.peers");
        expect(src).toContain("pf-sign-peer-status");
        expect(src).toContain("couldn't load");
    });
});
