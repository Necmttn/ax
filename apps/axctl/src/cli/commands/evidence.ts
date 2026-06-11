// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { guidanceNext, parseSelfImproveArgs, selfImproveWeekly, sessionSummary } from "../../self-improve/commands.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, jsonFlag } from "./shared.ts";

const jsonSelfImprove = (cmd: "guidance" | "session" | "self-improve", rest: string[]) => {
    const parsed = parseSelfImproveArgs(cmd, rest);
    const effect =
        parsed.command === "guidance-next" ? guidanceNext() :
        parsed.command === "session-summary" ? sessionSummary() :
        selfImproveWeekly();
    return Effect.gen(function* () {
        const result = yield* effect;
        console.log(prettyPrint(result));
    });
};

const evidenceGuidanceNextCommand = Command.make(
    "guidance-next",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("guidance", ["next", ...boolArg("json", json)]),
).pipe(Command.withDescription("Return the next self-improvement guidance"));

const evidenceSessionSummaryCommand = Command.make(
    "session-summary",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("session", ["summary", ...boolArg("json", json)]),
).pipe(Command.withDescription("Summarize recent session evidence"));

const evidenceWeeklyCommand = Command.make(
    "weekly",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("self-improve", ["weekly", ...boolArg("json", json)]),
).pipe(Command.withDescription("Run weekly self-improvement evidence query"));

export const evidenceCommand = Command.make("evidence").pipe(
    Command.withDescription("Self-improvement evidence queries (guidance, session, weekly)"),
    Command.withSubcommands([
        evidenceGuidanceNextCommand,
        evidenceSessionSummaryCommand,
        evidenceWeeklyCommand,
    ]),
);

export const evidenceRuntime: RuntimeManifest = {
    evidence: { runtime: "db", hidden: true },
};
