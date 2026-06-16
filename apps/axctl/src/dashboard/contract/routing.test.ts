import { afterEach, describe, expect, it } from "bun:test";
import { writesAllowed } from "./routing.ts";

const orig = process.env.AX_SERVE_HOST;
afterEach(() => {
    if (orig === undefined) delete process.env.AX_SERVE_HOST;
    else process.env.AX_SERVE_HOST = orig;
});

describe("routing write loopback gate", () => {
    it("allows writes when AX_SERVE_HOST is unset (default 127.0.0.1 bind)", () => {
        delete process.env.AX_SERVE_HOST;
        expect(writesAllowed()).toBe(true);
    });
    it("allows writes on explicit loopback hosts", () => {
        for (const h of ["127.0.0.1", "localhost", "::1"]) {
            process.env.AX_SERVE_HOST = h;
            expect(writesAllowed()).toBe(true);
        }
    });
    it("blocks writes when bound to 0.0.0.0 (LAN exposure)", () => {
        process.env.AX_SERVE_HOST = "0.0.0.0";
        expect(writesAllowed()).toBe(false);
    });
    it("blocks writes when bound to a LAN IP", () => {
        process.env.AX_SERVE_HOST = "192.168.1.50";
        expect(writesAllowed()).toBe(false);
    });
});
