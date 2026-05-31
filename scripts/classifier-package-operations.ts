import {
    loadClassifierPackageManifest,
} from "../src/classifiers/package-manifest.ts";
import {
    buildOperationsReport,
    writeOperationsReport,
    type ClassifierPackageOperationsReport,
} from "../src/classifiers/package-operations.ts";

function parseArgs(argv: readonly string[]): { manifest: string; operation?: string; out?: string; json: boolean } {
    let manifest = "packages/ax-classifier-session-sections/ax.classifier.json";
    let operation: string | undefined;
    let out: string | undefined;
    let json = false;
    for (const arg of argv) {
        if (arg === "--json") {
            json = true;
        } else if (arg.startsWith("--manifest=")) {
            manifest = arg.slice("--manifest=".length);
        } else if (arg.startsWith("--operation=")) {
            operation = arg.slice("--operation=".length);
        } else if (arg.startsWith("--out=")) {
            out = arg.slice("--out=".length);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { manifest, operation, out, json };
}

function printText(report: ClassifierPackageOperationsReport): void {
    console.log(`classifier package operations: ${report.package_key}`);
    console.log(`decision: ${report.decision}`);
    for (const operation of report.operations) {
        console.log(`- ${operation.id}: ${operation.command}`);
    }
    for (const failure of report.failures) {
        console.error(`failure: ${failure}`);
    }
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const manifest = loadClassifierPackageManifest(args.manifest);
        const report = buildOperationsReport(manifest, args.manifest, args.operation);
        if (args.out) {
            writeOperationsReport(args.out, report);
        }
        if (args.json) {
            console.log(JSON.stringify(report, null, 2));
        } else if (!args.out) {
            printText(report);
        }
        process.exit(report.decision === "operation_missing" ? 1 : 0);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
