// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { prettyPrint } from "@ax/lib/json";
import { cmdDogfoodTerminal } from "../../dogfood/wterm.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, jsonFlag, optionValue, positiveLimit, requirePositiveInt, stringArg } from "./shared.ts";

const dogfoodTerminalCommand = Command.make(
    "terminal",
    {
        scenario: Flag.choice("scenario", ["axctl-setup", "interactive"] as const).pipe(Flag.withDefault("axctl-setup")),
        transport: Flag.choice("transport", ["auto", "pty", "process"] as const).pipe(Flag.withDefault("auto")),
        agent: Flag.choice("agent", ["shell", "claude", "codex", "opencode"] as const).pipe(Flag.optional),
        command: Flag.string("command").pipe(Flag.optional),
        successMarker: Flag.string("success-marker").pipe(Flag.optional),
        timeout: Flag.integer("timeout").pipe(Flag.optional),
        port: Flag.integer("port").pipe(Flag.withDefault(1742)),
        json: jsonFlag,
    },
    ({ scenario, transport, agent, command, successMarker, timeout, port, json }) =>
        Effect.promise(() =>
            cmdDogfoodTerminal([
                `--scenario=${scenario}`,
                `--transport=${transport}`,
                ...stringArg("agent", optionValue(agent)),
                ...stringArg("command", optionValue(command)),
                ...stringArg("success-marker", optionValue(successMarker)),
                ...(timeout._tag === "Some" ? [`--timeout=${timeout.value}`] : []),
                `--port=${port}`,
                ...boolArg("json", json),
            ]),
        ),
).pipe(Command.withDescription("Serve a wterm browser terminal dogfood scenario"));

const cmdDogfoodRuns = (input: { readonly limit: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("dogfood runs", "limit", input.limit);
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, run_id, scenario, driver, status, agent, command, transport,
                marker_found, timed_out, timeout_seconds,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at
            FROM dogfood_run
            ORDER BY ended_at DESC
            LIMIT ${limit};`,
        );
        const list = rows?.[0] ?? [];
        if (input.json) { console.log(prettyPrint(list)); return; }
        if (list.length === 0) {
            console.log("(no dogfood runs persisted yet)");
            return;
        }
        for (const row of list) {
            console.log(
                `${String(row.ended_at ?? "?")}  [${String(row.status ?? "?")}]  ` +
                `${String(row.scenario ?? "?")}  ${String(row.driver ?? "?")}  ` +
                `run_id=${String(row.run_id ?? "?")}`,
            );
        }
    });

const dogfoodRunsCommand = Command.make(
    "runs",
    {
        limit: positiveLimit(30),
        json: jsonFlag,
    },
    ({ limit, json }) => cmdDogfoodRuns({ limit, json }),
).pipe(Command.withDescription("List recent dogfood scenario runs (passed/failed/error)"));

export const dogfoodCommand = Command.make("dogfood").pipe(
    Command.withDescription("Run local dogfood harnesses"),
    Command.withSubcommands([dogfoodTerminalCommand, dogfoodRunsCommand]),
);

export const dogfoodRuntime: RuntimeManifest = {
    dogfood: "db",
};
