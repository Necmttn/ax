#!/usr/bin/env bun
// PROTOTYPE - read-only shadow classifier experiment for turn feedback labels.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Surreal } from "surrealdb";
import {
    evaluateCentroid,
    featureArray,
    featuresForText,
    FEATURE_NAMES,
    parseSignals,
    toEvalExamples,
    type ReactionPairRow,
    type ShadowRow,
    type TurnLabelRow,
} from "./ax-shadow-classifier-logic.ts";

const cfg = {
    url: process.env.AX_DB_URL ?? "ws://127.0.0.1:8521",
    endpoint: process.env.AX_DB_HTTP_URL ?? "http://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? "root",
};

interface Args {
    readonly command: "export" | "eval" | "train-surml" | "import-surml" | "surreal-sample" | "run";
    readonly out: string;
    readonly input: string;
    readonly pyInput: string;
    readonly surml: string;
    readonly report: string;
    readonly since: number;
    readonly minConfidence: number;
    readonly sample: number;
    readonly modelName: string;
    readonly modelVersion: string;
}

const argValue = (name: string): string | null => {
    const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const commandArg = (): Args["command"] => {
    const raw = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "run";
    if (raw === "export" || raw === "eval" || raw === "train-surml" || raw === "import-surml" || raw === "surreal-sample" || raw === "run") return raw;
    throw new Error(`unknown command ${raw}`);
};

function parseArgs(): Args {
    return {
        command: commandArg(),
        out: argValue("--out") ?? ".ax/ml/turn-shadow.ndjson",
        input: argValue("--input") ?? ".ax/ml/turn-shadow.ndjson",
        pyInput: argValue("--py-input") ?? ".ax/ml/turn-shadow-train.json",
        surml: argValue("--surml") ?? ".ax/ml/ax_shadow_turn_classifier.surml",
        report: argValue("--report") ?? ".ax/ml/turn-shadow-report.json",
        since: Number.parseInt(argValue("--since") ?? "90", 10),
        minConfidence: Number.parseFloat(argValue("--min-confidence") ?? "0.82"),
        sample: Number.parseInt(argValue("--sample") ?? "20", 10),
        modelName: argValue("--model-name") ?? "ax_shadow_turn_classifier",
        modelVersion: argValue("--model-version") ?? "0.0.1",
    };
}

async function connect(): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    return db;
}

const text = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const maybe = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : Number.parseFloat(text(value)) || 0;

function firstResult<T>(result: unknown): T[] {
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : [];
}

const turnRowsSql = (since: number): string => `
SELECT
    "turn_label_row" AS row_type,
    type::string(turn) AS turn_id,
    type::string(session) AS session_id,
    turn.seq AS seq,
    session.source AS source,
    turn.role AS role,
    turn.message_kind AS message_kind,
    turn.intent_kind AS intent_kind,
    turn.text_excerpt AS text_excerpt,
    turn.text AS text,
    act,
    sentiment,
    polarity,
    confidence,
    signals,
    type::string(ts) AS ts,
    type::string(session.started_at) AS session_started_at,
    session.cwd AS cwd,
    NONE AS previous_assistant_turn_id,
    NONE AS previous_assistant_text,
    NONE AS semantic_kind,
    NONE AS semantic_label,
    NONE AS canonical_text
FROM turn_analysis
WHERE turn.role = "user"
  AND confidence >= $minConfidence
  AND ts > time::now() - ${since}d
ORDER BY ts DESC;
`;

const reactionRowsSql = (since: number): string => `
SELECT
    "reaction_pair_row" AS row_type,
    type::string(id) AS reacts_to_id,
    type::string(in) AS user_turn_id,
    type::string(out) AS assistant_turn_id,
    type::string(session) AS session_id,
    session.source AS source,
    in.text AS user_text,
    out.text AS assistant_text,
    polarity,
    act,
    signal.label AS semantic_label,
    confidence,
    type::string(ts) AS ts,
    in.seq - out.seq AS seq_distance,
    duration::secs(in.ts - out.ts) AS time_delta_seconds
FROM reacts_to
WHERE confidence >= $minConfidence
  AND ts > time::now() - ${since}d
ORDER BY ts DESC;
`;

