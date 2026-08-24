import { describe, expect, it } from "bun:test";
import { rootCommand } from "../index.ts";
import {
    COMMAND_SURFACES,
    DEFAULT_COMMANDS,
    VISIBLE_COMMANDS,
} from "./visible-commands.ts";

const topLevelCommands = () => rootCommand.subcommands.flatMap((group) => group.commands);

describe("public command surfaces", () => {
    it("shows exactly the twelve core commands in default help", () => {
        const help = Bun.spawnSync(["bun", "apps/axctl/src/cli/index.ts", "help"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(help.exitCode).toBe(0);
        const lines = help.stdout.toString().split("\n");
        const start = lines.findIndex((line) => line.trim() === "SUBCOMMANDS");
        const visible = lines
            .slice(start + 1)
            .filter((line) => /^\s{2,}[a-z]/.test(line))
            .map((line) => line.trim().split(/\s+/)[0]!);

        expect(visible).toEqual([...DEFAULT_COMMANDS]);
        expect(visible).toHaveLength(12);
    });

    it("keeps every public command in one surface", () => {
        const names = Object.values(COMMAND_SURFACES).flat();
        expect(new Set(names).size).toBe(names.length);
        expect(VISIBLE_COMMANDS).toEqual(names);
    });

    it("keeps non-default surfaces callable by exact name", () => {
        const byName = new Map(topLevelCommands().map((command) => [command.name, command]));

        for (const name of [
            COMMAND_SURFACES.advanced[0],
            COMMAND_SURFACES.service[0],
            COMMAND_SURFACES.compatibility[0],
        ]) {
            expect(byName.has(name), `${name} is not registered`).toBe(true);
            expect(byName.get(name)?.hidden, `${name} left shell completion`).toBe(false);
        }
    });
});
