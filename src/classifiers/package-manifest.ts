import { readFileSync } from "node:fs";
import { safeJsonParse } from "../lib/shared/safe-json.ts";
import type { ClassifierInputKind, ClassifierKind } from "./core.ts";

export const CLASSIFIER_PACKAGE_SCHEMA = "ax.classifier.v1";

export interface ClassifierPackageAsset {
    readonly id: string;
    readonly kind: "fixture" | "dataset" | "model" | "artifact";
    readonly path?: string;
    readonly url?: string;
    readonly sha256?: string;
    readonly optional?: boolean;
}

export interface ClassifierPackageManifest {
    readonly schema: typeof CLASSIFIER_PACKAGE_SCHEMA;
    readonly key: string;
    readonly version: string;
    readonly package: string;
    readonly entrypoint: string;
    readonly kind: ClassifierKind;
    readonly input: ClassifierInputKind;
    readonly description: string;
    readonly labels: readonly string[];
    readonly targets: readonly string[];
    readonly fixtures?: readonly string[];
    readonly assets?: readonly ClassifierPackageAsset[];
}

export function isClassifierPackageManifest(value: unknown): value is ClassifierPackageManifest {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.schema === CLASSIFIER_PACKAGE_SCHEMA &&
        typeof record.key === "string" &&
        typeof record.version === "string" &&
        typeof record.package === "string" &&
        typeof record.entrypoint === "string" &&
        typeof record.kind === "string" &&
        typeof record.input === "string" &&
        typeof record.description === "string" &&
        Array.isArray(record.labels) &&
        Array.isArray(record.targets);
}

export function loadClassifierPackageManifest(path: string): ClassifierPackageManifest {
    const parsed = safeJsonParse<unknown>(readFileSync(path, "utf8"));
    if (!isClassifierPackageManifest(parsed)) {
        throw new Error(`invalid classifier package manifest: ${path}`);
    }
    return parsed;
}
