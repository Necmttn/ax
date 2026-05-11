import { describe, expect, test } from "bun:test";
import { rootCommand } from "./index.ts";

describe("effect cli", () => {
    test("root command exposes the public subcommands", () => {
        const names = rootCommand.subcommands.flatMap((group) =>
            group.commands.map((command) => command.name),
        );

        expect(names).toEqual(expect.arrayContaining([
            "ingest",
            "insights",
            "dashboard",
            "project",
            "version",
            "update",
            "daemon",
            "doctor",
        ]));
    });
});
