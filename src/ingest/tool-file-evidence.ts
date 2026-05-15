export type ToolFileEvidenceKind = "read_file" | "searched_file";

const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);
const READ_COMMANDS = new Set(["cat", "sed", "nl", "head", "tail", "less"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "git grep", "fd", "find"]);

export interface ToolFileEvidenceInput {
    readonly name: string;
    readonly commandNorm?: string | null;
}

export function classifyToolFileEvidence(input: ToolFileEvidenceInput): readonly ToolFileEvidenceKind[] {
    const name = input.name.trim().toLowerCase();
    const command = input.commandNorm?.trim().toLowerCase() ?? "";
    const kinds = new Set<ToolFileEvidenceKind>();

    if (READ_TOOLS.has(name) || READ_COMMANDS.has(command)) kinds.add("read_file");
    if (SEARCH_TOOLS.has(name) || SEARCH_COMMANDS.has(command)) kinds.add("searched_file");

    return Array.from(kinds);
}

export function evidenceReason(input: ToolFileEvidenceInput, kind: ToolFileEvidenceKind): string {
    const command = input.commandNorm?.trim();
    if (command && (kind === "read_file" ? READ_COMMANDS : SEARCH_COMMANDS).has(command.toLowerCase())) {
        return `command_norm:${command}`;
    }
    return `tool_name:${input.name}`;
}
