import { describe, expect, test } from "bun:test";
import { OG_RENDER_REV, buildOgImageUrl, ogImageVersion } from "./og-meta";

describe("og-meta", () => {
    test("bare render revision when no manifest text is in hand", () => {
        expect(buildOgImageUrl("Necmttn", "abc123")).toBe(
            `https://ax.necmttn.com/og/Necmttn/abc123?v=${OG_RENDER_REV}`,
        );
    });

    test("manifest text folds a stable 8-hex-char hash into the version", () => {
        const text = '{"kind":"manifest","totals":{"turns":12}}';
        const url = buildOgImageUrl("Necmttn", "abc123", text);
        expect(url).toMatch(
            new RegExp(`^https://ax\\.necmttn\\.com/og/Necmttn/abc123\\?v=${OG_RENDER_REV}-[0-9a-f]{8}$`),
        );
        // Deterministic: the same manifest always yields the same URL.
        expect(buildOgImageUrl("Necmttn", "abc123", text)).toBe(url);
    });

    test("a re-exported share (changed manifest) busts the URL", () => {
        expect(ogImageVersion('{"totals":{"turns":12}}')).not.toBe(
            ogImageVersion('{"totals":{"turns":13}}'),
        );
    });

    test("empty manifest text still versions with a hash, not bare rev", () => {
        expect(ogImageVersion("")).toMatch(new RegExp(`^${OG_RENDER_REV}-[0-9a-f]{8}$`));
    });
});
