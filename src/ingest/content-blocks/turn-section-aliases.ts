import type { ContentDocumentInput, ParsedContentAtom, ParsedContentBlock } from "./types.ts";

export const TURN_SECTION_ALIAS_VERSION = "turn-section-aliases-v1";

export type TurnSectionAlias =
    | "objective"
    | "budget"
    | "continuation_behavior"
    | "completion_audit"
    | "progress_visibility"
    | "work_from_evidence"
    | "environment_context"
    | "permissions"
    | "agent_guidance"
    | "skills_manifest"
    | "apps_manifest"
    | "plugins_manifest"
    | "tool_call"
    | "tool_output"
    | "plan"
    | "todo"
    | "verification"
    | "reference";

export type TurnSectionAliasMethod =
    | "block-kind"
    | "block-heading"
    | "label-prefix"
    | "xml-tag"
    | "atom-kind"
    | "inherited";

export type TurnSectionAliasDefinition = {
    readonly alias: TurnSectionAlias;
    readonly display: string;
    readonly boundary: boolean;
    readonly confidence: number;
    readonly labels?: readonly RegExp[];
    readonly headings?: readonly RegExp[];
    readonly xmlTags?: readonly string[];
    readonly blockKinds?: readonly string[];
    readonly atomKinds?: readonly string[];
};

export type TurnSectionAliasMatch = {
    readonly blockSeq: number;
    readonly alias: TurnSectionAlias;
    readonly display: string;
    readonly confidence: number;
    readonly method: TurnSectionAliasMethod;
    readonly inherited: boolean;
    readonly primary: boolean;
    readonly matched: string;
    readonly sourceBlockSeq?: number | null;
};

export type TurnSectionAliasResult = {
    readonly atoms: readonly ParsedContentAtom[];
    readonly blockLabels: ReadonlyMap<number, Record<string, unknown>>;
};

const label = (value: string): RegExp =>
    new RegExp(`^\\s*(?:#{1,6}\\s*)?${value}\\s*:?\\s*$`, "i");

const prefix = (value: string): RegExp =>
    new RegExp(`^\\s*(?:[-*]\\s*)?${value}\\b`, "i");

