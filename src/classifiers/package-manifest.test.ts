import { describe, expect, test } from "bun:test";
import {
    CLASSIFIER_PACKAGE_SCHEMA,
    isClassifierPackageManifest,
    loadClassifierPackageManifest,
} from "./package-manifest.ts";

describe("classifier package manifest", () => {
    test("loads the example manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-verification-event/ax.classifier.json");

        expect(manifest.schema).toBe(CLASSIFIER_PACKAGE_SCHEMA);
        expect(manifest.key).toBe("verification-event");
        expect(manifest.labels).toContain("verification_request");
    });

    test("loads the direction-event package manifest", () => {
        const manifest = loadClassifierPackageManifest("packages/ax-classifier-direction-event/ax.classifier.json");

        expect(manifest.schema).toBe(CLASSIFIER_PACKAGE_SCHEMA);
        expect(manifest.key).toBe("direction-event");
        expect(manifest.package).toBe("@ax-classifier/direction-event");
        expect(manifest.targets).toContain("tooling_preference");
    });

    test("rejects incomplete manifest shapes", () => {
        expect(isClassifierPackageManifest({ schema: CLASSIFIER_PACKAGE_SCHEMA })).toBe(false);
    });
});
