#!/usr/bin/env bun

export const RETIRED_ACTIVE_COMMANDS = [
    "axctl serve",
    "ax daemon start",
] as const;

export function findRetiredCommandCopy(files: Readonly<Record<string, string>>): string[] {
    const errors: string[] = [];
    for (const [path, content] of Object.entries(files)) {
        for (const command of RETIRED_ACTIVE_COMMANDS) {
            if (content.includes(command)) errors.push(`${path}: retired command: ${command}`);
        }
    }
    return errors;
}

export function validatePackageScripts(
    path: string,
    scripts: Readonly<Record<string, string>>,
): string[] {
    const errors: string[] = [];
    if ("search" in scripts) errors.push(`${path}: ambiguous search script`);
    if ("serve" in scripts) errors.push(`${path}: retired serve script`);
    for (const [name, command] of Object.entries(scripts)) {
        if (command.includes("apps/axctl/src/dashboard/web/vite.config.ts")) {
            errors.push(`${path}: ${name} uses a missing dashboard Vite config`);
        }
    }
    return errors;
}

const ACTIVE_COPY_FILES = [
    "README.md",
    "CONTEXT.md",
    "docs/HOOKS.md",
    "docs/development.md",
    "docs/instrumentation.md",
    "docs/language.md",
    "apps/studio/src/Shell.tsx",
    "apps/site/app/components/landing-v2/open-source-section.tsx",
    "apps/site/app/routes/docs/-cli-reference.data.ts",
] as const;

async function main(): Promise<void> {
    const contents = Object.fromEntries(
        await Promise.all(ACTIVE_COPY_FILES.map(async (path) => [path, await Bun.file(path).text()] as const)),
    );
    const root = await Bun.file("package.json").json() as { scripts?: Record<string, string> };
    const cli = await Bun.file("apps/axctl/package.json").json() as { scripts?: Record<string, string> };
    const errors = [
        ...findRetiredCommandCopy(contents),
        ...validatePackageScripts("package.json", root.scripts ?? {}),
        ...validatePackageScripts("apps/axctl/package.json", cli.scripts ?? {}),
    ];
    if (errors.length > 0) {
        console.error(errors.join("\n"));
        process.exit(1);
    }
    console.log("active command copy: ok");
}

if (import.meta.main) await main();
