import { parse as parseYamlDocument } from "yaml";

export interface FrontmatterParseResult {
    readonly frontmatter: Record<string, unknown>;
    readonly rawFrontmatter: string | null;
    readonly body: string;
    readonly error?: string;
}

const FRONTMATTER_RE = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseLooseYamlObject(raw: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const value = m[2]!;
        if (value.length > 0) {
            out[key] = value.replace(/^["']|["']$/g, "");
            continue;
        }

        const items: string[] = [];
        while (i + 1 < lines.length) {
            const next = lines[i + 1]!;
            const item = next.match(/^\s+-\s+(.+)$/);
            if (!item) break;
            items.push(item[1]!.trim());
            i++;
        }
        if (items.length > 0) out[key] = items;
    }
    return out;
}

export function parseFrontmatter(content: string): FrontmatterParseResult {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return { frontmatter: {}, rawFrontmatter: null, body: content };

    const rawFrontmatter = match[1]!;
    const body = match[2]!;
    try {
        const parsed = parseYamlDocument(rawFrontmatter);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return {
                frontmatter: parsed as Record<string, unknown>,
                rawFrontmatter,
                body,
            };
        }
        return {
            frontmatter: {},
            rawFrontmatter,
            body,
            error: "frontmatter was not an object",
        };
    } catch (err) {
        return {
            frontmatter: parseLooseYamlObject(rawFrontmatter),
            rawFrontmatter,
            body,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
