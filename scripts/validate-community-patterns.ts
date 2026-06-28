/**
 * PR gate for community/patterns/<category>/<name>.json contributions.
 * Each file must be exactly one ProfileV1 taste-pattern entry, with the
 * category/name encoded in the path and no collision with an existing base
 * branch file.
 */
import { Schema } from "effect";
import { PATTERN_CATEGORIES, TastePattern } from "../apps/axctl/src/profile/schema.ts";

const CATEGORY_SET = new Set<string>(PATTERN_CATEGORIES);
const REL_RE = /^community\/patterns\/([a-z0-9-]+)\/([a-z0-9-]+)\.json$/;

export interface ValidatePatternFilesInput {
    readonly files: readonly string[];
    readonly baseDir?: string;
    readonly headDir?: string;
}

const decodeTastePattern = Schema.decodeUnknownSync(TastePattern);

const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/");

const relativeToHead = (path: string, headDir: string): string => {
    const normalized = normalizePath(path);
    const head = normalizePath(headDir).replace(/\/$/, "");
    if (head !== "" && normalized.startsWith(`${head}/`)) return normalized.slice(head.length + 1);
    const marker = "community/patterns/";
    const idx = normalized.indexOf(marker);
    return idx >= 0 ? normalized.slice(idx) : normalized;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text());

export async function validatePatternFiles(input: ValidatePatternFilesInput): Promise<string[]> {
    const errors: string[] = [];
    const baseDir = input.baseDir ?? ".";
    const headDir = input.headDir ?? ".";

    for (const file of input.files) {
        const rel = relativeToHead(file, headDir);
        const name = rel.split("/").pop() ?? rel;
        const match = REL_RE.exec(rel);
        if (match === null) {
            errors.push(`${name}: path must be community/patterns/<category>/<name>.json`);
            continue;
        }
        const [, category, stem] = match;
        if (!CATEGORY_SET.has(category)) {
            errors.push(`${rel}: unknown category "${category}"`);
        }

        let raw: unknown;
        try {
            raw = await readJson(file);
        } catch (e) {
            errors.push(`${rel}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
            continue;
        }

        let pattern: TastePattern | null = null;
        try {
            pattern = decodeTastePattern(raw);
        } catch (e) {
            errors.push(`${rel}: invalid taste pattern (${e instanceof Error ? e.message : String(e)})`);
        }

        if (pattern !== null) {
            if (pattern.category !== category) {
                errors.push(`${rel}: category must match directory ("${category}")`);
            }
            if (pattern.name !== stem) {
                errors.push(`${rel}: name must match filename ("${stem}")`);
            }
        }

        const basePath = `${baseDir.replace(/\/$/, "")}/${rel}`;
        if (await Bun.file(basePath).exists()) {
            errors.push(`${rel}: pattern already exists upstream; extend or link the existing pattern instead`);
        }
    }

    return errors;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const baseArg = args.find((a) => a.startsWith("--base="));
    const headArg = args.find((a) => a.startsWith("--head="));
    const files = args.filter((a) => !a.startsWith("--"));
    if (files.length === 0) {
        console.error("usage: bun scripts/validate-community-patterns.ts [--base=.] [--head=pr-head] <file>...");
        process.exit(2);
    }

    const errors = await validatePatternFiles({
        files,
        baseDir: baseArg?.slice("--base=".length) ?? ".",
        headDir: headArg?.slice("--head=".length) ?? ".",
    });
    for (const e of errors) console.error(e);
    if (errors.length > 0) process.exit(1);
    console.log(`${files.length} community pattern file(s) valid.`);
}
