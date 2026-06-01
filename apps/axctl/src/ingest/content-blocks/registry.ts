import type {
    ContentDocumentInput,
    ContentParser,
    ParserDecision,
} from "./types.ts";

export type ParserSelection = {
    readonly parser: ContentParser;
    readonly decision: ParserDecision;
};

export const selectContentParser = (
    parsers: readonly ContentParser[],
    input: ContentDocumentInput,
): ParserSelection | null => {
    const decisions = parsers
        .map((parser) => ({ parser, decision: parser.accepts(input) }))
        .filter(({ decision }) => decision.decision !== "reject")
        .sort((a, b) => {
            const scoreDelta = b.decision.score - a.decision.score;
            if (scoreDelta !== 0) return scoreDelta;
            return parsers.indexOf(a.parser) - parsers.indexOf(b.parser);
        });

    return decisions[0] ?? null;
};

export const parserFingerprintPart = (
    parser: Pick<ContentParser, "id" | "version">,
): string => `${parser.id}@${parser.version}`;
