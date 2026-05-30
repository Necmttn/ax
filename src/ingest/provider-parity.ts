export const PROVIDER_PARITY_PROVIDERS = [
    "claude",
    "codex",
    "pi",
    "opencode",
    "cursor",
] as const;

export type ProviderParityProvider = (typeof PROVIDER_PARITY_PROVIDERS)[number];

export const PROVIDER_PARITY_FEATURE_KEYS = [
    "source-path",
    "provider-events",
    "turns",
    "tool-calls",
    "invoked-edges",
    "plans",
    "file-edit-evidence",
    "file-read-search-evidence",
    "token-usage",
    "hooks",
    "subagent-delegation",
    "derived-analysis",
] as const;

export type ProviderParityFeatureKey = (typeof PROVIDER_PARITY_FEATURE_KEYS)[number];

export type ProviderParityStatus =
    | "supported"
    | "raw-signal-unavailable"
    | "extractor-not-implemented";

export interface ProviderParityEvidenceRef {
    readonly path: string;
    readonly contains: string;
}

export interface ProviderParityCell {
    readonly status: ProviderParityStatus;
    readonly note: string;
    readonly writerEvidence?: readonly ProviderParityEvidenceRef[];
}

export interface ProviderParityFeature {
    readonly key: ProviderParityFeatureKey;
    readonly label: string;
    readonly sharedRecords: readonly string[];
    readonly relatedRecords?: readonly string[];
    readonly readEvidence: readonly ProviderParityEvidenceRef[];
    readonly providers: Record<ProviderParityProvider, ProviderParityCell>;
}

const normalizedProviderWriters = (provider: ProviderParityProvider, path: string): readonly ProviderParityEvidenceRef[] => [
    { path, contains: `provider: "${provider}"` },
    { path, contains: "providerEvents" },
];

const supported = (
    note: string,
    writerEvidence: readonly ProviderParityEvidenceRef[],
): ProviderParityCell => ({
    status: "supported",
    note,
    writerEvidence,
});

const extractorGap = (note: string): ProviderParityCell => ({
    status: "extractor-not-implemented",
    note,
});

const rawGap = (note: string): ProviderParityCell => ({
    status: "raw-signal-unavailable",
    note,
});

