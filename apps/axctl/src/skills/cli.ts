import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { optionValue } from "../config-core/cli-util.ts";
import { formatReconcile } from "../config-core/reconcile.ts";
import { reconcileSkills } from "./reconcile.ts";
import { SkillSourceRegistryLive } from "./sources/registry.ts";
import {
    readAllSkills,
    removeSkill,
    parkSkill,
    unparkSkill,
    scopeSkill,
    type SkillConfigRow,
    type SkillStatus,
} from "./config.ts";
import type { SkillScope } from "./sources/types.ts";
import { AgentSourceRegistryLive } from "../agents/registry.ts";
import { findAgent } from "../agents/config.ts";

/**
 * `ax skills` lifecycle subcommands: config (list+status), reconcile, scope,
 * park/unpark, rm. Spliced into the existing `skillsCommand` group. Handlers
 * provide SkillSourceRegistryLive (+ AgentSourceRegistryLive for scope);
 * SurrealClient/FileSystem/Path come from AppLayer.
 */

const json = Flag.boolean("json").pipe(Flag.withDefault(false));

const fmt = (rows: ReadonlyArray<SkillConfigRow>): string =>
    rows
        .map((r) =>
            [
                r.name,
                r.source,
                r.scopeTag,
                r.agents.length ? `[${r.agents.join(",")}]` : "-",
                String(r.fired),
                r.status,
            ].join("\t"),
        )
        .join("\n");

const configCommand = Command.make(
    "config",
    {
        source: Flag.string("source").pipe(Flag.optional),
        scope: Flag.string("scope").pipe(Flag.optional),
        status: Flag.string("status").pipe(Flag.optional),
        includeDeleted: Flag.boolean("include-deleted").pipe(Flag.withDefault(false)),
        json,
    },
    ({ source, scope, status, includeDeleted, json: asJson }) =>
        readAllSkills({
            source: optionValue(source),
            scope: optionValue(scope),
            status: optionValue(status) as SkillStatus | undefined,
            includeDeleted,
        }).pipe(
            Effect.map((rows) => console.log(asJson ? prettyPrint(rows) : fmt(rows))),
            Effect.provide(SkillSourceRegistryLive),
        ),
).pipe(Command.withDescription("List skills: name·source·scope·agents·fired·status(live/orphan/parked)"));

const reconcileCommand = Command.make(
    "reconcile",
    { dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)), json },
    ({ dryRun, json: asJson }) =>
        reconcileSkills({ dryRun }).pipe(
            Effect.map((report) => console.log(asJson ? prettyPrint(report) : formatReconcile(report))),
            Effect.provide(SkillSourceRegistryLive),
        ),
).pipe(Command.withDescription("Tombstone skill rows absent on disk; resurrect those present (--dry-run)"));

const scopeCommand = Command.make(
    "scope",
    {
        skill: Argument.string("skill"),
        agent: Flag.string("agent"),
        remove: Flag.boolean("remove").pipe(Flag.withDefault(false)),
    },
    ({ skill, agent, remove }) =>
        findAgent(agent).pipe(
            Effect.provide(AgentSourceRegistryLive),
            Effect.flatMap((rec) => scopeSkill(skill, rec.dirPath, { remove })),
            Effect.map((r) =>
                console.log(
                    `${r.changed ? "updated" : "unchanged"} agent ${agent}: skills=[${r.skills.join(",")}]`,
                ),
            ),
        ),
).pipe(Command.withDescription("Attach/detach a skill on an agent's skills: list (--agent <name> [--remove])"));

const parkCommand = Command.make(
    "park",
    { name: Argument.string("name") },
    ({ name }) =>
        parkSkill(name).pipe(
            Effect.map(() => console.log(`parked skill ${name}`)),
            Effect.provide(SkillSourceRegistryLive),
        ),
).pipe(Command.withDescription("Disable a skill (move its dir to .ax-parked)"));

const unparkCommand = Command.make(
    "unpark",
    { name: Argument.string("name"), source: Flag.string("source").pipe(Flag.withDefault("user")) },
    ({ name, source }) =>
        unparkSkill(name, source as SkillScope).pipe(
            Effect.map(() => console.log(`unparked skill ${name}`)),
            Effect.provide(SkillSourceRegistryLive),
        ),
).pipe(Command.withDescription("Restore a parked skill (--source user|agents-shared|codex|project|command)"));

const rmCommand = Command.make(
    "rm",
    { name: Argument.string("name") },
    ({ name }) =>
        removeSkill(name).pipe(
            Effect.map(() => console.log(`removed skill ${name}`)),
            Effect.provide(SkillSourceRegistryLive),
        ),
).pipe(Command.withDescription("Delete a skill dir (writable sources only) + tombstone the row"));

/** Spliced into `skillsCommand`'s subcommand list in cli/index.ts. */
export const skillsConfigSubcommands = [
    configCommand,
    reconcileCommand,
    scopeCommand,
    parkCommand,
    unparkCommand,
    rmCommand,
];
