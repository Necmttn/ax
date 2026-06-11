// Extracted from cli/index.ts (Phase 2 CLI split)
import { Command } from "effect/unstable/cli";
import { cmdProject } from "../project.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, jsonFlag } from "./shared.ts";

const projectContextCommand = Command.make(
    "context",
    { json: jsonFlag },
    ({ json }) => cmdProject(["context", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print repo grounding context"));

const projectVerifyCommand = Command.make(
    "verify",
    { json: jsonFlag },
    ({ json }) => cmdProject(["verify", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print verification checks for the current diff"));

const projectHarnessCommand = Command.make(
    "harness",
    { json: jsonFlag },
    ({ json }) => cmdProject(["harness", ...boolArg("json", json)]),
).pipe(Command.withDescription("Print Harness Doctor and local learning candidates"));

export const projectCommand = Command.make("project").pipe(
    Command.withDescription("Ground agent work in the current repository"),
    Command.withSubcommands([projectContextCommand, projectVerifyCommand, projectHarnessCommand]),
);

export const projectRuntime: RuntimeManifest = {
    project: "db",
};
