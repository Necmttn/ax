import { afterEach, describe, expect, test } from "bun:test";
import { validateUserFile } from "./validate-community-users.ts";

const dir = `/tmp/ax-community-validate-${process.pid}`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const write = async (name: string, content: unknown): Promise<string> => {
    const path = `${dir}/community/users/${name}`;
    await Bun.write(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
};

describe("validateUserFile", () => {
    test("accepts a valid registration matching the author", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc123", joined: "2026-06-12" });
        expect(await validateUserFile(p, "necmttn")).toEqual([]);
    });

    test("author mismatch rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12" });
        const errs = await validateUserFile(p, "someone-else");
        expect(errs.some((e) => e.includes("author"))).toBe(true);
    });

    test("filename / github mismatch rejected", async () => {
        const p = await write("other.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12" });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("filename"))).toBe(true);
    });

    test("unknown fields rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12", admin: true });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("unknown field"))).toBe(true);
    });

    test("bad joined date rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "yesterday" });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("joined"))).toBe(true);
    });

    test("malformed json rejected without throwing", async () => {
        const p = await write("necmttn.json", "{nope");
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.length).toBeGreaterThan(0);
    });

    test("uppercase login normalizes: file lowercase, github field case-insensitive", async () => {
        const p = await write("necmttn.json", { github: "Necmttn", gist_id: "abc", joined: "2026-06-12" });
        expect(await validateUserFile(p, "Necmttn")).toEqual([]);
    });
});
