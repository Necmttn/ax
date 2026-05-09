export type ToolKind =
    | "builtin"
    | "cli"
    | "mcp"
    | "skill"
    | "slash_command"
    | "api"
    | "unknown";

export interface ParsedFunctionOutput {
    exitCode: number | null;
    durationMs: number | null;
    outputExcerpt: string;
    hasError: boolean;
}

const BUILTIN_TOOL_NAMES = new Set([
    "Agent",
    "Bash",
    "BashOutput",
    "Edit",
    "ExitPlanMode",
    "Glob",
    "Grep",
    "KillBash",
    "LS",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Read",
    "Task",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Write",
    "apply_patch",
    "exec_command",
    "write_stdin",
]);

const CLI_TOOL_NAMES = new Set([
    "awk",
    "bun",
    "cargo",
    "cat",
    "chmod",
    "cp",
    "curl",
    "deno",
    "docker",
    "find",
    "gh",
    "git",
    "go",
    "grep",
    "head",
    "just",
    "ls",
    "make",
    "mkdir",
    "mv",
    "node",
    "npm",
    "pnpm",
    "python",
    "python3",
    "rg",
    "rm",
    "sed",
    "sh",
    "surreal",
    "tail",
    "tsc",
    "uv",
    "wget",
    "yarn",
    "zsh",
]);

const SUBCOMMAND_TOOLS = new Set([
    "brew",
    "bun",
    "cargo",
    "deno",
    "docker",
    "docker-compose",
    "gh",
    "git",
    "go",
    "just",
    "kubectl",
    "make",
    "npm",
    "pnpm",
    "poetry",
    "surreal",
    "uv",
    "yarn",
]);

const COMMAND_SEPARATORS = new Set(["&&", "||", ";"]);
const CONTROL_PREFIXES = new Set(["cd", "popd", "pushd"]);
const SIMPLE_WRAPPERS = new Set(["builtin", "command", "exec", "noglob", "nohup"]);
const OPTIONS_WITH_VALUES = new Set([
    "-C",
    "-c",
    "-g",
    "-h",
    "-n",
    "-p",
    "-u",
    "--chdir",
    "--config",
    "--config-env",
    "--cwd",
    "--database",
    "--endpoint",
    "--group",
    "--host",
    "--namespace",
    "--port",
    "--prompt",
    "--token",
    "--unset",
    "--user",
]);
const TIME_OPTIONS_WITH_VALUES = new Set(["-f", "-o", "--format", "--output"]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const MAX_OUTPUT_EXCERPT_CHARS = 1200;

export function toolKindForName(name: string): ToolKind {
    const trimmed = name.trim();

    if (trimmed.length === 0) return "unknown";
    if (trimmed.startsWith("/")) return "slash_command";
    if (trimmed.startsWith("mcp__")) return "mcp";
    if (trimmed === "Skill") return "skill";
    if (BUILTIN_TOOL_NAMES.has(trimmed)) return "builtin";
    if (CLI_TOOL_NAMES.has(trimmed)) return "cli";
    if (/^[a-zA-Z_$][\w$]*(?:[.:][a-zA-Z_$][\w$]*)+$/.test(trimmed)) return "api";

    return "unknown";
}

export function extractCommandTool(command: string | null | undefined): string | null {
    const commandTokens = extractCommandTokens(command);
    return commandTokens?.[0] ?? null;
}

export function normalizeCommand(command: string | null | undefined): string | null {
    const commandTokens = extractCommandTokens(command);
    if (!commandTokens) return null;

    const [tool, ...args] = commandTokens;
    if (!SUBCOMMAND_TOOLS.has(tool)) return tool;

    const subcommand = firstPatternArg(args);
    return subcommand ? `${tool} ${subcommand}` : tool;
}

export function parseCodexFunctionOutput(
    output: string | null | undefined,
): ParsedFunctionOutput {
    const text = (output ?? "").replace(/\r\n/g, "\n");
    const exitCode = parseIntegerMatch(text.match(/Process exited with code\s+(-?\d+)/i));
    const durationSeconds = parseFloatMatch(text.match(/Wall time:\s*([0-9]+(?:\.[0-9]+)?)\s*seconds/i));
    const outputBody = text.match(/(?:^|\n)Output:\n([\s\S]*)$/)?.[1] ?? text;
    const outputExcerpt = boundExcerpt(outputBody.trim());

    return {
        exitCode,
        durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
        outputExcerpt,
        hasError: exitCode !== null ? exitCode !== 0 : looksLikeError(outputExcerpt),
    };
}

function extractCommandTokens(command: string | null | undefined): string[] | null {
    const tokens = tokenizeShell(command ?? "");
    if (tokens.length === 0) return null;

    for (const segment of commandSegments(tokens)) {
        const stripped = stripCommandPrefixes(segment);
        if (stripped.length > 0) return stripped;
    }

    return null;
}

function tokenizeShell(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;

    const pushCurrent = () => {
        if (current.length > 0) {
            tokens.push(current);
            current = "";
        }
    };

    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        const next = command[i + 1];

        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === "'" || char === '"' || char === "`") {
            quote = char;
            continue;
        }

        if (char === "\n" || char === "\r") {
            pushCurrent();
            tokens.push(";");
            if (char === "\r" && next === "\n") i += 1;
            continue;
        }

        if (/\s/.test(char)) {
            pushCurrent();
            continue;
        }

        if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
            pushCurrent();
            tokens.push(`${char}${next}`);
            i += 1;
            continue;
        }

        if (char === ";") {
            pushCurrent();
            tokens.push(char);
            continue;
        }

        current += char;
    }

    pushCurrent();
    return tokens;
}

