#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import {
    PROVIDER_PARITY_FEATURES,
    PROVIDER_PARITY_PROVIDERS,
} from "../src/ingest/provider-parity.ts";

const schemaTables = (): Set<string> => {
    const schema = schemaSurql;
    return new Set(
        [...schema.matchAll(/^DEFINE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)/gm)]
            .map((match) => match[1]!),
    );
};

const fail = (message: string): never => {
    process.stderr.write(`[check-provider-parity] ${message}\n`);
    process.exit(1);
};

const assertEvidence = (
    kind: "read" | "writer",
    feature: string,
    provider: string | null,
    path: string,
    contains: string,
) => {
    const label = provider ? `${feature}/${provider}` : feature;
    if (!existsSync(path)) fail(`${label} ${kind} evidence file does not exist: ${path}`);
    const text = readFileSync(path, "utf8");
    if (!text.includes(contains)) {
        fail(`${label} ${kind} evidence missing ${JSON.stringify(contains)} in ${path}`);
    }
};

const main = () => {
    const tables = schemaTables();
    const gaps = new Map<string, number>([
        ["raw-signal-unavailable", 0],
        ["extractor-not-implemented", 0],
    ]);

    for (const feature of PROVIDER_PARITY_FEATURES) {
        for (const table of [...feature.sharedRecords, ...(feature.relatedRecords ?? [])]) {
            if (!tables.has(table)) fail(`${feature.key} references missing schema table: ${table}`);
        }

        if (feature.readEvidence.length === 0) fail(`${feature.key} has no read evidence`);
        for (const evidence of feature.readEvidence) {
            assertEvidence("read", feature.key, null, evidence.path, evidence.contains);
        }

        for (const provider of PROVIDER_PARITY_PROVIDERS) {
            const cell = feature.providers[provider];
            if (cell.note.trim().length === 0) fail(`${feature.key}/${provider} has an empty note`);

            if (cell.status === "supported") {
                if ((cell.writerEvidence?.length ?? 0) === 0) {
                    fail(`${feature.key}/${provider} claims support without writer evidence`);
                }
                for (const evidence of cell.writerEvidence ?? []) {
                    assertEvidence("writer", feature.key, provider, evidence.path, evidence.contains);
                }
                continue;
            }

            gaps.set(cell.status, (gaps.get(cell.status) ?? 0) + 1);
            if ((cell.writerEvidence?.length ?? 0) > 0) {
                fail(`${feature.key}/${provider} is a gap but also has writer evidence`);
            }
        }
    }

    for (const [status, count] of gaps) {
        if (count === 0) fail(`matrix does not contain any ${status} gaps`);
    }

    process.stdout.write(
        `[check-provider-parity] OK (${PROVIDER_PARITY_FEATURES.length} features, ${PROVIDER_PARITY_PROVIDERS.length} providers)\n`,
    );
};

main();
