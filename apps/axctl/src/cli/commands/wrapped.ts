/**
 * `ax wrapped` - agent-authored Wrapped recap cards.
 *
 * Subcommands:
 *   ax wrapped generate [--force]
 *     Emit .ax/tasks/wrapped-generate-<date>.md - a brief instructing an
 *     agent to mine the graph and publish Paxel-style headline cards.
 *
 *   ax wrapped publish [--file=PATH] [--json]
 *     Read { cards: [...] } JSON (stdin or --file), validate, and replace
 *     the wrapped_card set. The dashboard landing serves the new deck on
 *     its next fetch.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { renderWrappedGenerateBrief } from "../../dashboard/wrapped-generate-brief.ts";
import { runPublishCards } from "../../dashboard/wrapped-cards.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag, optionValue } from "./shared.ts";

const cmdWrappedGenerate = (input: { readonly force: boolean }) =>
    Effect.gen(function* () {
        const date = new Date().toISOString().slice(0, 10);
        const path = `.ax/tasks/wrapped-generate-${date}.md`;
        const exists = yield* Effect.tryPromise(() => Bun.file(path).exists());
        if (exists && !input.force) {
            console.log(`already exists: ${path} (re-run with --force to overwrite)`);
            return;
        }
        // Bun.write creates parent directories itself (repo gate: check:no-node-fs).
        yield* Effect.tryPromise(() => Bun.write(path, renderWrappedGenerateBrief({ date })));
        console.log(`wrapped brief written: ${path}`);
        console.log("hand it to an agent session; cards come back via `ax wrapped publish`");
    });

const cmdWrappedPublish = (input: { readonly file: string | undefined; readonly json: boolean }) =>
    Effect.gen(function* () {
        const raw = input.file !== undefined
            ? yield* Effect.tryPromise(() => Bun.file(input.file as string).text())
            : yield* Effect.tryPromise(() => Bun.stdin.text());
        const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (err) =>
                new Error(
                    `invalid JSON on ${input.file ? input.file : "stdin"}: ${err instanceof Error ? err.message : String(err)}`,
                ),
        });
        const result = yield* runPublishCards(parsed);
        if (input.json) {
            console.log(JSON.stringify(result));
        } else {
            console.log(`published ${result.count} wrapped cards - the dashboard landing serves them now`);
        }
    });

const wrappedGenerateCommand = Command.make(
    "generate",
    {
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
    },
    ({ force }) => cmdWrappedGenerate({ force }),
).pipe(Command.withDescription("Emit .ax/tasks/wrapped-generate-<date>.md - a brief for an agent to mine the graph and write Paxel-style recap cards back via `ax wrapped publish`."));

const wrappedPublishCommand = Command.make(
    "publish",
    {
        file: Flag.string("file").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ file, json }) => cmdWrappedPublish({ file: optionValue(file), json }),
).pipe(Command.withDescription("Replace the wrapped card deck: read { cards: [{question, headline, body, sensitivity?}] } JSON from stdin or --file."));

export const wrappedCommand = Command.make("wrapped").pipe(
    Command.withDescription("Agent-authored Wrapped recap cards: generate the mining brief, publish the card deck."),
    Command.withSubcommands([wrappedGenerateCommand, wrappedPublishCommand]),
);

export const wrappedRuntime: RuntimeManifest = { wrapped: "db" };
