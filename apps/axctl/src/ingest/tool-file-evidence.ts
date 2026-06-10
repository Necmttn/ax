import { posixPath } from "@ax/lib/shared/path";
import {
    EDIT_COMMANDS,
    EDIT_TOOL_NAMES,
    FILE_READ_COMMANDS,
    FILE_READ_TOOL_NAMES,
    FILE_SEARCH_COMMANDS,
    FILE_SEARCH_TOOL_NAMES,
    isApplyPatchCall,
} from "@ax/lib/shared/tool-classes";
import type { ToolCallWrite } from "./evidence-writers.ts";
import { toolCallRecordKey } from "./record-keys.ts";

export type ToolFileEvidenceKind = "read_file" | "searched_file";
export type ToolFileRelationKind = "edited" | ToolFileEvidenceKind;

// Canonical sets live in @ax/lib/shared/tool-classes (shared with the
// timeline + metrics classifiers so the three can't drift); the local names
// are kept because provider-parity evidence references them.
const READ_TOOLS = FILE_READ_TOOL_NAMES;
const SEARCH_TOOLS = FILE_SEARCH_TOOL_NAMES;
const EDIT_TOOLS = EDIT_TOOL_NAMES;
const READ_COMMANDS = FILE_READ_COMMANDS;
const SEARCH_COMMANDS = FILE_SEARCH_COMMANDS;
const STRUCTURED_PATH_FIELDS = ["file_path", "path", "notebook_path", "file"] as const;

export interface ToolFileEvidenceInput {
    readonly name: string;
    readonly commandNorm?: string | null;
}

export interface ToolFileEvidence {
    readonly kind: ToolFileRelationKind;
    readonly sessionId: string;
    readonly turnKey?: string | null;
    readonly toolCallKey: string;
    readonly toolName: string;
    readonly ts: Date | string;
    readonly path: string;
    readonly pathSeen: string;
    readonly evidence: string;
    readonly excerpt?: string | null;
    readonly editKind?: string | null;
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

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function arrayStringField(input: Record<string, unknown>, field: string): readonly string[] {
    const value = input[field];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeEvidencePath(path: string, cwd?: string | null): string {
    if (posixPath.isAbsolute(path) || !cwd) return path;
    return posixPath.resolve(cwd, path);
}

function unique(values: Iterable<string>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function structuredPaths(input: unknown): string[] {
    if (!isRecord(input)) return [];
    const paths: string[] = [];
    for (const field of STRUCTURED_PATH_FIELDS) {
        const path = stringField(input, field);
        if (path) paths.push(path);
    }
    paths.push(...arrayStringField(input, "paths"));
    paths.push(...arrayStringField(input, "files"));
    return unique(paths);
}

function patchPaths(input: unknown): string[] {
    if (!isRecord(input)) return [];
    const patch =
        stringField(input, "patch") ??
        stringField(input, "diff") ??
        stringField(input, "input");
    if (!patch) return [];

    const paths: string[] = [];
    for (const line of patch.split(/\r?\n/)) {
        const explicit = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ??
            line.match(/^\*\*\* Move to: (.+)$/);
        if (explicit?.[1]) {
            paths.push(explicit[1]);
            continue;
        }

        const diffPath = line.match(/^\+\+\+ b\/(.+)$/);
        if (diffPath?.[1] && diffPath[1] !== "/dev/null") paths.push(diffPath[1]);
    }
    return unique(paths);
}

function pathsForKind(call: ToolCallWrite, kind: ToolFileRelationKind): string[] {
    const structured = structuredPaths(call.inputJson);
    if (kind !== "edited") return structured;

    const patchCall = isApplyPatchCall({ name: call.toolName, command_norm: call.commandNorm ?? null });
    if (patchCall) return unique([...structured, ...patchPaths(call.inputJson)]);
    return structured;
}

function editKindForTool(toolName: string): string | null {
    const name = toolName.trim().toLowerCase();
    if (name === "write") return "write";
    if (
        name === "apply_patch" || name === "edit" || name === "multiedit" || name === "notebookedit"
        || name === "edit_file" || name === "apply_diff"
    ) {
        return "edit";
    }
    return null;
}

export function extractToolFileEvidence(
    calls: readonly ToolCallWrite[],
): ToolFileEvidence[] {
    const evidence: ToolFileEvidence[] = [];

    for (const call of calls) {
        const name = call.toolName.trim().toLowerCase();
        const command = call.commandNorm?.trim().toLowerCase() ?? "";
        const kinds: ToolFileRelationKind[] = [
            // Name- AND command-based edit detection (shell tee/patch/dd/
            // apply_patch); shell edits rarely carry structured paths, so
            // they usually contribute no rows, but never misclassify as read.
            ...(EDIT_TOOLS.has(name) || EDIT_COMMANDS.has(command) ? ["edited" as const] : []),
            ...classifyToolFileEvidence({
                name: call.toolName,
                commandNorm: call.commandNorm ?? null,
            }),
        ];
        if (kinds.length === 0) continue;

        const toolCallKey = toolCallRecordKey({
            sessionId: call.sessionId,
            seq: call.seq,
            callId: call.callId ?? null,
        });

        for (const kind of kinds) {
            for (const pathSeen of pathsForKind(call, kind)) {
                evidence.push({
                    kind,
                    sessionId: call.sessionId,
                    turnKey: call.turnKey ?? null,
                    toolCallKey,
                    toolName: call.toolName,
                    ts: call.ts,
                    path: normalizeEvidencePath(pathSeen, call.cwd),
                    pathSeen,
                    evidence: kind === "edited"
                        ? `tool_name:${call.toolName}`
                        : evidenceReason({
                            name: call.toolName,
                            commandNorm: call.commandNorm ?? null,
                        }, kind),
                    excerpt: call.outputExcerpt ?? null,
                    editKind: kind === "edited" ? editKindForTool(call.toolName) : null,
                });
            }
        }
    }

    return evidence;
}
