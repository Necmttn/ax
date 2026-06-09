import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnImages } from "./turn-images.tsx";

const PATH = "/Users/necmttn/CleanShot 2026-06-09 at 10.00.51@2x.png";
const ENCODED = encodeURIComponent(PATH);

describe("TurnImages", () => {
    test("renders an <img> pointing at the daemon /api/image endpoint", () => {
        const html = renderToStaticMarkup(<TurnImages paths={[PATH]} />);
        expect(html).toContain('data-testid="turn-image"');
        // src is the encoded daemon image endpoint (spaces + @ percent-encoded)
        expect(html).toContain(`/api/image?path=${ENCODED}`);
    });

    test("renders one <img> per path, in order", () => {
        const a = "/a/one.png";
        const b = "/b/two.jpg";
        const html = renderToStaticMarkup(<TurnImages paths={[a, b]} />);
        expect(html).toContain(encodeURIComponent(a));
        expect(html).toContain(encodeURIComponent(b));
        expect(html.indexOf(encodeURIComponent(a))).toBeLessThan(
            html.indexOf(encodeURIComponent(b)),
        );
    });

    test("empty paths renders nothing", () => {
        expect(renderToStaticMarkup(<TurnImages paths={[]} />)).toBe("");
    });

    test("fit (default) caps height; expanded grows it", () => {
        const fit = renderToStaticMarkup(<TurnImages paths={[PATH]} expanded={false} />);
        const big = renderToStaticMarkup(<TurnImages paths={[PATH]} expanded={true} />);
        // fit state uses the bounded 240px max-height
        expect(fit).toContain("240px");
        // expanded state lifts the cap to 80vh and goes full content width
        expect(big).toContain("80vh");
        expect(big).not.toContain("240px");
    });
});
