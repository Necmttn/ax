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
from gate_stack_usefulness import candidate_metadata  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project hybrid model-only event-window candidates into graph-ready facts.")
    parser.add_argument("--hybrid", default=".ax/experiments/hybrid-gate-e4.json")
    parser.add_argument("--out", default=".ax/experiments/hybrid-window-candidate-graph-projection-current.json")
    parser.add_argument("--write-plan", default=".ax/experiments/hybrid-window-candidate-graph-write-plan-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def evidence_refs(candidate: dict[str, Any]) -> list[dict[str, str]]:
    refs = []
    for entry in candidate.get("evidence") or []:
        ref = str(entry.get("ref") or "")
        kind = str(entry.get("kind") or "unknown")
        if ref:
            refs.append({"ref": ref, "kind": kind})
    turn = str(candidate.get("turn") or "")
    if turn and not any(ref["ref"] == turn for ref in refs):
        refs.insert(0, {"ref": turn, "kind": "classified_turn"})
    return refs


def projection_from_hybrid_report(report: dict[str, Any], source_path: str) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    facts: list[dict[str, Any]] = []
    source_node = f"artifact:{fact_id(source_path)}"
    package_node = "classifier_package:session-section-chunks"
    nodes[package_node] = node(package_node, "classifier_package", "session-section-chunks", {
        "package_name": "@ax-classifier/session-sections",
        "source_report": source_path,
    })
    nodes[source_node] = node(source_node, "artifact", source_path, {
        "path": source_path,
        "source": "hybrid_event_window_gate",
        "setfit_run_rate": report.get("setfit_run_rate"),
        "model_only_positive_count": report.get("model_only_positive_count"),
        "useful_new_fact_rate": report.get("useful_new_fact_rate"),
    })

    groups: dict[str, list[dict[str, Any]]] = {}
    for candidate in report.get("model_only_candidates") or []:
        groups.setdefault(str(candidate.get("label") or "unknown"), []).append(candidate)

    evidence_fact_count = 0
    for label, candidates in sorted(groups.items()):
        metadata = candidate_metadata(label)
        action = metadata["proposed_action"]
        group_node = f"classifier_candidate_group:{fact_id(f'hybrid-window/{label}')}"
        action_node = f"classifier_graph_action:{fact_id(action)}"
        nodes[group_node] = node(group_node, "classifier_candidate_group", label, {
            "source": "hybrid_event_window_model_only",
            "label": label,
            "candidate_id": metadata["candidate_id"],
            "proposed_action": action,
            "support_count": len(candidates),
            "note": metadata["note"],
        })
        nodes[action_node] = node(action_node, "classifier_graph_action", action, {"action": action})
        emitted_edge = f"edge:{fact_id(f'{source_node}->emitted_candidate_group->{group_node}')}"
        action_edge = f"edge:{fact_id(f'{group_node}->suggests_action->{action_node}')}"
        edges[emitted_edge] = edge(emitted_edge, "emitted_candidate_group", source_node, group_node, source_path, {
            "label": label,
            "support_count": len(candidates),
        })
        edges[action_edge] = edge(action_edge, "suggests_action", group_node, action_node, source_path, {
            "label": label,
            "candidate_id": metadata["candidate_id"],
        })
        support_edges = [emitted_edge, action_edge]
        for candidate in candidates:
            candidate_id = str(candidate.get("id") or "")
            result_node = f"classifier_result_ref:{fact_id(candidate_id)}"
            nodes[result_node] = node(result_node, "classifier_model_window_result", candidate_id, {
                "label": label,
                "confidence": candidate.get("confidence"),
                "run_reason": candidate.get("run_reason"),
                "session": candidate.get("session"),
                "turn": candidate.get("turn"),
                "seq": candidate.get("seq"),
                "ts": candidate.get("ts"),
                "text_excerpt": candidate.get("text_excerpt"),
            })
            result_edge = f"edge:{fact_id(f'{group_node}->supported_by_model_window->{result_node}')}"
            edges[result_edge] = edge(result_edge, "supported_by_model_window", group_node, result_node, source_path, {
                "confidence": candidate.get("confidence"),
                "run_reason": candidate.get("run_reason"),
            })
            support_edges.append(result_edge)
            evidence_edges: list[str] = []
            for ref in evidence_refs(candidate):
                evidence_node = f"classifier_evidence:{fact_id(ref['ref'])}"
                nodes.setdefault(evidence_node, node(evidence_node, "classifier_transcript_evidence", ref["ref"], {
                    "evidence_id": ref["ref"],
                }))
                evidence_edge = f"edge:{fact_id(f'{result_node}->cites_evidence->{evidence_node}:{ref['kind']}')}"
                edges[evidence_edge] = edge(evidence_edge, "cites_transcript_evidence", result_node, evidence_node, source_path, {
                    "kind": ref["kind"],
                })
                support_edges.append(evidence_edge)
                evidence_edges.append(evidence_edge)
            facts.append(fact(
                f"fact:{fact_id(f'{result_node}:supports:{group_node}')}",
                "classifier_candidate_evidence",
                group_node,
                "supported_by_model_window",
                [result_edge, *evidence_edges],
                {
                    "window_id": candidate_id,
                    "label": label,
                    "confidence": candidate.get("confidence"),
                    "run_reason": candidate.get("run_reason"),
                    "turn": candidate.get("turn"),
                    "text_excerpt": candidate.get("text_excerpt"),
                },
                object_id=result_node,
                value=True,
            ))
            evidence_fact_count += 1
        facts.append(fact(
            f"fact:{fact_id(f'{group_node}:suggests:{action}')}",
            "classifier_candidate_group",
            group_node,
            "suggests_graph_action",
            support_edges,
            {
                "label": label,
                "candidate_id": metadata["candidate_id"],
                "proposed_action": action,
                "support_count": len(candidates),
            },
            object_id=action_node,
            value=action,
        ))

    health = health_from_projection(report, list(nodes.values()), list(edges.values()), facts)
    return {
        "schema": "ax.hybrid_window_candidate_graph_projection.v1",
        "source_schema": report.get("schema", "ax.hybrid_gate_report.v1"),
        "source_report": source_path,
        "source_metrics": {
            "windows": report.get("windows"),
            "deterministic_positive_count": report.get("deterministic_positive_count"),
            "setfit_sent_count": report.get("setfit_sent_count"),
            "setfit_run_rate": report.get("setfit_run_rate"),
            "model_only_positive_count": report.get("model_only_positive_count"),
            "model_only_evidence_coverage": report.get("model_only_evidence_coverage"),
            "useful_new_fact_rate": report.get("useful_new_fact_rate"),
        },
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "facts": facts,
        "health": health,
        "totals": {
            "candidate_group_count": len(groups),
            "node_count": len(nodes),
            "edge_count": len(edges),
            "fact_count": len(facts),
            "candidate_group_fact_count": len(groups),
            "candidate_evidence_fact_count": evidence_fact_count,
        },
        "decision": "hybrid_window_candidate_graph_projection_ready" if not health["failures"] else "needs_hybrid_window_candidate_graph_projection_work",
    }


def health_from_projection(
    report: dict[str, Any],
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    facts: list[dict[str, Any]],
) -> dict[str, Any]:
    group_nodes = [entry for entry in nodes if entry["kind"] == "classifier_candidate_group"]
    result_edges = [entry for entry in edges if entry["kind"] == "supported_by_model_window"]
    evidence_edges = [entry for entry in edges if entry["kind"] == "cites_transcript_evidence"]
    action_edges = [entry for entry in edges if entry["kind"] == "suggests_action"]
    groups_without_results = [group["id"] for group in group_nodes if not any(edge["from"] == group["id"] for edge in result_edges)]
    groups_without_actions = [group["id"] for group in group_nodes if not any(edge["from"] == group["id"] for edge in action_edges)]
    results_without_evidence = [
        edge_entry["to"]
        for edge_entry in result_edges
        if not any(evidence_edge["from"] == edge_entry["to"] for evidence_edge in evidence_edges)
    ]
    failures: list[str] = list(report.get("failures") or [])
    if not group_nodes:
        failures.append("no hybrid model-only candidate group nodes")
    if groups_without_results:
        failures.append("candidate groups missing model-window support")
    if groups_without_actions:
        failures.append("candidate groups missing suggested action")
    if results_without_evidence:
        failures.append("model-window candidates missing transcript evidence")
    if float(report.get("setfit_run_rate") or 0.0) >= 0.40:
        failures.append("source hybrid gate sent at least 40% of windows to SetFit")
    if float(report.get("useful_new_fact_rate") or 0.0) < 0.10:
        failures.append("source hybrid gate useful new fact rate below 10%")
    if float(report.get("model_only_evidence_coverage") or 0.0) < 1.0:
        failures.append("source hybrid gate model-only evidence coverage below 100%")
    return {
        "candidate_group_count": len(group_nodes),
        "supported_result_edge_count": len(result_edges),
        "transcript_evidence_edge_count": len(evidence_edges),
        "candidate_evidence_fact_count": len([entry for entry in facts if entry["kind"] == "classifier_candidate_evidence"]),
        "groups_without_results": groups_without_results,
        "groups_without_actions": groups_without_actions,
        "results_without_evidence": results_without_evidence,
        "failures": failures,
        "decision": "healthy" if not failures else "needs_review",
    }


def write_plan_from_projection(projection: dict[str, Any]) -> dict[str, Any]:
    node_statements = [
        f"UPSERT {record_ref('classifier_graph_node', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("label", surreal_string(entry["label"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string("hybrid_window_classifier_projection")),
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
            ("source_kind", surreal_string("hybrid_window_classifier_projection")),
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
            ("source_kind", surreal_string("hybrid_window_classifier_projection")),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["facts"]
    ]
    statements = [*node_statements, *edge_statements, *fact_statements]
    return {
        "schema": "ax.hybrid_window_candidate_graph_surreal_write_plan.v1",
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
        "decision": "ready_to_apply" if projection["decision"] == "hybrid_window_candidate_graph_projection_ready" else "blocked",
    }


def main() -> int:
    args = parse_args()
    report = load_json(args.hybrid)
    projection = projection_from_hybrid_report(report, args.hybrid)
    write_plan = write_plan_from_projection(projection)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(projection, indent=2) + "\n")
    write_plan_out = Path(args.write_plan)
    write_plan_out.parent.mkdir(parents=True, exist_ok=True)
    write_plan_out.write_text(json.dumps(write_plan, indent=2) + "\n")
    if args.json:
        print(json.dumps({"projection": projection, "write_plan": write_plan}, indent=2))
    else:
        print("hybrid window candidate graph projection")
        print(f"decision: {projection['decision']}")
        print(f"candidate groups: {projection['totals']['candidate_group_count']}")
        print(f"nodes/edges/facts: {projection['totals']['node_count']}/{projection['totals']['edge_count']}/{projection['totals']['fact_count']}")
        print(f"transcript evidence edges: {projection['health']['transcript_evidence_edge_count']}")
        print(f"write plan statements: {write_plan['totals']['statement_count']}")
        print(f"projection out: {out}")
        print(f"write plan out: {write_plan_out}")
    return 0 if write_plan["decision"] == "ready_to_apply" else 1


if __name__ == "__main__":
    raise SystemExit(main())
