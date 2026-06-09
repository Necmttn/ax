import { useState } from "react";
import { imageSrc } from "../api.ts";

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Renders the on-disk images referenced by a turn's `[Image: source: …]`
 * markers (resolve `paths` with {@link extractImagePaths} upstream).
 *
 * Each image is served by the local daemon via `GET /api/image?path=…` (the
 * browser can't load `file://` from an http origin). Responsive by default:
 * fits the content column with a bounded height. Clicking toggles an enlarged
 * state (taller cap). When the file is missing - the common case when a shared
 * gist is viewed on another machine - `onError` swaps the broken image for the
 * original text reference, so a missing file never shows a broken-image icon.
 *
 * `expanded` is a controlled-prop escape hatch for tests, mirroring
 * `tool-row`'s old `open` pattern; it defaults to per-image internal state.
 */
export function TurnImages(
    { paths, expanded }: { paths: ReadonlyArray<string>; expanded?: boolean },
) {
    if (paths.length === 0) return null;
    return (
        <div data-testid="turn-images" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0 2px" }}>
            {paths.map((path, i) => <TurnImage key={`${path}-${i}`} path={path} expanded={expanded} />)}
        </div>
    );
}

function TurnImage({ path, expanded: expandedProp }: { path: string; expanded?: boolean }) {
    const [internalExpanded, setInternalExpanded] = useState(false);
    const [failed, setFailed] = useState(false);
    const expanded = expandedProp ?? internalExpanded;

    if (failed) {
        // Missing/unreadable file: fall back to the original text reference so a
        // gist viewed on another machine degrades gracefully (no broken icon).
        return (
            <div
                data-testid="turn-image-fallback"
                style={{
                    font: `11px/1.5 ${mono}`,
                    color: "#8b8398",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                [Image: source: {path}]
            </div>
        );
    }

    return (
        <img
            data-testid="turn-image"
            src={imageSrc(path)}
            alt={path}
            title={expanded ? "Click to shrink" : "Click to enlarge"}
            onClick={() => {
                if (expandedProp === undefined) setInternalExpanded((v) => !v);
            }}
            onError={() => setFailed(true)}
            style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: expanded ? "80vh" : 240,
                width: expanded ? "100%" : "auto",
                objectFit: "contain",
                borderRadius: 6,
                border: "1px solid #d8d6cf",
                cursor: "pointer",
            }}
        />
    );
}
