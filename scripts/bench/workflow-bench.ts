#!/usr/bin/env bun
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { fetchWorkflow, refreshWorkflowSnapshot } from "../../apps/axctl/src/dashboard/workflow.ts";

interface Args {
    readonly iterations: number;
    readonly refreshSnapshot: boolean;
    readonly maxMs: number;
    readonly json: boolean;
}

interface Sample {
    readonly name: string;
    readonly ms: number;
}

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/bench/workflow-bench.ts [options]

Options:
  --refresh-snapshot       Rebuild workflow_snapshot:latest before timing reads
  --iterations=N           Cached fetchWorkflow samples. Default: 7
  --max-ms=N               Fail if cached p95 exceeds N ms. Default: 1000
  --json                   Print only JSON
`);
    process.exit(code);
};

const parsePositiveInt = (raw: string | undefined, name: string, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return Math.trunc(value);
};

const parseArgs = (argv: readonly string[]): Args => {
    let iterations = 7;
    let refreshSnapshot = false;
    let maxMs = 1000;
    let json = false;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") usage(0);
        if (arg === "--refresh-snapshot") {
            refreshSnapshot = true;
            continue;
        }
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("--iterations=")) {
            iterations = parsePositiveInt(arg.slice("--iterations=".length), "--iterations", iterations);
            continue;
        }
        if (arg.startsWith("--max-ms=")) {
            maxMs = parsePositiveInt(arg.slice("--max-ms=".length), "--max-ms", maxMs);
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    return { iterations, refreshSnapshot, maxMs, json };
};

const timed = async <A>(name: string, effect: Effect.Effect<A, unknown, never>): Promise<{ sample: Sample; value: A }> => {
    const started = performance.now();
    const value = await Effect.runPromise(effect);
    return {
        sample: { name, ms: +(performance.now() - started).toFixed(1) },
        value,
    };
};

const percentile = (values: readonly number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx] ?? 0;
};

const main = async (): Promise<void> => {
    const args = parseArgs(Bun.argv.slice(2));
    const samples: Sample[] = [];

    if (args.refreshSnapshot) {
        const refresh = await timed(
            "workflow.refresh_snapshot",
            refreshWorkflowSnapshot().pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown, unknown, never>,
        );
        samples.push(refresh.sample);
    }

    for (let i = 0; i < args.iterations; i += 1) {
        const read = await timed(
            "workflow.fetch_cached",
            fetchWorkflow().pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown, unknown, never>,
        );
        samples.push(read.sample);
    }

    const cachedMs = samples.filter((s) => s.name === "workflow.fetch_cached").map((s) => s.ms);
    const report = {
        schema: "ax.workflow_bench.v1",
        generated_at: new Date().toISOString(),
        iterations: args.iterations,
        max_ms: args.maxMs,
        cached: {
            min_ms: Math.min(...cachedMs),
            median_ms: percentile(cachedMs, 50),
            p95_ms: percentile(cachedMs, 95),
            max_ms: Math.max(...cachedMs),
        },
        samples,
        decision: percentile(cachedMs, 95) <= args.maxMs ? "workflow_endpoint_under_budget" : "workflow_endpoint_over_budget",
    };

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`workflow bench · iterations=${args.iterations} · max=${args.maxMs}ms`);
        console.table(samples);
        console.log(`cached p95: ${report.cached.p95_ms.toFixed(1)}ms`);
        console.log(report.decision);
    }

    if (report.decision !== "workflow_endpoint_under_budget") {
        process.exitCode = 1;
    }
};

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
