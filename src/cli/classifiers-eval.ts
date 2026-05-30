import {
    formatClassifierEvalSummary,
    loadDefaultClassifierEvalSuites,
    loadClassifierEvalSuites,
    runClassifierEvalSuites,
} from "../classifiers/eval.ts";

export async function cmdClassifiersEval(args: readonly string[]): Promise<void> {
    const json = args.includes("--json");
    const pathArg = args.find((arg) => arg.startsWith("--path="));
    const suites = pathArg
        ? loadClassifierEvalSuites(pathArg.slice("--path=".length))
        : loadDefaultClassifierEvalSuites();
    const summary = await runClassifierEvalSuites(suites);
    console.log(formatClassifierEvalSummary(summary, { json }));
    if (summary.failed > 0) process.exit(1);
}
