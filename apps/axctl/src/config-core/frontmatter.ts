import { parse as parseYaml } from "yaml";

/**
 * Shared markdown-frontmatter codec for SKILL.md, slash-command `.md`, and
 * agent definition `.md`. Parsing mirrors `ingest/skills.ts` (tolerant: falls
 * back to a line parser when YAML chokes on unquoted colons in descriptions).
 *
 * Mutation is a TARGETED TEXT SPLICE of one list key (e.g. `skills:`), never a
 * full YAML re-serialization - this preserves every other frontmatter key, the
 * body, comments, and hand formatting verbatim (the fidelity risk called out in
 * the plan). Only the touched list block is rewritten.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
    /** Decoded frontmatter object (best-effort). */
    readonly frontmatter: Record<string, unknown>;
    /** The document body after the closing `---`. */
    readonly body: string;
    /** True when a frontmatter block was present. */
    readonly hasFrontmatter: boolean;
}

function looseLineParse(raw: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (value !== "") {
            out[key!] = value!.replace(/^["']|["']$/g, "");
            continue;
        }
        const listItems: string[] = [];
        while (i + 1 < lines.length) {
            const next = lines[i + 1]!;
            const lm = next.match(/^\s+-\s+(.+)$/);
            if (!lm) break;
            listItems.push(lm[1]!.trim());
            i++;
        }
        if (listItems.length > 0) out[key!] = listItems;
    }
    return out;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
    const m = content.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: {}, body: content, hasFrontmatter: false };
    let fm: Record<string, unknown> = {};
    try {
        fm = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
    } catch {
        fm = looseLineParse(m[1]!);
    }
    return { frontmatter: fm, body: m[2] ?? "", hasFrontmatter: true };
}

/** Read a string-list frontmatter key (e.g. `skills:`). Tolerates scalar→[scalar]. */
export function readList(fm: Record<string, unknown>, key: string): string[] {
    const raw = fm[key];
    if (raw === undefined || raw === null || raw === "") return [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Return `content` with frontmatter list `key` set to `items` (block style:
 * `key:\n  - a\n  - b`). Inserts a frontmatter block if none exists; drops the
 * key entirely when `items` is empty. Everything else is preserved byte-for-byte.
 */
export function setFrontmatterList(content: string, key: string, items: readonly string[]): string {
    const block =
        items.length === 0
            ? null
            : `${key}:\n${items.map((i) => `  - ${i}`).join("\n")}`;

    const m = content.match(FRONTMATTER_RE);
    if (!m) {
        // No frontmatter: synthesize a minimal block above the body.
        return block === null ? content : `---\n${block}\n---\n${content}`;
    }

    const fmText = m[1]!;
    const body = m[2] ?? "";
    const lines = fmText.split("\n");
    const out: string[] = [];
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const keyLine = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
        if (keyLine && keyLine[1] === key) {
            // Skip this key line + any inline value + following `  - ` list lines.
            while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1]!)) i++;
            if (block !== null && !replaced) {
                out.push(block);
                replaced = true;
            }
            continue;
        }
        out.push(line);
    }
    if (block !== null && !replaced) out.push(block);
    return `---\n${out.join("\n")}\n---\n${body}`;
}