function shapeTurnRow(row: Record<string, unknown>): TurnLabelRow {
    return {
        row_type: "turn_label_row",
        turn_id: text(row.turn_id),
        session_id: text(row.session_id),
        seq: num(row.seq),
        source: maybe(row.source),
        role: text(row.role),
        message_kind: maybe(row.message_kind),
        intent_kind: maybe(row.intent_kind),
        text_excerpt: text(row.text_excerpt),
        text: text(row.text),
        previous_assistant_turn_id: maybe(row.previous_assistant_turn_id),
        previous_assistant_text: maybe(row.previous_assistant_text),
        act: text(row.act),
        sentiment: text(row.sentiment),
        polarity: text(row.polarity) as TurnLabelRow["polarity"],
        confidence: num(row.confidence),
        signals: parseSignals(row.signals),
        semantic_kind: maybe(row.semantic_kind),
        semantic_label: maybe(row.semantic_label),
        canonical_text: maybe(row.canonical_text),
        ts: maybe(row.ts),
        session_started_at: maybe(row.session_started_at),
        cwd: maybe(row.cwd),
    };
}

function shapeReactionRow(row: Record<string, unknown>): ReactionPairRow {
    return {
        row_type: "reaction_pair_row",
        reacts_to_id: text(row.reacts_to_id),
        user_turn_id: text(row.user_turn_id),
        assistant_turn_id: text(row.assistant_turn_id),
        session_id: text(row.session_id),
        source: maybe(row.source),
        user_text: text(row.user_text),
        assistant_text: text(row.assistant_text),
        polarity: text(row.polarity) as ReactionPairRow["polarity"],
        act: text(row.act),
        semantic_label: maybe(row.semantic_label),
        confidence: num(row.confidence),
        seq_distance: row.seq_distance === null || row.seq_distance === undefined ? null : num(row.seq_distance),
        time_delta_seconds: row.time_delta_seconds === null || row.time_delta_seconds === undefined ? null : num(row.time_delta_seconds),
    };
}

async function exportRows(args: Args): Promise<{ turnRows: TurnLabelRow[]; reactionRows: ReactionPairRow[] }> {
    if (!Number.isInteger(args.since) || args.since <= 0 || args.since > 3650) {
        throw new Error(`--since must be an integer between 1 and 3650 (got ${args.since})`);
    }
    const db = await connect();
    try {
        const turnResult = await db.query(turnRowsSql(args.since), { minConfidence: args.minConfidence });
        const reactionResult = await db.query(reactionRowsSql(args.since), { minConfidence: args.minConfidence });
        const turnRows = firstResult<Record<string, unknown>>(turnResult).map(shapeTurnRow);
        const reactionRows = firstResult<Record<string, unknown>>(reactionResult).map(shapeReactionRow);
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, [...turnRows, ...reactionRows].map((row) => JSON.stringify(row)).join("\n") + "\n");
        return { turnRows, reactionRows };
    } finally {
        await db.close();
    }
}

async function readRows(path: string): Promise<ShadowRow[]> {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ShadowRow);
}

async function evaluate(args: Args): Promise<Record<string, unknown>> {
    const rows = await readRows(args.input);
    const turnRows = rows.filter((row): row is TurnLabelRow => row.row_type === "turn_label_row");
    const reactionExamples = toEvalExamples(turnRows, "reaction");
    const polarityExamples = toEvalExamples(turnRows, "polarity");
    const reaction = evaluateCentroid(reactionExamples, [0, 1]);
    const polarity = evaluateCentroid(polarityExamples, [0, 1, 2]);
    const training = reactionExamples.map((example) => ({
        y: example.label,
        text: example.text,
        confidence: example.confidence,
        features: featureArray(featuresForText(example.text, example.confidence)),
    }));
    await mkdir(dirname(args.pyInput), { recursive: true });
    await writeFile(args.pyInput, JSON.stringify({ feature_names: FEATURE_NAMES, task: "reaction", training }, null, 2));
    const report = {
        generated_at: new Date().toISOString(),
        input: args.input,
        rows: rows.length,
        turn_label_rows: turnRows.length,
        reaction_pair_rows: rows.filter((row) => row.row_type === "reaction_pair_row").length,
        high_confidence_user_rows: reactionExamples.length,
        pass_500_row_gate: reactionExamples.length >= 500,
        reaction,
        polarity,
        py_input: args.pyInput,
    };
    await writeFile(args.report, JSON.stringify(report, null, 2));
    return report;
}

