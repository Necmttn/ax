import { Effect, FileSystem, type PlatformError } from "effect";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import type { ClassifierInputKind, ClassifierKind } from "./core.ts";

export const CLASSIFIER_PACKAGE_SCHEMA = "ax.classifier.v1";
const CLASSIFIER_KINDS = new Set<ClassifierKind>(["heuristic", "manual", "local_model", "llm_review"]);
const CLASSIFIER_INPUTS = new Set<ClassifierInputKind>(["event_window", "turn", "session", "tool_call"]);
const CLASSIFIER_ASSET_KINDS = new Set<ClassifierPackageAsset["kind"]>(["fixture", "dataset", "model", "artifact"]);
const CLASSIFIER_OPERATION_KINDS = new Set<ClassifierPackageOperationKind>(["train", "eval", "review", "status", "publish", "debug"]);

export type ClassifierPackageOperationKind = "train" | "eval" | "review" | "status" | "publish" | "debug";

export interface ClassifierPackageAsset {
    readonly id: string;
    readonly kind: "fixture" | "dataset" | "model" | "artifact";
    readonly path?: string;
    readonly url?: string;
    readonly sha256?: string;
    readonly optional?: boolean;
}

export interface ClassifierPackageOperation {
    readonly id: string;
    readonly kind: ClassifierPackageOperationKind;
    readonly description: string;
    readonly command: string;
    readonly inputs?: readonly string[];
    readonly outputs?: readonly string[];
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
    readonly operations?: readonly ClassifierPackageOperation[];
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isClassifierPackageAsset(value: unknown): value is ClassifierPackageAsset {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const hasLocation = typeof record.path === "string" || typeof record.url === "string";
    const hasValidOptional = record.optional === undefined || typeof record.optional === "boolean";
    const hasValidSha = record.sha256 === undefined || typeof record.sha256 === "string";
    return typeof record.id === "string" &&
        typeof record.kind === "string" &&
        CLASSIFIER_ASSET_KINDS.has(record.kind as ClassifierPackageAsset["kind"]) &&
        hasLocation &&
        hasValidOptional &&
        hasValidSha;
}

function isClassifierPackageOperation(value: unknown): value is ClassifierPackageOperation {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === "string" &&
        typeof record.kind === "string" &&
        CLASSIFIER_OPERATION_KINDS.has(record.kind as ClassifierPackageOperationKind) &&
        typeof record.description === "string" &&
        typeof record.command === "string" &&
        (record.inputs === undefined || isStringArray(record.inputs)) &&
        (record.outputs === undefined || isStringArray(record.outputs));
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
        CLASSIFIER_KINDS.has(record.kind as ClassifierKind) &&
        typeof record.input === "string" &&
        CLASSIFIER_INPUTS.has(record.input as ClassifierInputKind) &&
        typeof record.description === "string" &&
        isStringArray(record.labels) &&
        isStringArray(record.targets) &&
        (record.fixtures === undefined || isStringArray(record.fixtures)) &&
        (record.assets === undefined || (Array.isArray(record.assets) && record.assets.every(isClassifierPackageAsset))) &&
        (record.operations === undefined || (Array.isArray(record.operations) && record.operations.every(isClassifierPackageOperation)));
}

export function loadClassifierPackageManifest(
    path: string,
): Effect.Effect<ClassifierPackageManifest, PlatformError.PlatformError | Error, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parsed = safeJsonParse<unknown>(yield* fs.readFileString(path));
        if (!isClassifierPackageManifest(parsed)) {
            return yield* Effect.fail(new Error(`invalid classifier package manifest: ${path}`));
        }
        return parsed;
    });
}

export function listClassifierPackageOperations(manifest: ClassifierPackageManifest): readonly ClassifierPackageOperation[] {
    return manifest.operations ?? [];
}

export function findClassifierPackageOperation(
    manifest: ClassifierPackageManifest,
    operationId: string,
): ClassifierPackageOperation | undefined {
    return listClassifierPackageOperations(manifest).find((operation) => operation.id === operationId);
}

export function requireClassifierPackageOperation(
    manifest: ClassifierPackageManifest,
    operationId: string,
): ClassifierPackageOperation {
    const operation = findClassifierPackageOperation(manifest, operationId);
    if (!operation) {
        throw new Error(`classifier package ${manifest.key} does not declare operation: ${operationId}`);
    }
    return operation;
}
