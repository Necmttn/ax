/**
 * `ax runs evidence <session>` - reviewer-facing read surface for the run
 * evidence ledger (#578). Read-only, `db` runtime. Sibling of commands/ax-otel.ts.
 *
 * The ledger derive stage writes `run_evidence_event`; this command reads it
 * back for one run: how much evidence exists, split by kind and by `backing`
 * (the model-claim-vs-tool-backed lens), plus a latest-N timeline. A `runs`
 * group is used (not `sessions show`) so the ledger gets its own explicit
 * reviewer contract that can grow (`--json`, MCP) without overloading the
 * session view.
 */
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { studioSessionLink } from "../../nav/next-links.ts";
import { resolveStudioTarget } from "../../dashboard/serve-instance.ts";
import { fetchRunEvidence, renderRunEvidence } from "../../queries/run-evidence.ts";
import { printNextLinks } from "../next-format.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";

const cmdRunEvidence = (input: { readonly sessionId: string; readonly json: boolean }) =>
    Effect.gen(function* () {
        const result = yield* fetchRunEvidence({ sessionId: input.sessionId });
        const studio = yield* Effect.promise(() => resolveStudioTarget());
        const next = [studioSessionLink(result.session_id, { baseUrl: studio.baseUrl, live: studio.live })];

        if (input.json) {
            console.log(prettyPrint({ ...result, next }));
            return;
        }
        console.log(renderRunEvidence(result));
        printNextLinks(next);
    });

const runsEvidenceCommand = Command.make(
    "evidence",
    {
        session: Argument.string("session"),
        json: jsonFlag,
    },
    ({ session, json }) => cmdRunEvidence({ sessionId: session, json }),
).pipe(
    Command.withDescription(
        "Run evidence ledger for one session (#578): event counts by kind + by backing "
        + "(model-claim vs tool-backed lens) and a latest-N timeline. <session> is a bare or "
        + "session:-prefixed id.  --json carries the same data plus a {next} Studio deeplink.",
    ),
);

export const runsCommand = Command.make("runs").pipe(
    Command.withDescription("Run-level views over the agent-experience graph. Subcommands: evidence."),
    Command.withSubcommands([runsEvidenceCommand]),
);

export const axRunsRuntime: RuntimeManifest = {
    runs: "db",
};
