/**
 * Deterministic content-type classifier for tool_call outputs.
 *
 * Pure function - no Effect, no DB. The ingest stage calls this per row.
 * Extension (from the tool input file_path) is the strongest, cheapest signal;
 * a lightweight content sniff handles Bash/exec output that has no path; a text
 * fallback closes the set. Magika (the spike probe) is deliberately absent -
 * group-level categories from ext+sniff were the trustworthy part of the spike.
 */

export type ContentCategory =
  | "json" | "code" | "diff" | "markdown" | "yaml" | "config"
  | "log" | "filelist" | "text" | "binary" | "empty" | "unknown";

export type ClassifyMethod = "extension" | "sniff" | "fallback" | "empty";

export interface ClassifyInput {
  /** file_path pulled from the tool input_json (Read/Edit/Write/NotebookEdit); null otherwise */
  readonly filePath: string | null;
  /** the output text (output_excerpt is fine - sniff is prefix-tolerant) */
  readonly output: string;
  /** tool name, used only to bias Grep/Glob toward filelist */
  readonly toolName?: string | null;
}

export interface ClassifyResult {
  readonly category: ContentCategory;
  readonly method: ClassifyMethod;
  readonly confidence: number;
  readonly fineLabel: string | null;
}

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "rb",
  "c", "h", "cpp", "hpp", "cc", "cs", "swift", "kt", "scala", "clj", "ex",
  "exs", "php", "sh", "bash", "zsh", "fish", "sql", "surql", "lua", "r",
  "dart", "vue", "svelte", "css", "scss", "sass", "less", "html", "xml",
]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar",
  "wasm", "so", "dylib", "dll", "bin", "exe", "woff", "woff2", "ttf", "mp4", "mov",
]);
const EXT_CATEGORY: ReadonlyArray<[ReadonlyArray<string>, ContentCategory]> = [
  [["json", "jsonl"], "json"],
  [["md", "mdx"], "markdown"],
  [["yaml", "yml"], "yaml"],
  [["toml", "ini", "env", "conf", "cfg"], "config"],
  [["log"], "log"],
  [["csv", "tsv", "txt"], "text"],
];
const DOTFILES = new Set([".gitignore", ".npmignore", ".dockerignore", ".env", ".editorconfig"]);

const extOf = (p: string): string => {
  const base = p.split("/").pop() ?? p;
  if (DOTFILES.has(base)) return "config__dotfile";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

const categoryForExt = (ext: string): ContentCategory | null => {
  if (ext === "config__dotfile") return "config";
  if (CODE_EXT.has(ext)) return "code";
  if (BINARY_EXT.has(ext)) return "binary";
  for (const [list, cat] of EXT_CATEGORY) {
    if (list.includes(ext)) return cat;
  }
  return null;
};

const DIFF_RE = /^(diff --git |@@ |Index: |--- )/m;
const GREP_HIT_RE = /^[^\s:]+:\d+:/;

const sniff = (output: string, toolName: string | null | undefined): ContentCategory | null => {
  const t = output.trimStart();
  if (DIFF_RE.test(t)) return "diff";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("#!")) return "code";
  const lines = output.split("\n").filter((l) => l.length > 0).slice(0, 20);
  if (lines.length >= 2) {
    const hits = lines.filter((l) => GREP_HIT_RE.test(l)).length;
    if (hits / lines.length >= 0.6) return "filelist";
  }
  if ((toolName === "Glob" || toolName === "Grep") && lines.length >= 2) return "filelist";
  return null;
};

export const classifyContentType = (input: ClassifyInput): ClassifyResult => {
  if (input.output.trim().length === 0) {
    return { category: "empty", method: "empty", confidence: 1.0, fineLabel: null };
  }
  if (input.filePath) {
    const ext = extOf(input.filePath);
    const cat = ext ? categoryForExt(ext) : null;
    if (cat) {
      return { category: cat, method: "extension", confidence: 0.95, fineLabel: ext.replace("config__dotfile", "dotfile") };
    }
  }
  const sniffed = sniff(input.output, input.toolName ?? null);
  if (sniffed) {
    return { category: sniffed, method: "sniff", confidence: 0.6, fineLabel: null };
  }
  return { category: "text", method: "fallback", confidence: 0.4, fineLabel: null };
};

/** The closed taxonomy - the derive stage upserts exactly these nodes. */
export const ALL_CONTENT_CATEGORIES: ReadonlyArray<ContentCategory> = [
  "json", "code", "diff", "markdown", "yaml", "config",
  "log", "filelist", "text", "binary", "empty", "unknown",
];
