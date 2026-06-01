import { extractTurnReferences } from "../turn-references.ts";
import { dissectTurn, type TurnSpan, type TurnSpanKind } from "../turn-dissect.ts";
import { classifyTurnSectionAliases, TURN_SECTION_ALIAS_VERSION } from "./turn-section-aliases.ts";
import type {
    ContentDocumentInput,
    ContentParser,
    ParsedContentAtom,
    ParsedContentBlock,
    ParsedContentDocument,
    ParserDecision,
} from "./types.ts";

const PARSER_ID = "provider_turn";
const PARSER_VERSION = "turn-blocks-v1";
const REF_CLASSIFIER_VERSION = "turn-refs-v1";

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const MARKDOWN_LINK_RE = /\[([^\]\n]{1,160})\]\((https?:\/\/[^)\s]+)\)/g;
const COMMAND_RE = /`([^`\n]*(?:bun|npm|pnpm|yarn|git|rg|sed|awk|curl|axctl|claude|codex|opencode|cursor)[^`\n]*)`/gi;
const XML_TAG_RE = /<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>/g;

const normalize = (value: string): string => value.trim().toLowerCase();
const excerpt = (value: string): string => value.length <= 500 ? value : value.slice(0, 500);

const stringLabel = (input: ContentDocumentInput, key: string): string | null => {
    const value = input.labels?.[key];
    return typeof value === "string" ? value : null;
};

const defaultKindForInput = (input: ContentDocumentInput): TurnSpanKind => {
    const role = stringLabel(input, "role");
    const messageKind = stringLabel(input, "messageKind");
    if (role === "assistant" || messageKind === "assistant") return "assistant_text";
    if (role === "tool" || role === "tool_result" || messageKind === "tool_result") return "tool_result";
    return "user_input";
};

const isPlainTextSpan = (kind: TurnSpanKind): boolean =>
    kind === "user_input" || kind === "assistant_text" || kind === "tool_result";

type SegmentKind = "heading" | "fenced_code" | "list_item" | "paragraph";

type TextSegment = {
    readonly kind: SegmentKind;
    readonly text: string;
    readonly heading?: string | null;
    readonly startOffset: number;
    readonly endOffset: number;
};

function splitTextSegments(text: string, baseOffset: number): readonly TextSegment[] {
    const segments: TextSegment[] = [];
    const lines = text.split(/(\n)/);
    let lineStart = 0;
    let paragraphStart: number | null = null;
    let paragraph: string[] = [];
    let inFenceStart: number | null = null;
    let fence: string[] = [];

    const flushParagraph = () => {
        if (paragraphStart === null) return;
        const body = paragraph.join("");
        if (body.trim().length > 0) {
            segments.push({
                kind: "paragraph",
                text: body,
                startOffset: baseOffset + paragraphStart,
                endOffset: baseOffset + paragraphStart + body.length,
            });
        }
        paragraphStart = null;
        paragraph = [];
    };

    for (let i = 0; i < lines.length; i += 2) {
        const line = lines[i] ?? "";
        const newline = lines[i + 1] ?? "";
        const fullLine = line + newline;

        if (inFenceStart !== null) {
            fence.push(fullLine);
            if (/^```/.test(line.trim())) {
                const body = fence.join("");
                segments.push({
                    kind: "fenced_code",
                    text: body,
                    startOffset: baseOffset + inFenceStart,
                    endOffset: baseOffset + inFenceStart + body.length,
                });
                inFenceStart = null;
                fence = [];
            }
            lineStart += fullLine.length;
            continue;
        }

        if (/^```/.test(line.trim())) {
            flushParagraph();
            inFenceStart = lineStart;
            fence = [fullLine];
            lineStart += fullLine.length;
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            segments.push({
                kind: "heading",
                text: fullLine,
                heading: heading[2]!.trim(),
                startOffset: baseOffset + lineStart,
                endOffset: baseOffset + lineStart + fullLine.length,
            });
            lineStart += fullLine.length;
            continue;
        }

        if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line)) {
            flushParagraph();
            segments.push({
                kind: "list_item",
                text: fullLine,
                startOffset: baseOffset + lineStart,
                endOffset: baseOffset + lineStart + fullLine.length,
            });
            lineStart += fullLine.length;
            continue;
        }

        if (line.trim().length === 0) {
            flushParagraph();
            lineStart += fullLine.length;
            continue;
        }

        paragraphStart ??= lineStart;
        paragraph.push(fullLine);
        lineStart += fullLine.length;
    }

    if (inFenceStart !== null) {
        const body = fence.join("");
        segments.push({
            kind: "fenced_code",
            text: body,
            startOffset: baseOffset + inFenceStart,
            endOffset: baseOffset + inFenceStart + body.length,
        });
    }
    flushParagraph();
    return segments;
}

const blockKindForSegment = (spanKind: TurnSpanKind, segmentKind: SegmentKind): string => {
    if (segmentKind === "paragraph") return `${spanKind}_paragraph`;
    if (segmentKind === "heading") return `${spanKind}_heading`;
    if (segmentKind === "fenced_code") return `${spanKind}_code`;
    return `${spanKind}_list_item`;
};

