import { describe, expect, it } from "bun:test";
import {
    ART_COLS,
    ART_ROWS,
    buildDitherGrid,
    fnv1a,
    mulberry32,
    type Tone,
} from "./dossier-card-art.tsx";

describe("fnv1a", () => {
    it("is deterministic and returns a uint32", () => {
        const a = fnv1a("How deep do you go?");
        const b = fnv1a("How deep do you go?");
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(0xffffffff);
        expect(Number.isInteger(a)).toBe(true);
    });

    it("differs for different inputs", () => {
        expect(fnv1a("a")).not.toBe(fnv1a("b"));
        expect(fnv1a("Busiest day?")).not.toBe(fnv1a("How many repos?"));
    });
});

describe("mulberry32", () => {
    it("produces the same stream for the same seed", () => {
        const r1 = mulberry32(12345);
        const r2 = mulberry32(12345);
        const s1 = [r1(), r1(), r1(), r1()];
        const s2 = [r2(), r2(), r2(), r2()];
        expect(s1).toEqual(s2);
    });

    it("stays within [0, 1)", () => {
        const r = mulberry32(fnv1a("seed"));
        for (let i = 0; i < 200; i++) {
            const v = r();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe("buildDitherGrid", () => {
    it("has the expected dimensions", () => {
        const grid = buildDitherGrid("Longest single run?");
        expect(grid.length).toBe(ART_ROWS);
        for (const row of grid) expect(row.length).toBe(ART_COLS);
    });

    it("is fully deterministic for the same seed (hydration-safe)", () => {
        const a = buildDitherGrid("When are you most alive?");
        const b = buildDitherGrid("When are you most alive?");
        expect(a).toEqual(b);
    });

    it("renders distinct topography for different seeds", () => {
        const a = buildDitherGrid("How deep do you go?");
        const b = buildDitherGrid("Tool failure rate?");
        // grids should not be identical - different seeds, different terrain
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    });

    it("only emits valid tone values 0..3", () => {
        const grid = buildDitherGrid("How many hands?");
        const seen = new Set<Tone>();
        for (const row of grid) {
            for (const cell of row) {
                expect([0, 1, 2, 3]).toContain(cell);
                seen.add(cell);
            }
        }
        // a real terrain field should use more than just bare panel
        expect(seen.size).toBeGreaterThan(1);
    });

    it("respects custom dimensions", () => {
        const grid = buildDitherGrid("x", 10, 4);
        expect(grid.length).toBe(4);
        expect(grid[0]!.length).toBe(10);
    });

    it("biases density toward the bottom (landscape, not flat noise)", () => {
        // average tone of the bottom third should exceed the top third
        const grid = buildDitherGrid("How many hands?");
        const third = Math.floor(ART_ROWS / 3);
        const avg = (rows: Tone[][]) => {
            let sum = 0;
            let n = 0;
            for (const row of rows) for (const c of row) { sum += c; n++; }
            return sum / n;
        };
        const top = avg(grid.slice(0, third));
        const bottom = avg(grid.slice(ART_ROWS - third));
        expect(bottom).toBeGreaterThan(top);
    });
});
