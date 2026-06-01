import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import {
    PROVIDER_PARITY_FEATURE_KEYS,
    PROVIDER_PARITY_FEATURES,
    PROVIDER_PARITY_PROVIDERS,
} from "./provider-parity.ts";

const definedSchemaTables = (): Set<string> => {
    const schema = schemaSurql;
    return new Set(
        [...schema.matchAll(/^DEFINE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)/gm)]
            .map((match) => match[1]!),
    );
};

const fileText = (path: string): string => readFileSync(path, "utf8");

describe("provider parity matrix", () => {
    test("covers the first-class providers and required feature surfaces", () => {
        expect(PROVIDER_PARITY_PROVIDERS).toEqual([
            "claude",
            "codex",
            "pi",
            "opencode",
            "cursor",
        ]);
        expect(PROVIDER_PARITY_FEATURES.map((feature) => feature.key)).toEqual([
            ...PROVIDER_PARITY_FEATURE_KEYS,
        ]);

        for (const feature of PROVIDER_PARITY_FEATURES) {
            expect(Object.keys(feature.providers).sort()).toEqual([
                ...PROVIDER_PARITY_PROVIDERS,
            ].sort());
        }
    });

    test("references only schema-defined shared graph records", () => {
        const tables = definedSchemaTables();

        for (const feature of PROVIDER_PARITY_FEATURES) {
            for (const table of [...feature.sharedRecords, ...(feature.relatedRecords ?? [])]) {
                expect(tables.has(table), `${feature.key} references missing table ${table}`)
                    .toBe(true);
            }
        }
    });

    test("claimed support points at writer evidence and shared read surfaces", () => {
        for (const feature of PROVIDER_PARITY_FEATURES) {
            expect(feature.readEvidence.length, `${feature.key} must document a read path`)
                .toBeGreaterThan(0);

            for (const evidence of feature.readEvidence) {
                expect(existsSync(evidence.path), `missing read evidence file ${evidence.path}`)
                    .toBe(true);
                expect(fileText(evidence.path), `${feature.key} read evidence missing ${evidence.contains}`)
                    .toContain(evidence.contains);
            }

            for (const provider of PROVIDER_PARITY_PROVIDERS) {
                const cell = feature.providers[provider];
                expect(cell.note.trim().length, `${feature.key}/${provider} must explain its status`)
                    .toBeGreaterThan(0);

                if (cell.status !== "supported") {
                    expect(
                        cell.writerEvidence?.length ?? 0,
                        `${feature.key}/${provider} gap should not claim writer evidence`,
                    ).toBe(0);
                    continue;
                }

                expect(
                    cell.writerEvidence?.length ?? 0,
                    `${feature.key}/${provider} support must point at writer evidence`,
                ).toBeGreaterThan(0);

                for (const evidence of cell.writerEvidence ?? []) {
                    expect(existsSync(evidence.path), `missing writer evidence file ${evidence.path}`)
                        .toBe(true);
                    expect(fileText(evidence.path), `${feature.key}/${provider} writer evidence missing ${evidence.contains}`)
                        .toContain(evidence.contains);
                }
            }
        }
    });

    test("intentional gaps distinguish raw signal absence from extractor backlog", () => {
        const gapStatuses = new Set(["raw-signal-unavailable", "extractor-not-implemented"]);
        const gaps = PROVIDER_PARITY_FEATURES.flatMap((feature) =>
            PROVIDER_PARITY_PROVIDERS.map((provider) => ({
                feature,
                provider,
                cell: feature.providers[provider],
            })),
        ).filter(({ cell }) => cell.status !== "supported");

        expect(gaps.length).toBeGreaterThan(0);
        expect(gaps.some(({ cell }) => cell.status === "raw-signal-unavailable")).toBe(true);
        expect(gaps.some(({ cell }) => cell.status === "extractor-not-implemented")).toBe(true);

        for (const { feature, provider, cell } of gaps) {
            expect(
                gapStatuses.has(cell.status),
                `${feature.key}/${provider} uses an unsupported gap status ${cell.status}`,
            ).toBe(true);
        }
    });
});
