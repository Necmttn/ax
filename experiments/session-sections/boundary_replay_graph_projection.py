#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from candidate_graph_projection import (  # noqa: E402
    edge,
    fact,
    fact_id,
    node,
    record_ref,
    surreal_json_text,
    surreal_object,
    surreal_string,
)


SOURCE_KIND = "boundary_replay_deterministic_projection"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project deterministic boundary replay coverage into graph-ready facts.")
    parser.add_argument("--replay", default=".ax/experiments/boundary-review-deterministic-replay-workflow-candidate-current.json")
    parser.add_argument("--out", default=".ax/experiments/boundary-replay-graph-projection-current.json")
    parser.add_argument("--write-plan", default=".ax/experiments/boundary-replay-graph-write-plan-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def projection_from_replay(replay: dict[str, Any], source_path: str) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    facts: list[dict[str, Any]] = []

    source_node = f"artifact:{fact_id(source_path)}"
    nodes[source_node] = node(source_node, "classifier_boundary_replay_artifact", source_path, {
        "path": source_path,
        "schema": replay.get("schema"),
        "decision": replay.get("decision"),
        "coverage_rate": replay.get("coverage_rate"),
    })
    for row in replay.get("rows") or []:
        row_id = str(row.get("id") or "")
        if not row_id:
            continue
        miss_node = f"classifier_boundary_miss:{fact_id(row_id)}"
        nodes[miss_node] = node(miss_node, "classifier_boundary_miss", row_id, {
            "actual": row.get("actual"),
            "current_label": row.get("current_label"),
            "target": row.get("target"),
            "covered_by_deterministic": row.get("covered_by_deterministic"),
        })
        emitted_edge = f"edge:{fact_id(f'{source_node}->reported_boundary_miss->{miss_node}')}"
        edges[emitted_edge] = edge(emitted_edge, "reported_boundary_miss", source_node, miss_node, source_path, {
            "covered_by_deterministic": row.get("covered_by_deterministic"),
        })
        evidence_edges = [emitted_edge]
        if row.get("covered_by_deterministic") is True:
            facts.append(fact(
                f"fact:{fact_id(f'{miss_node}:covered_by_deterministic')}",
                "classifier_boundary_replay",
                miss_node,
                "covered_by_deterministic",
                evidence_edges,
                {
                    "classifier_key": replay.get("classifier_key"),
                    "actual": row.get("actual"),
                    "target": row.get("target"),
                },
                value=True,
            ))
        for index, result in enumerate(row.get("deterministic_results") or []):
            result_key = f"{row_id}:{index}:{result.get('classifier_key')}:{result.get('target')}"
            result_node = f"classifier_deterministic_result:{fact_id(result_key)}"
            nodes[result_node] = node(result_node, "classifier_deterministic_result", str(result.get("classifier_key") or "unknown"), {
                "classifier_key": result.get("classifier_key"),
                "label": result.get("label"),
                "target": result.get("target"),
                "confidence": result.get("confidence"),
                "signals": result.get("signals"),
            })
            result_edge = f"edge:{fact_id(f'{miss_node}->has_deterministic_result->{result_node}')}"
            edges[result_edge] = edge(result_edge, "has_deterministic_result", miss_node, result_node, source_path, {
                "classifier_key": result.get("classifier_key"),
                "label": result.get("label"),
                "target": result.get("target"),
            })
            facts.append(fact(
                f"fact:{fact_id(f'{miss_node}:deterministic_label:{index}')}",
                "classifier_boundary_replay",
                miss_node,
                "deterministic_label",
                [emitted_edge, result_edge],
                {
                    "classifier_key": result.get("classifier_key"),
                    "confidence": result.get("confidence"),
                    "signals": result.get("signals"),
                },
                object_id=result_node,
                value={
                    "label": result.get("label"),
                    "target": result.get("target"),
                },
            ))
    failures = []
    if not facts:
        failures.append("no boundary replay facts")
    return {
        "schema": "ax.boundary_replay_graph_projection.v1",
        "source_report": source_path,
        "source_decision": replay.get("decision"),
        "source_kind": SOURCE_KIND,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "facts": facts,
        "totals": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "fact_count": len(facts),
            "covered_fact_count": len([entry for entry in facts if entry["predicate"] == "covered_by_deterministic"]),
            "deterministic_label_fact_count": len([entry for entry in facts if entry["predicate"] == "deterministic_label"]),
        },
        "failures": failures,
        "decision": "boundary_replay_graph_projection_ready" if not failures else "needs_boundary_replay_graph_review",
    }


def write_plan_from_projection(projection: dict[str, Any]) -> dict[str, Any]:
    source_kind = str(projection.get("source_kind") or SOURCE_KIND)
    node_statements = [
        f"UPSERT {record_ref('classifier_graph_node', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("label", surreal_string(entry["label"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string(source_kind)),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["nodes"]
    ]
    edge_statements = [
        f"UPSERT {record_ref('classifier_graph_edge', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("from_id", surreal_string(entry["from"])),
            ("to_id", surreal_string(entry["to"])),
            ("evidence_path", surreal_string(entry["evidence_path"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string(source_kind)),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["edges"]
    ]
    fact_statements = [
        f"UPSERT {record_ref('classifier_graph_fact', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("subject", surreal_string(entry["subject"])),
            ("predicate", surreal_string(entry["predicate"])),
            ("object", "NONE" if entry.get("object") is None else surreal_string(entry["object"])),
            ("value_json", "NONE" if "value" not in entry else surreal_json_text(entry["value"])),
            ("evidence_edges_json", surreal_json_text(entry["evidence_edges"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string(source_kind)),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["facts"]
    ]
    statements = [*node_statements, *edge_statements, *fact_statements]
    return {
        "schema": "ax.boundary_replay_graph_surreal_write_plan.v1",
        "source_projection_schema": projection["schema"],
        "source_report": projection["source_report"],
        "tables": ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
        "statements": statements,
        "totals": {
            "statement_count": len(statements),
            "node_statement_count": len(node_statements),
            "edge_statement_count": len(edge_statements),
            "fact_statement_count": len(fact_statements),
        },
        "decision": "ready_to_apply" if projection["decision"] == "boundary_replay_graph_projection_ready" else "blocked",
    }


def main() -> int:
    args = parse_args()
    replay = load_json(args.replay)
    projection = projection_from_replay(replay, args.replay)
    write_plan = write_plan_from_projection(projection)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(projection, indent=2) + "\n")
    Path(args.write_plan).parent.mkdir(parents=True, exist_ok=True)
    Path(args.write_plan).write_text(json.dumps(write_plan, indent=2) + "\n")
    if args.json:
        print(json.dumps(projection, indent=2))
    else:
        print("boundary replay graph projection")
        print(f"nodes: {projection['totals']['node_count']}")
        print(f"edges: {projection['totals']['edge_count']}")
        print(f"facts: {projection['totals']['fact_count']}")
        print(f"decision: {projection['decision']}")
    return 0 if projection["decision"] == "boundary_replay_graph_projection_ready" and write_plan["decision"] == "ready_to_apply" else 1


if __name__ == "__main__":
    raise SystemExit(main())
