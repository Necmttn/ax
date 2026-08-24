#!/usr/bin/env bun

export const DOC_STATES = [
    "current",
    "decision",
    "historical",
    "experiment",
    "evidence",
    "release",
    "generated",
    "asset",
] as const;

type DocState = (typeof DOC_STATES)[number];

export interface DocCatalog {
    readonly version: number;
    readonly states: readonly string[];
    readonly collectionDefaults: readonly { readonly prefix: string; readonly status: string }[];
    readonly currentFiles: readonly string[];
    readonly overrides: readonly {
        readonly path: string;
        readonly status: string;
        readonly reason: string;
    }[];
}

function isDocState(value: string): value is DocState {
    return (DOC_STATES as readonly string[]).includes(value);
}

export function validateDocCatalog(catalog: DocCatalog, files: readonly string[]): string[] {
    const errors: string[] = [];
    const fileSet = new Set(files);
    const currentSet = new Set(catalog.currentFiles);
    const overrideMap = new Map(catalog.overrides.map((item) => [item.path, item]));

    if (catalog.version !== 1) errors.push(`unsupported catalog version: ${catalog.version}`);
    if (new Set(catalog.states).size !== DOC_STATES.length || DOC_STATES.some((state) => !catalog.states.includes(state))) {
        errors.push("catalog states do not match the supported state set");
    }

    for (const item of catalog.collectionDefaults) {
        if (!item.prefix.startsWith("docs/") || !item.prefix.endsWith("/")) {
            errors.push(`invalid collection prefix: ${item.prefix}`);
        }
        if (!isDocState(item.status)) errors.push(`unknown state for ${item.prefix}: ${item.status}`);
    }

    for (const path of catalog.currentFiles) {
        if (!fileSet.has(path)) errors.push(`current file does not exist: ${path}`);
        if (overrideMap.has(path)) errors.push(`file is both current and overridden: ${path}`);
    }

    for (const item of catalog.overrides) {
        if (!fileSet.has(item.path)) errors.push(`override file does not exist: ${item.path}`);
        if (!isDocState(item.status)) errors.push(`unknown state for ${item.path}: ${item.status}`);
        if (item.reason.trim().length === 0) errors.push(`override has no reason: ${item.path}`);
    }

    for (const file of files) {
        const explicitCount = Number(currentSet.has(file)) + Number(overrideMap.has(file));
        const defaults = catalog.collectionDefaults.filter((item) => file.startsWith(item.prefix));
        if (explicitCount === 0 && defaults.length === 0) errors.push(`document has no state: ${file}`);
        if (explicitCount === 0 && defaults.length > 1) errors.push(`document has overlapping defaults: ${file}`);
    }

    return errors;
}

function listDocumentFiles(): string[] {
    const result = Bun.spawnSync([
        "git",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "docs",
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
    return result.stdout.toString().trim().split("\n").filter(Boolean).sort();
}

async function main(): Promise<void> {
    const catalog = await Bun.file("docs/catalog.json").json() as DocCatalog;
    const errors = validateDocCatalog(catalog, listDocumentFiles());
    if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
    }
    console.log(`document catalog: ok (${listDocumentFiles().length} files)`);
}

if (import.meta.main) await main();
