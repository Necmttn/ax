import { basename } from "node:path";
import { parseFrontmatter } from "./parse-yaml.ts";
import type {
    ParsedContentAtom,
    ParsedContentBlock,
    ParsedContentDocument,
    ParserDecision,
} from "./types.ts";

export interface ContentFixtureInput {
    readonly path: string;
    readonly text: string;
}

export type ParsedBlock = ParsedContentBlock;
export type ParsedAtom = ParsedContentAtom;
export type ParsedContent = ParsedContentDocument & { readonly artifactKind: string };

const PARSER_VERSION = "fixture-scaffold-v1";
const FILE_REF_RE = /(?:^|[\s`("'=])((?:\.{1,2}\/|\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|surql|sql|md|mdx|json|jsonl|yaml|yml|toml|css|scss|html|py|rs|go|java|kt|swift|rb|php|sh|bash|zsh))/g;
const COMMAND_RE = /`((?:bun|npm|pnpm|yarn|git|axctl|tsx|tsc|vitest|cargo|go|python3?)\s+[^`]+)`/g;
const COMMIT_RE = /\b([0-9a-f]{7,40})\b/g;

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scalarValues(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(scalarValues);
    if (value === null || value === undefined) return [];
    if (typeof value === "object") return [];
    return [String(value)];
}

function normalizePath(value: string): string {
    return value.replace(/^`|`$/g, "");
}

function pushFrontmatterBlocks(
    blocks: ParsedContentBlock[],
    atoms: ParsedAtom[],
    rawFrontmatter: string | null,
    frontmatter: Record<string, unknown>,
): void {
    if (!rawFrontmatter) return;
    const seq = blocks.length;
    blocks.push({
        seq,
        kind: "frontmatter",
        heading: "frontmatter",
        text: rawFrontmatter,
        textExcerpt: rawFrontmatter.slice(0, 500),
        searchText: rawFrontmatter,
        confidence: 1,
        parser: "frontmatter",
    });
    for (const [key, value] of Object.entries(frontmatter)) {
        for (const item of scalarValues(value)) {
            atoms.push({
                blockSeq: seq,
                kind: "frontmatter_field",
                value: `${key}: ${item}`,
                normalized: key,
                confidence: 1,
                raw: { key, value: item },
            });
        }
    }
}

function pushSectionBlocks(blocks: ParsedContentBlock[], markdown: string): void {
    const lines = markdown.split(/\r?\n/);
    let heading = "body";
    let section: string[] = [];

    const flush = () => {
        const text = section.join("\n").trim();
        if (!text) return;
        blocks.push({
            seq: blocks.length,
            kind: heading === "body" ? "body" : "section",
            heading,
            text,
            textExcerpt: text.slice(0, 500),
            searchText: text,
            confidence: 0.9,
            parser: "markdown-section",
        });
        section = [];
    };

    for (const line of lines) {
        const h = line.match(/^(#{1,6})\s+(.+)$/);
        if (h) {
            flush();
            heading = h[2]!.trim();
            section.push(line);
            continue;
        }
        section.push(line);
    }
    flush();
}

function extractCommonAtoms(blocks: readonly ParsedBlock[]): ParsedAtom[] {
    const atoms: ParsedAtom[] = [];
    for (const block of blocks) {
        const text = block.text ?? "";
        const checklistMatches = text.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm);
        for (const match of checklistMatches) {
            const checked = match[1]!.toLowerCase() === "x";
            atoms.push({
                blockSeq: block.seq,
                kind: "checklist_item",
                value: match[2]!.trim(),
                normalized: match[2]!.trim().toLowerCase(),
                confidence: 1,
                raw: { checked },
            });
        }

        for (const match of text.matchAll(FILE_REF_RE)) {
            const value = normalizePath(match[1]!);
            atoms.push({
                blockSeq: block.seq,
                kind: "file_ref",
                value,
                normalized: value,
                confidence: 0.9,
            });
        }

        for (const match of text.matchAll(COMMAND_RE)) {
            atoms.push({
                blockSeq: block.seq,
                kind: "command_ref",
                value: match[1]!,
                normalized: match[1]!,
                confidence: 0.85,
            });
        }

        for (const match of text.matchAll(COMMIT_RE)) {
            atoms.push({
                blockSeq: block.seq,
                kind: "commit_ref",
                value: match[1]!,
                normalized: match[1]!,
                confidence: 0.8,
            });
        }
    }
    return atoms;
}

function extractTaggedBlockAtoms(block: ParsedBlock): ParsedAtom[] {
    const atoms: ParsedAtom[] = [];
    const text = block.text ?? "";
    const kindByTag: Record<string, string> = {
        objective: "objective_block",
        task: "task_node",
        verification: "verification_command",
        success_criteria: "success_criterion",
    };
    for (const [tag, kind] of Object.entries(kindByTag)) {
        const re = new RegExp(`<${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
        for (const match of text.matchAll(re)) {
            const value = match[1]!.replace(/^\s+|\s+$/g, "");
            if (!value) continue;
            atoms.push({
                blockSeq: block.seq,
                kind,
                value,
                normalized: value.toLowerCase(),
                confidence: 0.9,
            });
        }
    }
    return atoms;
}

function parseGsd(input: ContentFixtureInput, artifactKind: string): ParsedContent {
    const { frontmatter, rawFrontmatter, body } = parseFrontmatter(input.text);
    const blocks: ParsedContentBlock[] = [];
    const atoms: ParsedAtom[] = [];
    pushFrontmatterBlocks(blocks, atoms, rawFrontmatter, frontmatter);
    pushSectionBlocks(blocks, body);

    atoms.push(...extractCommonAtoms(blocks));
    for (const block of blocks) atoms.push(...extractTaggedBlockAtoms(block));

    for (const block of blocks) {
        const text = block.text ?? "";
        if (/verification/i.test(block.heading ?? "") || /verified|status|score/i.test(text)) {
            atoms.push({
                blockSeq: block.seq,
                kind: "evidence_row",
                value: block.heading ?? "verification",
                normalized: (block.heading ?? "verification").toLowerCase(),
                confidence: 0.65,
            });
        }
    }

    return {
        parserId: "gsd_markdown",
        parserVersion: PARSER_VERSION,
        artifactKind,
        blocks,
        atoms,
    };
}

function parseSkill(input: ContentFixtureInput): ParsedContent {
    const { frontmatter, rawFrontmatter, body } = parseFrontmatter(input.text);
    const blocks: ParsedContentBlock[] = [];
    const atoms: ParsedAtom[] = [];
    pushFrontmatterBlocks(blocks, atoms, rawFrontmatter, frontmatter);
    pushSectionBlocks(blocks, body);

    atoms.push(...extractCommonAtoms(blocks));
    for (const block of blocks) {
        const text = block.text ?? "";
        const trigger = text.match(/\b(?:Use when|Trigger(?:s)?(?: include)?):?\s+(.+)/i);
        if (trigger) {
            atoms.push({
                blockSeq: block.seq,
                kind: "skill_trigger",
                value: trigger[1]!.trim(),
                normalized: trigger[1]!.trim().toLowerCase(),
                confidence: 0.85,
            });
        }
        for (const match of text.matchAll(/\b(?:references|scripts|assets)\/[A-Za-z0-9_.@/-]+/g)) {
            atoms.push({
                blockSeq: block.seq,
                kind: "resource_ref",
                value: match[0],
                normalized: match[0],
                confidence: 0.9,
            });
        }
        const numbered = text.matchAll(/^\s*\d+\.\s+(.+)$/gm);
        for (const match of numbered) {
            atoms.push({
                blockSeq: block.seq,
                kind: "procedure_step",
                value: match[1]!.trim(),
                normalized: match[1]!.trim().toLowerCase(),
                confidence: 0.8,
            });
        }
    }

    return {
        parserId: "skill_markdown",
        parserVersion: PARSER_VERSION,
        artifactKind: "skill",
        blocks,
        atoms,
    };
}

export function decideMarkdownParser(input: ContentFixtureInput): ParserDecision {
    const { frontmatter, body } = parseFrontmatter(input.text);
    const base = basename(input.path);
    const fm = asRecord(frontmatter);
    const text = `${input.path}\n${input.text}`;

    if (base === "SKILL.md" && (typeof fm["name"] === "string" || typeof fm["description"] === "string")) {
        return { decision: "accept", score: 0.98, reason: "skill_markdown: SKILL.md with skill frontmatter" };
    }

    if ("gsd_state_version" in fm || /^# Project State\b/m.test(body)) {
        return { decision: "accept", score: 0.96, reason: "gsd_markdown: GSD state markers" };
    }

    if (/verification/i.test(input.path) && ("verified" in fm || "score" in fm || /required artifacts|observable truths/i.test(body))) {
        return { decision: "accept", score: 0.94, reason: "gsd_markdown: GSD verification markers" };
    }

    if (/(?:^|\n)<(?:objective|tasks|verification)>/i.test(body) || ("files_modified" in fm && "must_haves" in fm)) {
        return { decision: "accept", score: 0.93, reason: "gsd_markdown: GSD plan markers" };
    }

    if (/\.planning\//.test(text) || /docs\/superpowers\/plans/.test(text)) {
        return { decision: "maybe", score: 0.45, reason: "gsd_markdown: planning path without enough structural markers" };
    }

    return { decision: "reject", score: 0, reason: "none: no MVP artifact parser accepted this document" };
}

export function parseAcceptedMarkdown(input: ContentFixtureInput): ParsedContent {
    const decision = decideMarkdownParser(input);
    if (decision.decision !== "accept") {
        throw new Error(`parser rejected ${input.path}: ${decision.reason}`);
    }
    if (decision.reason.startsWith("skill_markdown:")) return parseSkill(input);

    const { frontmatter, body } = parseFrontmatter(input.text);
    if ("gsd_state_version" in frontmatter || /^# Project State\b/m.test(body)) return parseGsd(input, "gsd_state");
    if (/verification/i.test(input.path)) return parseGsd(input, "gsd_verification");
    return parseGsd(input, "gsd_plan");
}