const DEFINITIONS: readonly TurnSectionAliasDefinition[] = [
    {
        alias: "objective",
        display: "Objective",
        boundary: true,
        confidence: 0.96,
        labels: [label("objective"), label("goal"), label("task")],
        xmlTags: ["objective", "goal_context"],
    },
    {
        alias: "budget",
        display: "Budget",
        boundary: true,
        confidence: 0.96,
        labels: [
            label("budget"),
            prefix("Token budget"),
            prefix("Tokens used"),
            prefix("Tokens remaining"),
        ],
    },
    {
        alias: "continuation_behavior",
        display: "Continuation",
        boundary: true,
        confidence: 0.94,
        labels: [label("continuation behavior"), prefix("Continue working")],
    },
    {
        alias: "completion_audit",
        display: "Completion Audit",
        boundary: true,
        confidence: 0.92,
        labels: [label("completion audit"), prefix("Before deciding")],
    },
    {
        alias: "progress_visibility",
        display: "Progress Visibility",
        boundary: true,
        confidence: 0.9,
        labels: [label("progress visibility")],
    },
    {
        alias: "work_from_evidence",
        display: "Work From Evidence",
        boundary: true,
        confidence: 0.9,
        labels: [label("work from evidence")],
    },
    {
        alias: "environment_context",
        display: "Environment",
        boundary: false,
        confidence: 0.95,
        headings: [label("environment_context"), label("env")],
        xmlTags: ["environment_context", "env", "cwd", "shell", "current_date", "timezone"],
    },
    {
        alias: "permissions",
        display: "Permissions",
        boundary: false,
        confidence: 0.95,
        headings: [label("permissions")],
        xmlTags: ["permissions", "permissions_instructions", "permissions instructions"],
    },
    {
        alias: "agent_guidance",
        display: "Agent Guidance",
        boundary: true,
        confidence: 0.93,
        labels: [/^\s*#\s+AGENTS\.md instructions\b/i, /^\s*#\s+CLAUDE\.md\b/i, /^<INSTRUCTIONS>/i],
        headings: [label("AGENTS.md"), label("CLAUDE.md autoload")],
        xmlTags: ["instructions"],
    },
    {
        alias: "skills_manifest",
        display: "Skills",
        boundary: false,
        confidence: 0.95,
        labels: [label("skills"), label("skill roots"), label("available skills")],
        headings: [label("skills_instructions")],
        xmlTags: ["skills_instructions", "skill"],
    },
    {
        alias: "apps_manifest",
        display: "Apps",
        boundary: false,
        confidence: 0.95,
        labels: [label("apps"), label("apps \\(connectors\\)")],
        headings: [label("apps_instructions")],
        xmlTags: ["apps_instructions"],
    },
    {
        alias: "plugins_manifest",
        display: "Plugins",
        boundary: false,
        confidence: 0.95,
        labels: [label("plugins"), label("available plugins")],
        headings: [label("plugins_instructions")],
        xmlTags: ["plugins_instructions"],
    },
    {
        alias: "tool_call",
        display: "Tool Call",
        boundary: false,
        confidence: 0.97,
        blockKinds: ["tool_use"],
        atomKinds: ["tool_name"],
        xmlTags: ["tool_use"],
    },
    {
        alias: "tool_output",
        display: "Tool Output",
        boundary: false,
        confidence: 0.96,
        blockKinds: ["tool_result"],
    },
    {
        alias: "plan",
        display: "Plan",
        boundary: true,
        confidence: 0.88,
        labels: [label("plan"), label("implementation plan")],
    },
    {
        alias: "todo",
        display: "Todo",
        boundary: false,
        confidence: 0.84,
        labels: [/^\s*(?:[-*]\s+)?\[[ xX]\]\s+\S/, /\b(?:todo|update_plan|checklist)\b/i],
    },
    {
        alias: "verification",
        display: "Verification",
        boundary: true,
        confidence: 0.88,
        labels: [label("tests"), label("verification"), label("smoke"), /\b(?:bun test|typecheck)\b/i],
    },
    {
        alias: "reference",
        display: "Reference",
        boundary: false,
        confidence: 0.72,
        atomKinds: ["file_ref", "symbol_ref", "url_ref", "citation_ref", "command_ref", "error_signature"],
    },
] as const;

export const turnSectionAliasDefinitions = DEFINITIONS;

const normalizeTag = (value: string): string => value.trim().toLowerCase().replace(/[_\s-]+/g, "_");

const displayText = (block: ParsedContentBlock): string => (block.heading ?? block.text ?? "").trim();

const firstNonEmptyLine = (value: string): string =>
    value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? value.trim();

const isSpanLevelBlock = (block: ParsedContentBlock): boolean => block.labels?.["level"] === "span";

const isBoundaryCandidate = (block: ParsedContentBlock): boolean => {
    if (block.heading) return true;
    if (isSpanLevelBlock(block)) return false;
    const text = (block.text ?? "").trim();
    return text.length > 0 && text.length <= 120 && !text.includes("\n\n");
};

const matchDefinition = (
    definition: TurnSectionAliasDefinition,
    block: ParsedContentBlock,
    atoms: readonly ParsedContentAtom[],
): Omit<TurnSectionAliasMatch, "blockSeq" | "sourceBlockSeq"> | null => {
    if (definition.blockKinds?.includes(block.kind)) {
        return {
            alias: definition.alias,
            display: definition.display,
            confidence: definition.confidence,
            method: "block-kind",
            inherited: false,
            primary: definition.alias !== "reference",
            matched: block.kind,
        };
    }

    const heading = block.heading?.trim();
    if (heading && definition.headings?.some((pattern) => pattern.test(heading))) {
        return {
            alias: definition.alias,
            display: definition.display,
            confidence: definition.confidence,
            method: "block-heading",
            inherited: false,
            primary: definition.alias !== "reference",
            matched: heading,
        };
    }

    const atom = atoms.find((candidate) => {
        if (definition.atomKinds?.includes(candidate.kind)) return true;
        if (candidate.kind !== "xml_tag") return false;
        const tag = normalizeTag(candidate.normalized ?? candidate.value);
        return definition.xmlTags?.some((xmlTag) => normalizeTag(xmlTag) === tag) ?? false;
    });
    if (atom) {
        return {
            alias: definition.alias,
            display: definition.display,
            confidence: definition.confidence,
            method: atom.kind === "xml_tag" ? "xml-tag" : "atom-kind",
            inherited: false,
            primary: definition.alias !== "reference",
            matched: atom.value,
        };
    }

    if (!isBoundaryCandidate(block)) return null;
    const text = displayText(block);
    const candidates = [text, firstNonEmptyLine(text)];
    const matchedCandidate = candidates.find((candidate) =>
        definition.labels?.some((pattern) => pattern.test(candidate))
    );
    const labelMatch = matchedCandidate !== undefined;
    if (labelMatch) {
        return {
            alias: definition.alias,
            display: definition.display,
            confidence: definition.confidence,
            method: "label-prefix",
            inherited: false,
            primary: definition.alias !== "reference",
            matched: matchedCandidate,
        };
    }

    return null;
};

const appendLabel = (
    labels: Map<number, Record<string, unknown>>,
    match: TurnSectionAliasMatch,
): void => {
    const existing = labels.get(match.blockSeq) ?? {};
    const aliases = Array.isArray(existing["semantic_aliases"])
        ? [...(existing["semantic_aliases"] as string[])]
        : [];
    if (!aliases.includes(match.alias)) aliases.push(match.alias);
    const next: Record<string, unknown> = {
        ...existing,
        semantic_aliases: aliases,
    };
    if (!next["primary_semantic_alias"] && match.primary) next["primary_semantic_alias"] = match.alias;
    labels.set(match.blockSeq, next);
};

const aliasToAtom = (match: TurnSectionAliasMatch): ParsedContentAtom => ({
    blockSeq: match.blockSeq,
    kind: "section_alias",
    value: match.alias,
    normalized: match.alias,
    confidence: match.confidence,
    raw: {
        display: match.display,
        method: match.method,
        inherited: match.inherited,
        primary: match.primary,
        matched: match.matched,
        sourceBlockSeq: match.sourceBlockSeq ?? null,
        classifierVersion: TURN_SECTION_ALIAS_VERSION,
    },
});

export function classifyTurnSectionAliases(
    blocks: readonly ParsedContentBlock[],
    atoms: readonly ParsedContentAtom[],
    input?: Pick<ContentDocumentInput, "labels">,
): TurnSectionAliasResult {
    const atomsByBlockSeq = new Map<number, ParsedContentAtom[]>();
    for (const atom of atoms) {
        const existing = atomsByBlockSeq.get(atom.blockSeq) ?? [];
        existing.push(atom);
        atomsByBlockSeq.set(atom.blockSeq, existing);
    }

    const matches: TurnSectionAliasMatch[] = [];
    const activeByParent = new Map<number | "root", TurnSectionAliasMatch>();

    for (const block of [...blocks].sort((a, b) => a.seq - b.seq)) {
        const blockAtoms = atomsByBlockSeq.get(block.seq) ?? [];
        const direct: TurnSectionAliasMatch[] = [];
        for (const definition of DEFINITIONS) {
            const match = matchDefinition(definition, block, blockAtoms);
            if (!match) continue;
            direct.push({ ...match, blockSeq: block.seq, sourceBlockSeq: block.seq });
        }

        const boundary = direct.find((match) =>
            DEFINITIONS.find((definition) => definition.alias === match.alias)?.boundary === true && match.primary
        );
        const parentKey = block.parentSeq ?? "root";
        if (boundary) {
            activeByParent.set(parentKey, boundary);
        } else if (isBoundaryCandidate(block) && direct.some((match) => match.primary)) {
            activeByParent.delete(parentKey);
        }

        const active = activeByParent.get(parentKey);
        const inherited: TurnSectionAliasMatch[] = active && active.blockSeq !== block.seq && !direct.some((match) => match.alias === active.alias)
            ? [{
                blockSeq: block.seq,
                alias: active.alias,
                display: active.display,
                confidence: Math.max(0.55, active.confidence - 0.08),
                method: "inherited" as const,
                inherited: true,
                primary: true,
                matched: active.matched,
                sourceBlockSeq: active.blockSeq,
            }]
            : [];

        matches.push(...direct, ...inherited);
    }

    const labels = new Map<number, Record<string, unknown>>();
    for (const match of matches) appendLabel(labels, match);

    void input;
    return {
        atoms: matches.map(aliasToAtom),
        blockLabels: labels,
    };
}
