import { readFileSync } from "node:fs";

export const ACTIVE_PRODUCT_DOCS = [
    "README.md",
    "CONTEXT.md",
    "docs/how-ax-sees-your-work.mdx",
    "docs/development.md",
    "docs/metrics.md",
    "docs/instrumentation.md",
    "docs/HOOKS.md",
    "docs/language.md",
    "docs/manifesto.md",
    "docs/images/retro-loop.svg",
    "apps/axctl/package.json",
    "apps/site/public/llms.txt",
    "apps/site/app/routes/how-it-works.tsx",
    "apps/site/app/routes/docs/-cli-reference.data.ts",
] as const;

type Rule = {
    readonly name: string;
    readonly pattern: RegExp;
};

const RETIRED_CLAIM_RULES: readonly Rule[] = [
    { name: "retired SurrealDB store", pattern: /SurrealDB/i },
    { name: "retired database port", pattern: /127\.0\.0\.1:8521|\b8521\b/ },
    { name: "retired calendar checkpoint", pattern: /t\+7\s*\/\s*t\+30\s*\/\s*t\+90/i },
    { name: "retired five-harness count", pattern: /\bfive harness(?:es)?\b/i },
    { name: "retired Stop-hook workflow", pattern: /Stop hook (?:fires|on session-end|asks|just calls|turns every|is the only)/i },
];

const REQUIRED_CLAIMS: Readonly<Record<string, readonly string[]>> = {
    "README.md": ["Six harnesses", "DuckDB", "SQLite", "3, 10, and 30 sessions"],
    "docs/how-ax-sees-your-work.mdx": ["published DuckDB snapshot", "SQLite judgment sidecar", "ax otlpd"],
    "docs/development.md": ["AX_NO_AUTO_INGEST=1", "ax otlpd", "ax studio"],
};

export type ProductDocViolation = {
    readonly path: string;
    readonly message: string;
};

export function checkCurrentProductDocs(
    documents: Readonly<Record<string, string>>,
): readonly ProductDocViolation[] {
    const violations: ProductDocViolation[] = [];

    for (const [path, text] of Object.entries(documents)) {
        for (const rule of RETIRED_CLAIM_RULES) {
            if (rule.pattern.test(text)) {
                violations.push({ path, message: rule.name });
            }
        }

        for (const claim of REQUIRED_CLAIMS[path] ?? []) {
            if (!text.includes(claim)) {
                violations.push({ path, message: `missing current claim: ${claim}` });
            }
        }
    }

    return violations;
}

export function readActiveProductDocs(): Readonly<Record<string, string>> {
    return Object.fromEntries(ACTIVE_PRODUCT_DOCS.map((path) => [path, readFileSync(path, "utf8")]));
}

if (import.meta.main) {
    const violations = checkCurrentProductDocs(readActiveProductDocs());
    if (violations.length > 0) {
        console.error("Current product documents contain stale claims:");
        for (const violation of violations) {
            console.error(`  ${violation.path}: ${violation.message}`);
        }
        process.exit(1);
    }

    console.log(`Current product contract is valid in ${ACTIVE_PRODUCT_DOCS.length} active documents.`);
}
