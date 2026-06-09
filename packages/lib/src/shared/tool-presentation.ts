import type { ToolCategory } from "./dashboard-types.ts";

/** Lower-cased substring → category. First match wins; order matters only
 *  where substrings could overlap (none currently do). */
const CATEGORY_RULES: ReadonlyArray<readonly [ReadonlyArray<string>, ToolCategory]> = [
    [["websearch", "web_search", "webfetch", "web_fetch", "fetch"], "net"],
    [["multiedit", "edit", "write", "notebookedit"], "edit"],
    [["read"], "file"],
    [["bash", "shell", "exec"], "sh"],
    [["toolsearch", "grep", "glob", "search", "find"], "search"],
    [["task", "agent"], "agent"],
];

export function categoryOf(name: string): ToolCategory {
    const n = name.toLowerCase();
    for (const [needles, category] of CATEGORY_RULES) {
        if (needles.some((needle) => n.includes(needle))) return category;
    }
    return "other";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A single salient line summarising a tool call's arguments, chosen per tool
 *  family. Falls back to the first non-empty `key: value`, then `command`. */
export function argPreview(
    name: string,
    input: Record<string, unknown> | null,
    command: string | null,
): string {
    const i = input ?? {};
    switch (categoryOf(name)) {
        case "net": {
            const url = str(i.url) ?? str(i.query);
            if (url) return url;
            break;
        }
        case "file": {
            const path = str(i.file_path) ?? str(i.path);
            if (path) {
                const offset = num(i.offset);
                const limit = num(i.limit);
                return offset != null ? `${path}:${offset}${limit != null ? ` +${limit}` : ""}` : path;
            }
            break;
        }
        case "edit": {
            const path = str(i.file_path) ?? str(i.path);
            if (path) return path;
            break;
        }
        case "search": {
            const q = str(i.query) ?? str(i.pattern);
            if (q) return q;
            break;
        }
        case "agent": {
            const type = str(i.subagent_type) ?? str(i.agent_type);
            const desc = str(i.description) ?? str(i.message);
            if (type && desc) return `${type}: ${desc}`;
            if (type) return type;
            if (desc) return desc;
            break;
        }
        case "sh":
            if (command) return command;
            break;
        case "other":
            break;
    }
    for (const [key, value] of Object.entries(i)) {
        const s = typeof value === "string" ? value : JSON.stringify(value);
        if (s && s !== "\"\"" && s !== "{}" && s !== "null") return `${key}: ${s}`;
    }
    return command ?? "";
}