function run(cmd: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, [...args], { stdio: "inherit", cwd: process.cwd(), env: process.env });
        child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
        child.on("error", reject);
    });
}

async function trainSurml(args: Args): Promise<void> {
    const script = `
import json
import numpy as np
from sklearn.linear_model import LogisticRegression
from surrealml import SurMlFile, Engine
from surrealml.c_structs import EmptyReturn
import ctypes

with open(${JSON.stringify(args.pyInput)}, "r") as f:
    payload = json.load(f)
X = np.array([row["features"] for row in payload["training"]], dtype=np.float32)
y = np.array([row["y"] for row in payload["training"]], dtype=np.int64)
model = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=7)
model.fit(X, y)
surml = SurMlFile(model=model, name=${JSON.stringify(args.modelName)}, inputs=X, engine=Engine.SKLEARN)
surml.rust_adapter.loader.lib.add_output.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
surml.rust_adapter.loader.lib.add_output.restype = EmptyReturn
surml.rust_adapter.loader.lib.add_normaliser.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
surml.rust_adapter.loader.lib.add_normaliser.restype = EmptyReturn
surml.add_version(${JSON.stringify(args.modelVersion)})
surml.add_description("ax read-only shadow reaction classifier prototype")
surml.add_author("ax prototype")
for name in payload["feature_names"]:
    surml.add_column(name)
surml.add_output("is_reaction", "z_score", 0.0, 1.0)
surml.save(path=${JSON.stringify(args.surml)})
print(json.dumps({"surml": ${JSON.stringify(args.surml)}, "rows": int(X.shape[0]), "features": int(X.shape[1])}))
`;
    await mkdir(dirname(args.surml), { recursive: true });
    const python = existsSync(".ax/ml/uv/bin/python")
        ? ".ax/ml/uv/bin/python"
        : existsSync(".ax/ml/venv311/bin/python")
        ? ".ax/ml/venv311/bin/python"
        : ".ax/ml/venv/bin/python";
    await run(python, ["-c", script]);
}

async function importSurml(args: Args): Promise<void> {
    await run("surreal", [
        "ml", "import",
        "--endpoint", cfg.endpoint,
        "--username", cfg.user,
        "--password", cfg.pass,
        "--namespace", cfg.ns,
        "--database", cfg.db,
        args.surml,
    ]);
}

async function surrealSample(args: Args): Promise<void> {
    const rows = await readRows(args.input);
    const turnRows = rows.filter((row): row is TurnLabelRow => row.row_type === "turn_label_row").slice(0, args.sample);
    const featureObjects = turnRows.map((row) => {
        const features = featuresForText(row.text || row.text_excerpt, row.confidence);
        return Object.fromEntries(FEATURE_NAMES.map((name) => [name, features[name]]));
    });
    const sql = `RETURN ${JSON.stringify(featureObjects)}.map(|$row| ml::${args.modelName}<${args.modelVersion}>($row));`;
    const db = await connect();
    try {
        const result = await db.query(sql);
        console.log(JSON.stringify({ sample_rows: featureObjects.length, surrealml_result: result }, null, 2));
    } finally {
        await db.close();
    }
}

async function main(): Promise<void> {
    const args = parseArgs();
    if (args.command === "export" || args.command === "run") {
        const { turnRows, reactionRows } = await exportRows(args);
        console.log(`exported ${turnRows.length} turn_label_row and ${reactionRows.length} reaction_pair_row to ${args.out}`);
    }
    if (args.command === "eval" || args.command === "run") {
        const report = await evaluate(args);
        console.log(JSON.stringify(report, null, 2));
    }
    if (args.command === "train-surml" || args.command === "run") {
        await trainSurml(args);
    }
    if (args.command === "import-surml" || args.command === "run") {
        await importSurml(args);
    }
    if (args.command === "surreal-sample" || args.command === "run") {
        await surrealSample(args);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