function atomsForBlock(block: ParsedContentBlock): ParsedContentAtom[] {
    const text = block.text ?? "";
    const atoms: ParsedContentAtom[] = [];
    const refs = extractTurnReferences(text);

    for (const file of refs.files) {
        atoms.push({
            blockSeq: block.seq,
            kind: "file_ref",
            value: file,
            normalized: file,
            confidence: 0.9,
        });
    }

    for (const symbol of refs.symbols) {
        atoms.push({
            blockSeq: block.seq,
            kind: "symbol_ref",
            value: symbol,
            normalized: symbol,
            confidence: 0.75,
        });
    }

    for (const error of refs.errors) {
        atoms.push({
            blockSeq: block.seq,
            kind: "error_signature",
            value: error,
            normalized: normalize(error),
            confidence: 0.8,
        });
    }

    for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
        atoms.push({
            blockSeq: block.seq,
            kind: "citation_ref",
            value: match[2]!,
            normalized: match[2]!,
            confidence: 0.9,
            raw: { label: match[1] },
        });
    }

    for (const match of text.matchAll(URL_RE)) {
        const value = match[0].replace(/[.,;:]+$/, "");
        atoms.push({
            blockSeq: block.seq,
            kind: "url_ref",
            value,
            normalized: value,
            confidence: 0.85,
        });
    }

    for (const match of text.matchAll(COMMAND_RE)) {
        atoms.push({
            blockSeq: block.seq,
            kind: "command_ref",
            value: match[1]!.trim(),
            normalized: match[1]!.trim(),
            confidence: 0.8,
        });
    }

    for (const match of text.matchAll(XML_TAG_RE)) {
        atoms.push({
            blockSeq: block.seq,
            kind: "xml_tag",
            value: match[1]!,
            normalized: normalize(match[1]!),
            confidence: 0.7,
        });
    }

    if (block.kind === "tool_use" && block.heading) {
        atoms.push({
            blockSeq: block.seq,
            kind: "tool_name",
            value: block.heading,
            normalized: block.heading,
            confidence: 0.95,
        });
    }

    return atoms;
}

function pushSpanBlocks(
    blocks: ParsedContentBlock[],
    span: TurnSpan,
    role: string | null,
): void {
    const parentSeq = blocks.length + 1;
    const spanText = span.text;
    blocks.push({
        kind: span.kind,
        seq: parentSeq,
        role,
        heading: span.label ?? null,
        text: spanText,
        textExcerpt: excerpt(spanText),
        searchText: spanText,
        startOffset: span.startOffset ?? null,
        endOffset: span.endOffset ?? null,
        confidence: 1,
        parser: PARSER_ID,
        labels: { level: "span" },
    });

    if (!isPlainTextSpan(span.kind)) return;
    const baseOffset = span.startOffset ?? 0;
    for (const segment of splitTextSegments(spanText, baseOffset)) {
        if (segment.text.trim() === spanText.trim()) continue;
        blocks.push({
            kind: blockKindForSegment(span.kind, segment.kind),
            seq: blocks.length + 1,
            parentSeq,
            role,
            heading: segment.heading ?? null,
            text: segment.text,
            textExcerpt: excerpt(segment.text),
            searchText: segment.text,
            startOffset: segment.startOffset,
            endOffset: segment.endOffset,
            confidence: 0.95,
            parser: PARSER_ID,
            labels: { level: "segment", segmentKind: segment.kind },
        });
    }
}

export function parseProviderTurn(input: ContentDocumentInput): ParsedContentDocument {
    const role = stringLabel(input, "role");
    const spans = dissectTurn(input.text, { defaultKind: defaultKindForInput(input) });
    const blocks: ParsedContentBlock[] = [];
    for (const span of spans) pushSpanBlocks(blocks, span, role);
    const referenceAtoms = blocks.flatMap(atomsForBlock);
    const sectionAliases = classifyTurnSectionAliases(blocks, referenceAtoms, input);
    const labeledBlocks = blocks.map((block) => {
        const aliasLabels = sectionAliases.blockLabels.get(block.seq);
        if (!aliasLabels) return block;
        return {
            ...block,
            labels: {
                ...(block.labels ?? {}),
                ...aliasLabels,
            },
        };
    });

    return {
        parserId: PARSER_ID,
        parserVersion: PARSER_VERSION,
        classifierVersions: {
            references: REF_CLASSIFIER_VERSION,
            section_aliases: TURN_SECTION_ALIAS_VERSION,
        },
        blocks: labeledBlocks,
        atoms: [...referenceAtoms, ...sectionAliases.atoms],
    };
}

export function decideProviderTurnParser(input: ContentDocumentInput): ParserDecision {
    if (input.sourceKind !== "turn") {
        return { decision: "reject", score: 0, reason: "provider_turn: source is not a turn" };
    }
    if (input.text.trim().length === 0) {
        return { decision: "reject", score: 0, reason: "provider_turn: empty turn text" };
    }
    return { decision: "accept", score: 1, reason: "provider_turn: turn text" };
}

export const providerTurnParser: ContentParser = {
    id: PARSER_ID,
    version: PARSER_VERSION,
    accepts: decideProviderTurnParser,
    parse: parseProviderTurn,
};
