export type ContentSourceKind =
    | "skill"
    | "artifact"
    | "plan_snapshot"
    | "workflow_script"
    | "turn"
    | "workflow_run";

export type ParserDecisionKind = "accept" | "reject" | "maybe";

export type ParserDecision = {
    readonly decision: ParserDecisionKind;
    readonly score: number;
    readonly reason: string;
};

export type ContentDocumentInput = {
    readonly sourceKind: ContentSourceKind;
    readonly sourceRef: string;
    readonly path?: string | null;
    readonly uri?: string | null;
    readonly title?: string | null;
    readonly text: string;
    readonly labels?: Record<string, unknown> | null;
};

export type ParsedContentBlock = {
    readonly kind: string;
    readonly seq: number;
    readonly parentSeq?: number | null;
    readonly role?: string | null;
    readonly heading?: string | null;
    readonly text?: string | null;
    readonly textExcerpt?: string | null;
    readonly searchText?: string | null;
    readonly startOffset?: number | null;
    readonly endOffset?: number | null;
    readonly confidence?: number | null;
    readonly parser: string;
    readonly raw?: Record<string, unknown> | null;
    readonly labels?: Record<string, unknown> | null;
    readonly metrics?: Record<string, unknown> | null;
};

export type ParsedContentAtom = {
    readonly blockSeq: number;
    readonly kind: string;
    readonly value: string;
    readonly normalized?: string | null;
    readonly startOffset?: number | null;
    readonly endOffset?: number | null;
    readonly confidence?: number | null;
    readonly raw?: Record<string, unknown> | null;
};

export type ParsedContentDocument = {
    readonly parserId: string;
    readonly parserVersion: string;
    readonly classifierVersions?: Record<string, string> | null;
    readonly blocks: readonly ParsedContentBlock[];
    readonly atoms: readonly ParsedContentAtom[];
};

export type ContentParser = {
    readonly id: string;
    readonly version: string;
    readonly accepts: (input: ContentDocumentInput) => ParserDecision;
    readonly parse: (input: ContentDocumentInput) => ParsedContentDocument;
};

export type AtomClassifier = {
    readonly id: string;
    readonly version: string;
    readonly kinds: readonly string[];
    readonly classify: (block: ParsedContentBlock) => readonly ParsedContentAtom[];
};
