import { describe, expect, it } from "bun:test";
import { compareDecision, duelPath, duelXIntent, buildDuelOgImageUrl, DUEL_OG_REV } from "./challenge";

describe("compareDecision", () => {
    it("rejects a bad login", () => {
        expect(compareDecision("ok", "bad handle!").kind).toBe("invalid");
    });
    it("redirects self-compare (case-insensitive) to the plain profile", () => {
        const d = compareDecision("Necmttn", "necmttn");
        expect(d).toEqual({ kind: "redirect", to: "/u/Necmttn" });
    });
    it("overlays two distinct valid logins", () => {
        const d = compareDecision("a", "b");
        expect(d).toEqual({ kind: "overlay", a: "a", b: "b" });
    });
});

describe("url builders", () => {
    it("duelPath", () => {
        expect(duelPath("a", "b")).toBe("/u/a/vs/b");
    });
    it("duelXIntent embeds the lead line and absolute url", () => {
        const url = duelXIntent({ a: "a", b: "b", aLeads: 4, origin: "https://ax.necmttn.com" });
        expect(url).toContain("https://twitter.com/intent/tweet");
        expect(decodeURIComponent(url)).toContain("@a leads @b on 4 of 6 axes");
        expect(decodeURIComponent(url)).toContain("https://ax.necmttn.com/u/a/vs/b");
    });
    it("buildDuelOgImageUrl includes both logins and the render rev", () => {
        const url = buildDuelOgImageUrl("a", "b");
        expect(url).toContain("/og-duel/a/b");
        expect(url).toContain(`r=${DUEL_OG_REV}`);
    });
});
