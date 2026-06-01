import { describe, expect, test } from "bun:test";
import { formatClassifierList, listClassifiers } from "./list.ts";

describe("classifier list", () => {
    test("includes registered classifiers with fixture counts", () => {
        const rows = listClassifiers();
        const verification = rows.find((row) => row.key === "verification-event");
        const direction = rows.find((row) => row.key === "direction-event");

        expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining([
            "reaction-event",
            "direction-event",
            "correction-event",
            "verification-event",
        ]));
        expect(verification?.fixtureCases).toBe(6);
        expect(verification?.source).toBe("package");
        expect(verification?.packageName).toBe("@ax-classifier/verification-event");
        expect(direction?.fixtureCases).toBe(8);
        expect(direction?.source).toBe("package");
        expect(direction?.packageName).toBe("@ax-classifier/direction-event");
        expect(rows.filter((row) => !["verification-event", "direction-event"].includes(row.key)).every((row) => row.source === "built-in")).toBe(true);
    });

    test("formats a compact table", () => {
        const output = formatClassifierList(listClassifiers());

        expect(output).toContain("classifier");
        expect(output).toContain("verification-event");
        expect(output).toContain("verification_request -> test_required,output_required,regression_guard");
    });
});