function commandSegments(tokens: string[]): string[][] {
    const segments: string[][] = [];
    let current: string[] = [];

    for (const token of tokens) {
        if (COMMAND_SEPARATORS.has(token)) {
            if (current.length > 0) {
                segments.push(current);
                current = [];
            }
            continue;
        }
        current.push(token);
    }

    if (current.length > 0) segments.push(current);
    return segments;
}

function stripCommandPrefixes(segment: string[]): string[] {
    let index = 0;

    while (index < segment.length) {
        const token = segment[index];

        if (isAssignment(token)) {
            index += 1;
            continue;
        }

        if (CONTROL_PREFIXES.has(token)) return [];

        if (token === "env") {
            index = skipEnv(segment, index + 1);
            continue;
        }

        if (token === "sudo") {
            index = skipOptions(segment, index + 1, OPTIONS_WITH_VALUES);
            continue;
        }

        if (token === "time") {
            index = skipOptions(segment, index + 1, TIME_OPTIONS_WITH_VALUES);
            continue;
        }

        if (token === "nice") {
            index = skipOptions(segment, index + 1, OPTIONS_WITH_VALUES);
            continue;
        }

        if (SIMPLE_WRAPPERS.has(token)) {
            index += 1;
            continue;
        }

        return segment.slice(index);
    }

    return [];
}

function skipEnv(segment: string[], start: number): number {
    let index = start;

    while (index < segment.length) {
        const token = segment[index];
        if (isAssignment(token)) {
            index += 1;
            continue;
        }

        if (!token.startsWith("-")) break;

        index += optionConsumesValue(token, OPTIONS_WITH_VALUES) ? 2 : 1;
    }

    return index;
}

function skipOptions(segment: string[], start: number, optionsWithValues: Set<string>): number {
    let index = start;

    while (index < segment.length) {
        const token = segment[index];
        if (!token.startsWith("-")) break;

        index += optionConsumesValue(token, optionsWithValues) ? 2 : 1;
    }

    return index;
}

function firstPatternArg(args: string[]): string | null {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (COMMAND_SEPARATORS.has(token)) break;
        if (isAssignment(token)) continue;

        if (token.startsWith("-")) {
            if (optionConsumesValue(token, OPTIONS_WITH_VALUES)) index += 1;
            continue;
        }

        if (isLikelyValue(token)) continue;

        return token;
    }

    return null;
}

function isAssignment(token: string): boolean {
    return ASSIGNMENT_RE.test(token);
}

function optionConsumesValue(token: string, optionsWithValues: Set<string>): boolean {
    return !token.includes("=") && optionsWithValues.has(token);
}

function isLikelyValue(token: string): boolean {
    return (
        token.startsWith(".") ||
        token.startsWith("/") ||
        token.startsWith("~") ||
        token.includes("/") ||
        /\.[a-zA-Z0-9]{1,8}$/.test(token)
    );
}

function parseIntegerMatch(match: RegExpMatchArray | null): number | null {
    if (!match) return null;

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseFloatMatch(match: RegExpMatchArray | null): number | null {
    if (!match) return null;

    const parsed = Number.parseFloat(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
}

function boundExcerpt(output: string): string {
    return output.length <= MAX_OUTPUT_EXCERPT_CHARS
        ? output
        : output.slice(0, MAX_OUTPUT_EXCERPT_CHARS).trimEnd();
}

function looksLikeError(output: string): boolean {
    return /\b(error|exception|failed|missing|not found|traceback)\b/i.test(output);
}