export const PROVIDER_PARITY_FEATURES: readonly ProviderParityFeature[] = [
    {
        key: "source-path",
        label: "Provider identity and source path",
        sharedRecords: ["agent_provider", "agent_session", "session"],
        readEvidence: [
            { path: "src/queries/graph-health.ts", contains: "FROM agent_session" },
            { path: "src/queries/session-detail.ts", contains: "FROM $sessionId" },
        ],
        providers: {
            claude: supported("Claude JSONL path is stored on normalized session and agent_session rows.", [
                { path: "src/ingest/transcripts.ts", contains: "sourcePath: extracted.sourcePath" },
                { path: "src/ingest/transcripts.ts", contains: "rawFile: extracted.session.raw_file" },
            ]),
            codex: supported("Codex JSONL path is stored on normalized session and agent_session rows.", [
                { path: "src/ingest/codex.ts", contains: "sourcePath: batch.sourcePath" },
                { path: "src/ingest/codex.ts", contains: "raw_file: rawPointer" },
            ]),
            pi: supported("Pi JSONL path is stored on normalized session and agent_session rows.", [
                { path: "src/ingest/pi.ts", contains: "sourcePath: extract.sourcePath" },
                { path: "src/ingest/pi.ts", contains: "raw_file: extracted.sourcePath" },
            ]),
            opencode: supported("OpenCode database path is stored on normalized session and agent_session rows.", [
                { path: "src/ingest/opencode.ts", contains: "sourcePath" },
            ]),
            cursor: supported("Cursor state database path is stored on normalized session and agent_session rows.", [
                { path: "src/ingest/cursor.ts", contains: "sourcePath" },
            ]),
        },
    },
    {
        key: "provider-events",
        label: "Provider event stream",
        sharedRecords: ["agent_event"],
        relatedRecords: ["agent_event_child"],
        readEvidence: [
            { path: "src/queries/graph-health.ts", contains: "FROM agent_event" },
            { path: "src/queries/graph-health.ts", contains: "FROM agent_session" },
        ],
        providers: {
            claude: supported("Claude transcript rows become provider-native agent_event rows.", normalizedProviderWriters("claude", "src/ingest/transcripts.ts")),
            codex: supported("Codex JSONL events become provider-native agent_event rows.", normalizedProviderWriters("codex", "src/ingest/codex.ts")),
            pi: supported("Pi event blocks become provider-native agent_event rows.", normalizedProviderWriters("pi", "src/ingest/pi.ts")),
            opencode: supported("OpenCode SQLite messages become provider-native agent_event rows.", normalizedProviderWriters("opencode", "src/ingest/opencode.ts")),
            cursor: supported("Cursor composer/chat entries become provider-native agent_event rows.", normalizedProviderWriters("cursor", "src/ingest/cursor.ts")),
        },
    },
    {
        key: "turns",
        label: "Normalized turns",
        sharedRecords: ["turn"],
        readEvidence: [
            { path: "src/queries/recall.ts", contains: "FROM turn" },
            { path: "src/queries/session-detail.ts", contains: "SESSION_OVERVIEW_SQL" },
        ],
        providers: {
            claude: supported("Claude messages are normalized into turn rows.", normalizedProviderWriters("claude", "src/ingest/transcripts.ts")),
            codex: supported("Codex items are normalized into turn rows.", normalizedProviderWriters("codex", "src/ingest/codex.ts")),
            pi: supported("Pi messages are normalized into turn rows.", normalizedProviderWriters("pi", "src/ingest/pi.ts")),
            opencode: supported("OpenCode messages are normalized into turn rows.", normalizedProviderWriters("opencode", "src/ingest/opencode.ts")),
            cursor: supported("Cursor messages are normalized into turn rows.", normalizedProviderWriters("cursor", "src/ingest/cursor.ts")),
        },
    },
    {
        key: "tool-calls",
        label: "Tool calls",
        sharedRecords: ["tool", "tool_call"],
        readEvidence: [
            { path: "src/queries/tool-failures.ts", contains: "FROM tool_call" },
            { path: "src/queries/session-detail.ts", contains: "FROM tool_call" },
        ],
        providers: {
            claude: supported("Claude tool use/result blocks write shared tool_call rows.", [
                { path: "src/ingest/transcripts.ts", contains: "buildToolCallStatements(toolCalls)" },
            ]),
            codex: supported("Codex function/tool events write shared tool_call rows.", [
                { path: "src/ingest/codex.ts", contains: "buildToolCallStatements(batch.toolCalls" },
            ]),
            pi: supported("Pi tool blocks write shared tool_call rows.", [
                { path: "src/ingest/pi.ts", contains: "buildToolCallStatements(extract.toolCalls)" },
            ]),
            opencode: supported("OpenCode structured tool parts write shared tool_call rows.", [
                { path: "src/ingest/opencode.ts", contains: "buildToolCallStatements(extract.toolCalls)" },
            ]),
            cursor: extractorGap("Cursor state parsing does not yet extract concrete tool calls."),
        },
    },
    {
        key: "invoked-edges",
        label: "Skill/tool invocation edges",
        sharedRecords: ["skill", "invoked"],
        relatedRecords: ["concerns"],
        readEvidence: [
            { path: "src/queries/session-detail.ts", contains: "FROM invoked" },
            { path: "src/dashboard/skills-weighted.ts", contains: "FROM invoked" },
        ],
        providers: {
            claude: supported("Claude Skill/tool invocations write invoked edges to real skill rows.", [
                { path: "src/ingest/transcripts.ts", contains: "->invoked:" },
                { path: "src/ingest/transcripts.ts", contains: "buildRelateToolCallSkillStatements" },
            ]),
            codex: supported("Codex tool calls write synthetic codex:<tool> skill invocations.", [
                { path: "src/ingest/codex.ts", contains: "->invoked:" },
                { path: "src/ingest/codex.ts", contains: "buildRelateToolCallSkillStatements" },
            ]),
            pi: supported("Pi tool blocks write synthetic pi:<tool> skill invocations.", [
                { path: "src/ingest/pi.ts", contains: "->invoked:" },
                { path: "src/ingest/pi.ts", contains: "buildRelateToolCallSkillStatements" },
            ]),
            opencode: supported("OpenCode tool parts write synthetic opencode:<tool> skill invocations.", [
                { path: "src/ingest/opencode.ts", contains: "->invoked:" },
                { path: "src/ingest/opencode.ts", contains: "buildRelateToolCallSkillStatements" },
            ]),
            cursor: extractorGap("Cursor tool invocations are not emitted until concrete tool calls are extracted."),
        },
    },
    {
        key: "plans",
        label: "Plans",
        sharedRecords: ["plan", "plan_item", "plan_snapshot"],
        readEvidence: [
            { path: "src/queries/insights.ts", contains: "SELECT id FROM plan_snapshot WHERE session = $parent.id" },
            { path: "src/dashboard/report.ts", contains: "plan_snapshot" },
        ],
        providers: {
            claude: supported("Claude TodoWrite evidence writes plan snapshots.", [
                { path: "src/ingest/transcripts.ts", contains: "buildPlanSnapshotStatements(snapshot)" },
            ]),
            codex: supported("Codex update_plan evidence writes plan snapshots.", [
                { path: "src/ingest/codex.ts", contains: "buildPlanSnapshotStatements(snapshot)" },
            ]),
            pi: rawGap("Pi transcript blocks observed by this extractor do not expose a plan-update raw signal."),
            opencode: extractorGap("OpenCode plan-like events are not extracted into shared plan rows yet."),
            cursor: extractorGap("Cursor plan-like events are not extracted into shared plan rows yet."),
        },
    },
    {
        key: "file-edit-evidence",
        label: "File edit evidence",
        sharedRecords: ["file", "edited"],
        readEvidence: [
            { path: "src/queries/insights.ts", contains: "FROM edited" },
            { path: "src/queries/insights.ts", contains: "verificationGapsSql" },
        ],
        providers: {
            claude: supported("Claude edit/write tool arguments write edited edges to file rows.", [
                { path: "src/ingest/transcripts.ts", contains: "buildToolFileEvidenceStatements" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "EDIT_TOOLS" },
            ]),
            codex: supported("Codex apply_patch tool arguments write edited edges to file rows when structured patch headers are present.", [
                { path: "src/ingest/codex.ts", contains: "buildToolFileEvidenceStatements(extractToolFileEvidence(batch.toolCalls))" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "patchPaths" },
            ]),
            pi: supported("Pi structured edit/write tool arguments write edited edges to file rows.", [
                { path: "src/ingest/pi.ts", contains: "buildToolFileEvidenceStatements(extractToolFileEvidence(extract.toolCalls))" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "EDIT_TOOLS" },
            ]),
            opencode: extractorGap("OpenCode file edit evidence depends on concrete tool-call extraction."),
            cursor: extractorGap("Cursor file edit evidence depends on concrete tool-call extraction."),
        },
    },
    {
        key: "file-read-search-evidence",
        label: "File read/search evidence",
        sharedRecords: ["file", "read_file", "searched_file"],
        readEvidence: [
            { path: "src/queries/session-detail.ts", contains: "FROM read_file" },
            { path: "src/queries/session-detail.ts", contains: "FROM searched_file" },
        ],
        providers: {
            claude: supported("Claude Read/Grep/Glob tool arguments write read_file and searched_file edges.", [
                { path: "src/ingest/transcripts.ts", contains: "buildToolFileEvidenceStatements" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "READ_TOOLS" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "SEARCH_TOOLS" },
            ]),
            codex: supported("Codex structured read/search tool arguments write read_file and searched_file edges.", [
                { path: "src/ingest/codex.ts", contains: "buildToolFileEvidenceStatements(extractToolFileEvidence(batch.toolCalls))" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "READ_COMMANDS" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "SEARCH_COMMANDS" },
            ]),
            pi: supported("Pi structured read/search tool arguments write read_file and searched_file edges.", [
                { path: "src/ingest/pi.ts", contains: "buildToolFileEvidenceStatements(extractToolFileEvidence(extract.toolCalls))" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "READ_TOOLS" },
                { path: "src/ingest/tool-file-evidence.ts", contains: "SEARCH_TOOLS" },
            ]),
            opencode: extractorGap("OpenCode file read/search evidence is not mapped into file relations yet."),
            cursor: extractorGap("Cursor file read/search evidence depends on concrete tool-call extraction."),
        },
    },
    {
        key: "token-usage",
        label: "Token/cost usage",
        sharedRecords: ["session_token_usage"],
        readEvidence: [
            { path: "src/queries/wrapped.ts", contains: "FROM session_token_usage" },
            { path: "src/queries/insights.ts", contains: "FROM session_token_usage" },
        ],
        providers: {
            claude: supported("Claude sessions receive estimated token usage from session-health.", [
                { path: "src/ingest/session-health.ts", contains: "UPSERT ${recordRef(\"session_token_usage\"" },
            ]),
            codex: supported("Codex sessions receive token usage through session-health metrics and estimates.", [
                { path: "src/ingest/session-health.ts", contains: "UPSERT ${recordRef(\"session_token_usage\"" },
            ]),
            pi: supported("Pi usage fields write explicit token usage when present.", [
                { path: "src/ingest/pi.ts", contains: "buildPiTokenUsageStatements" },
                { path: "src/ingest/pi.ts", contains: "recordRef(\"session_token_usage\"" },
            ]),
            opencode: supported("OpenCode sessions receive estimated token usage from session-health.", [
                { path: "src/ingest/session-health.ts", contains: "UPSERT ${recordRef(\"session_token_usage\"" },
            ]),
            cursor: supported("Cursor sessions receive estimated token usage from session-health.", [
                { path: "src/ingest/session-health.ts", contains: "UPSERT ${recordRef(\"session_token_usage\"" },
            ]),
        },
    },
    {
        key: "hooks",
        label: "Hook evidence",
        sharedRecords: ["harness_hook_event", "hook_command_invocation", "hook_fire"],
        readEvidence: [
            { path: "src/queries/hooks.ts", contains: "FROM hook_command_invocation" },
            { path: "src/dashboard/session-inspect.ts", contains: "FROM hook_fire" },
        ],
        providers: {
            claude: supported("Claude transcript hook attachments write native hook evidence rows.", [
                { path: "src/ingest/transcripts.ts", contains: "harness_hook_event" },
                { path: "src/ingest/transcripts.ts", contains: "hook_command_invocation" },
            ]),
            codex: rawGap("Codex transcript events do not expose native hook attachment blocks; runtime hook_fire telemetry is provider-agnostic."),
            pi: rawGap("Pi transcript events do not expose native hook attachment blocks; runtime hook_fire telemetry is provider-agnostic."),
            opencode: rawGap("OpenCode transcript events do not expose native hook attachment blocks; runtime hook_fire telemetry is provider-agnostic."),
            cursor: rawGap("Cursor transcript events do not expose native hook attachment blocks; runtime hook_fire telemetry is provider-agnostic."),
        },
    },
    {
        key: "subagent-delegation",
        label: "Subagent/delegation links",
        sharedRecords: ["spawned"],
        relatedRecords: ["session", "tool_call"],
        readEvidence: [
            { path: "src/queries/episode-timeline.ts", contains: "FROM spawned" },
            { path: "src/queries/session-detail.ts", contains: "FROM spawned" },
        ],
        providers: {
            claude: supported("Claude Task/Agent evidence writes spawned child-session links.", [
                { path: "src/ingest/derive-claude-subagents.ts", contains: "-> spawned ->" },
                { path: "src/ingest/derive-spawned.ts", contains: "deps: [\"claude\", \"codex\"]" },
            ]),
            codex: supported("Codex spawn-agent tool evidence writes spawned child-session links when present.", [
                { path: "src/ingest/derive-spawned.ts", contains: "deps: [\"claude\", \"codex\"]" },
                { path: "src/ingest/derive-spawned.ts", contains: "-> spawned ->" },
            ]),
            pi: rawGap("Pi transcript blocks observed by this extractor do not expose delegated child-session identity."),
            opencode: extractorGap("OpenCode delegation signals are not extracted into spawned links yet."),
            cursor: extractorGap("Cursor delegation signals are not extracted into spawned links yet."),
        },
    },
    {
        key: "derived-analysis",
        label: "Derived analysis and insights",
        sharedRecords: ["friction_event", "command_outcome", "session_health"],
        readEvidence: [
            { path: "src/queries/insights.ts", contains: "FROM command_outcome" },
            { path: "src/queries/insights.ts", contains: "FROM session_health" },
        ],
        providers: {
            claude: supported("Claude normalized turns and tool calls feed shared derived analysis stages.", [
                { path: "src/ingest/outcomes.ts", contains: "recordRef(\"command_outcome\"" },
                { path: "src/ingest/session-health.ts", contains: "recordRef(\"session_health\"" },
            ]),
            codex: supported("Codex normalized turns and tool calls feed shared derived analysis stages.", [
                { path: "src/ingest/outcomes.ts", contains: "recordRef(\"command_outcome\"" },
                { path: "src/ingest/session-health.ts", contains: "recordRef(\"session_health\"" },
            ]),
            pi: supported("Pi normalized turns and tool calls feed shared derived analysis stages.", [
                { path: "src/ingest/outcomes.ts", contains: "recordRef(\"command_outcome\"" },
                { path: "src/ingest/session-health.ts", contains: "recordRef(\"session_health\"" },
            ]),
            opencode: supported("OpenCode normalized turns feed shared derived analysis stages.", [
                { path: "src/ingest/outcomes.ts", contains: "recordRef(\"command_outcome\"" },
                { path: "src/ingest/session-health.ts", contains: "recordRef(\"session_health\"" },
            ]),
            cursor: supported("Cursor normalized turns feed shared derived analysis stages.", [
                { path: "src/ingest/outcomes.ts", contains: "recordRef(\"command_outcome\"" },
                { path: "src/ingest/session-health.ts", contains: "recordRef(\"session_health\"" },
            ]),
        },
    },
] as const;
