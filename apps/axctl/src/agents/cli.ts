import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { optionValue } from "../config-core/cli-util.ts";
import { formatReconcileScoped } from "../config-core/reconcile.ts";
import { AgentSourceRegistryLive } from "./registry.ts";
import {
    readAllAgents,
    scopeAgent,
    removeAgent,
    parkAgent,
    unparkAgent,
    type AgentListRow,
} from "./config.ts";
import { reconcileAgents } from "./reconcile.ts";
import type { AgentScope } from "./source.ts";

/**
 * `ax agents` group: config/reconcile/scope/park/unpark/rm for agent definition
 * files. New top-level (hidden) group registered in cli/index.ts. Handlers
 * provide AgentSourceRegistryLive; SurrealClient/FileSystem/Path from AppLayer.
 */

const json = Flag.boolean("json").pipe(Flag.withDefault(false));

const fmt = (rows: ReadonlyArray<AgentListRow>): string =>
    rows
        .map((r) =>
            [
                r.name,
                r.scope,
                r.model ?? "-",
                r.skills.length ? `[${r.skills.join(",")}]` : "-",
                r.status,
            ].join("\t"),
        )
        .join("\n");

const configCommand = Command.make(
    "config",
    {
        scope: Flag.string("scope").pipe(Flag.optional),
        includeDeleted: Flag.boolean("include-deleted").pipe(Flag.withDefault(false)),
        json,
    },
    ({ scope, includeDeleted, json: asJson }) =>
        readAllAgents({
            scope: optionValue(scope) as AgentScope | undefined,
            includeDeleted,
        }).pipe(
            Effect.map((rows) => console.log(asJson ? prettyPrint(rows) : fmt(rows))),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("List agent definitions: name·scope·model·skills·status"));

const reconcileCommand = Command.make(
    "reconcile",
    { dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)), json },
    ({ dryRun, json: asJson }) =>
        reconcileAgents({ dryRun }).pipe(
            Effect.map((report) => console.log(asJson ? prettyPrint(report) : formatReconcileScoped(report))),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("Tombstone agent_def rows absent on disk; resurrect those present (--dry-run)"));

const scopeCommand = Command.make(
    "scope",
    {
        agent: Argument.string("agent"),
        skill: Flag.string("skill"),
        remove: Flag.boolean("remove").pipe(Flag.withDefault(false)),
    },
    ({ agent, skill, remove }) =>
        scopeAgent(agent, skill, { remove }).pipe(
            Effect.map((r) =>
                console.log(
                    `${r.changed ? "updated" : "unchanged"} ${agent}: skills=[${r.skills.join(",")}]`,
                ),
            ),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("Attach/detach a skill on an agent's skills: list (--skill <name> [--remove])"));

const parkCommand = Command.make(
    "park",
    { agent: Argument.string("agent") },
    ({ agent }) =>
        parkAgent(agent).pipe(
            Effect.map(() => console.log(`parked agent ${agent}`)),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("Disable an agent (move aside to .ax-parked)"));

const unparkCommand = Command.make(
    "unpark",
    { agent: Argument.string("agent"), scope: Flag.string("scope").pipe(Flag.withDefault("user")) },
    ({ agent, scope }) =>
        unparkAgent(agent, scope as AgentScope).pipe(
            Effect.map(() => console.log(`unparked agent ${agent}`)),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("Restore a parked agent (--scope user|project)"));

const rmCommand = Command.make(
    "rm",
    { agent: Argument.string("agent") },
    ({ agent }) =>
        removeAgent(agent).pipe(
            Effect.map(() => console.log(`removed agent ${agent}`)),
            Effect.provide(AgentSourceRegistryLive),
        ),
).pipe(Command.withDescription("Delete an agent definition file + tombstone the row"));

export const agentsCommand = Command.make("agents").pipe(
    Command.withDescription("Agent-definition front door: config, reconcile, scope, park/unpark, rm"),
    Command.withSubcommands([
        configCommand,
        reconcileCommand,
        scopeCommand,
        parkCommand,
        unparkCommand,
        rmCommand,
    ]),
);
