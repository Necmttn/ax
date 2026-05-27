/**
 * Provenance marker parser. Recognizes paired HTML-comment markers
 *   <!--ax:ID-->body<!--/ax:ID-->
 * used by guidance-form experiments grounded in user-owned markdown files
 * (AGENTS.md / CLAUDE.md). Body may span multiple lines and contain any
 * characters except a matching close tag for the same id.
 *
 * The parser is intentionally strict: a missing close tag or a duplicate
 * id is a structural error worth surfacing to the user (via `ax lint`).
 */

export interface InlineMarker {
    readonly id: string;
    readonly body: string;
    readonly openIndex: number;
    readonly closeIndex: number;
}

const OPEN = /<!--ax:([a-z0-9_-]+)-->/g;

export const parseInlineMarkers = (source: string): InlineMarker[] => {
    const markers: InlineMarker[] = [];
    const seen = new Set<string>();
    OPEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OPEN.exec(source)) !== null) {
        const id = match[1]!;
        const openIndex = match.index;
        const bodyStart = openIndex + match[0].length;
        const closeTag = `<!--/ax:${id}-->`;
        const closeIndex = source.indexOf(closeTag, bodyStart);
        if (closeIndex === -1) {
            throw new Error(`marker ${id}: unmatched open tag at offset ${openIndex}`);
        }
        if (seen.has(id)) {
            throw new Error(`marker ${id}: duplicate id within document`);
        }
        seen.add(id);
        markers.push({
            id,
            body: source.slice(bodyStart, closeIndex),
            openIndex,
            closeIndex: closeIndex + closeTag.length,
        });
        OPEN.lastIndex = closeIndex + closeTag.length;
    }
    return markers;
};
