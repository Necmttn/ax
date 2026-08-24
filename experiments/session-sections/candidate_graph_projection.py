#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project gated classifier candidate groups into graph-ready facts and evidence edges.")
    parser.add_argument("--usefulness", default=".ax/experiments/setfit-gate-stack-usefulness-e153-combined119.json")
    parser.add_argument("--out", default=".ax/experiments/setfit-candidate-graph-projection-e154-combined119.json")
    parser.add_argument("--write-plan", default=".ax/experiments/setfit-candidate-graph-write-plan-e154-combined119.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def fact_id(value: str) -> str:
    return "".join(char if char.isalnum() or char in ":_./-" else "_" for char in value)


def record_ref(table: str, graph_id: str) -> str:
    escaped = graph_id.replace("\\", "\\\\").replace("`", "\\`")
    return f"{table}:`{escaped}`"


def surreal_string(value: str) -> str:
    return json.dumps(value)


def surreal_json_text(value: Any) -> str:
    return surreal_string(json.dumps(value, separators=(",", ":"), sort_keys=True))


def surreal_object(fields: list[tuple[str, str]]) -> str:
    return "{ " + ", ".join(f"{key}: {value}" for key, value in fields) + " }"


def node(node_id: str, kind: str, label: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node_id,
        "kind": kind,
        "label": label,
        "properties": properties,
    }


def edge(edge_id: str, kind: str, from_id: str, to_id: str, evidence_path: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": edge_id,
        "kind": kind,
        "from": from_id,
        "to": to_id,
        "evidence_path": evidence_path,
        "properties": properties,
    }


def fact(
    fact_id_value: str,
    kind: str,
    subject: str,
    predicate: str,
    evidence_edges: list[str],
    properties: dict[str, Any],
    object_id: str | None = None,
    value: Any = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": fact_id_value,
        "kind": kind,
        "subject": subject,
        "predicate": predicate,
        "evidence_edges": evidence_edges,
        "properties": properties,
    }
    if object_id is not None:
        result["object"] = object_id
    if value is not None:
        result["value"] = value
    return result


def candidate_group_path(seed: Any, label: str) -> str:
    return f"session-section-chunks/seed-{seed}/{label}"


def projection_from_usefulness(usefulness: dict[str, Any], source_path: str) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    facts: list[dict[str, Any]] = []

    package_node = "classifier_package:session-section-chunks"
    source_node = f"artifact:{fact_id(source_path)}"
    nodes[package_node] = node(package_node, "classifier_package", "session-section-chunks", {
        "package_name": "@ax-classifier/session-sections",
        "source_report": source_path,
    })
    nodes[source_node] = node(source_node, "artifact", source_path, {
        "path": source_path,
        "schema": usefulness.get("schema"),
        "decision": usefulness.get("decision"),
    })

    group_fact_count = 0
    evidence_fact_count = 0
    for run in usefulness.get("runs") or []:
        seed = run.get("seed")
        run_node = f"classifier_candidate_run:{fact_id(f'{source_path}/seed-{seed}')}"
        nodes[run_node] = node(run_node, "classifier_candidate_run", f"seed-{seed}", {
            "seed": seed,
            "test_rows": run.get("test_rows"),
            "predicted_positive_count": run.get("predicted_positive_count"),
            "model_assisted_candidate_count": run.get("model_assisted_candidate_count"),
            "graph_noise_count": run.get("graph_noise_count"),
            "accepted_hard_negative_miss_count": run.get("accepted_hard_negative_miss_count"),
        })
        source_edge = f"edge:{fact_id(f'{run_node}->derived_from->{source_node}')}"
        edges[source_edge] = edge(source_edge, "derived_from", run_node, source_node, source_path, {
            "source_decision": usefulness.get("decision"),
        })
        for group in run.get("candidate_groups") or []:
            label = str(group.get("label") or "unknown")
            group_node = f"classifier_candidate_group:{fact_id(candidate_group_path(seed, label))}"
            action_node = f"classifier_graph_action:{fact_id(str(group.get('proposed_action') or 'review_section_pattern'))}"
            nodes[group_node] = node(group_node, "classifier_candidate_group", label, {
                "seed": seed,
                "candidate_id": group.get("candidate_id"),
                "proposed_action": group.get("proposed_action"),
                "support_count": group.get("support_count"),
                "true_positive_count": group.get("true_positive_count"),
                "wrong_family_count": group.get("wrong_family_count"),
                "fixture_evidence_count": group.get("fixture_evidence_count"),
                "note": group.get("note"),
            })
            nodes[action_node] = node(action_node, "classifier_graph_action", str(group.get("proposed_action") or "review_section_pattern"), {
                "action": group.get("proposed_action"),
            })
            emitted_edge = f"edge:{fact_id(f'{run_node}->emitted_candidate_group->{group_node}')}"
            action_edge = f"edge:{fact_id(f'{group_node}->suggests_action->{action_node}')}"
            edges[emitted_edge] = edge(emitted_edge, "emitted_candidate_group", run_node, group_node, source_path, {
                "label": label,
                "support_count": group.get("support_count"),
            })
            edges[action_edge] = edge(action_edge, "suggests_action", group_node, action_node, source_path, {
                "label": label,
                "candidate_id": group.get("candidate_id"),
            })
            support_edges = [emitted_edge, action_edge]
            for example in group.get("examples") or []:
                example_id = str(example.get("id") or "")
                if not example_id:
                    continue
                evidence_node = f"classifier_evidence:{fact_id(example_id)}"
                nodes[evidence_node] = node(evidence_node, "classifier_fixture_evidence", example_id, {
                    "source_group": example.get("source_group"),
                    "text_excerpt": example.get("text_excerpt"),
                })
                evidence_edge = f"edge:{fact_id(f'{group_node}->supported_by_fixture->{evidence_node}')}"
                edges[evidence_edge] = edge(evidence_edge, "supported_by_fixture", group_node, evidence_node, source_path, {
                    "actual": example.get("actual"),
                    "predicted": example.get("predicted"),
                })
                support_edges.append(evidence_edge)
                facts.append(fact(
                    f"fact:{fact_id(f'{group_node}:example:{example_id}')}",
                    "classifier_candidate_evidence",
                    group_node,
                    "supported_by_fixture",
                    [evidence_edge],
                    {
                        "fixture_id": example_id,
                        "actual": example.get("actual"),
                        "predicted": example.get("predicted"),
                        "text_excerpt": example.get("text_excerpt"),
                    },
                    object_id=evidence_node,
                    value=True,
                ))
                evidence_fact_count += 1
            facts.append(fact(
                f"fact:{fact_id(f'{group_node}:suggests:{group.get('proposed_action')}')}",
                "classifier_candidate_group",
                group_node,
                "suggests_graph_action",
                support_edges,
                {
                    "seed": seed,
                    "label": label,
                    "candidate_id": group.get("candidate_id"),
                    "proposed_action": group.get("proposed_action"),
                    "support_count": group.get("support_count"),
                    "true_positive_count": group.get("true_positive_count"),
                    "wrong_family_count": group.get("wrong_family_count"),
                    "fixture_evidence_count": group.get("fixture_evidence_count"),
                },
                object_id=action_node,
                value=group.get("proposed_action"),
            ))
            group_fact_count += 1

    unique_edges = list(edges.values())
    graph_health = graph_health_from_projection(list(nodes.values()), unique_edges, facts)
    return {
        "schema": "ax.classifier_candidate_graph_projection.v1",
        "source_schema": usefulness.get("schema"),
        "source_decision": usefulness.get("decision"),
        "source_report": source_path,
        "nodes": list(nodes.values()),
        "edges": unique_edges,
        "facts": facts,
        "health": graph_health,
        "totals": {
            "node_count": len(nodes),
            "edge_count": len(unique_edges),
            "fact_count": len(facts),
            "candidate_group_fact_count": group_fact_count,
            "candidate_evidence_fact_count": evidence_fact_count,
            "fixture_evidence_edge_count": len([entry for entry in unique_edges if entry["kind"] == "supported_by_fixture"]),
        },
        "decision": "candidate_graph_projection_ready" if graph_health["failures"] == [] else "needs_candidate_graph_projection_work",
    }


def graph_health_from_projection(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    facts: list[dict[str, Any]],
) -> dict[str, Any]:
    group_nodes = [entry for entry in nodes if entry["kind"] == "classifier_candidate_group"]
    action_edges = [entry for entry in edges if entry["kind"] == "suggests_action"]
    evidence_edges = [entry for entry in edges if entry["kind"] == "supported_by_fixture"]
    group_facts = [entry for entry in facts if entry["kind"] == "classifier_candidate_group"]
    groups_without_evidence = [
        group["id"]
        for group in group_nodes
        if not any(edge["from"] == group["id"] for edge in evidence_edges)
    ]
    groups_without_action = [
        group["id"]
        for group in group_nodes
        if not any(edge["from"] == group["id"] for edge in action_edges)
    ]
    failures: list[str] = []
    if not group_nodes:
        failures.append("no candidate group nodes")
    if groups_without_evidence:
        failures.append("candidate groups missing fixture evidence edges")
    if groups_without_action:
        failures.append("candidate groups missing suggested action edges")
    if len(group_facts) != len(group_nodes):
        failures.append("candidate group fact count does not match candidate group nodes")
    return {
        "candidate_group_count": len(group_nodes),
        "suggested_action_edge_count": len(action_edges),
        "fixture_evidence_edge_count": len(evidence_edges),
        "candidate_group_fact_count": len(group_facts),
        "candidate_evidence_fact_count": len([entry for entry in facts if entry["kind"] == "classifier_candidate_evidence"]),
        "groups_without_evidence": groups_without_evidence,
        "groups_without_action": groups_without_action,
        "failures": failures,
        "decision": "healthy" if failures == [] else "needs_review",
    }


def write_plan_from_projection(projection: dict[str, Any]) -> dict[str, Any]:
    node_statements = [
        f"UPSERT {record_ref('classifier_graph_node', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("label", surreal_string(entry["label"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string("classifier_candidate_projection")),
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
            ("source_kind", surreal_string("classifier_candidate_projection")),
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
            ("source_kind", surreal_string("classifier_candidate_projection")),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["facts"]
    ]
    statements = [*node_statements, *edge_statements, *fact_statements]
    return {
        "schema": "ax.classifier_candidate_graph_surreal_write_plan.v1",
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
        "decision": "ready_to_apply" if projection["decision"] == "candidate_graph_projection_ready" else "blocked",
    }


def main() -> int:
    args = parse_args()
    usefulness = load_json(args.usefulness)
    projection = projection_from_usefulness(usefulness, args.usefulness)
    write_plan = write_plan_from_projection(projection)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(projection, indent=2) + "\n")
    write_plan_out = Path(args.write_plan)
    write_plan_out.parent.mkdir(parents=True, exist_ok=True)
    write_plan_out.write_text(json.dumps(write_plan, indent=2) + "\n")
    if args.json:
        print(json.dumps({
            "projection": projection,
            "write_plan": write_plan,
        }, indent=2))
    else:
        print("candidate graph projection")
        print(f"decision: {projection['decision']}")
        print(f"nodes/edges/facts: {projection['totals']['node_count']}/{projection['totals']['edge_count']}/{projection['totals']['fact_count']}")
        print(f"candidate groups: {projection['health']['candidate_group_count']}")
        print(f"fixture evidence edges: {projection['health']['fixture_evidence_edge_count']}")
        print(f"write plan statements: {write_plan['totals']['statement_count']}")
        print(f"projection out: {out}")
        print(f"write plan out: {write_plan_out}")
    return 0 if projection["decision"] == "candidate_graph_projection_ready" and write_plan["decision"] == "ready_to_apply" else 1


if __name__ == "__main__":
    raise SystemExit(main())
