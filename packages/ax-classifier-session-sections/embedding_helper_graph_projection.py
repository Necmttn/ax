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


SOURCE_KIND = "embedding_helper_review_projection"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project embedding helper review artifacts into graph-ready facts.")
    parser.add_argument("--review", default=".ax/experiments/embedding-helper-review-current.json")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-graph-projection-current.json")
    parser.add_argument("--write-plan", default=".ax/experiments/embedding-helper-graph-write-plan-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def legacy_pending_hard_negative_fact_id(subject: str) -> str:
    return f"fact:{fact_id(f'{subject}:pending_hard_negative_review')}"


def load_jsonl(path: str) -> list[dict[str, Any]]:
    source = Path(path)
    if not source.exists():
        return []
    return [json.loads(line) for line in source.read_text().splitlines() if line.strip()]


def promoted_fixture_index(promoted_fixtures: list[dict[str, Any]] | None) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for fixture in promoted_fixtures or []:
        if fixture.get("source_group") != "embedding-helper-hard-negative":
            continue
        for key in (fixture.get("source_candidate_id"), fixture.get("source_fixture_id")):
            key_text = str(key or "")
            if key_text:
                index[key_text] = fixture
    return index


def routing_projection(
    review: dict[str, Any],
    source_node: str,
    source_path: str,
    nodes: dict[str, dict[str, Any]],
    edges: dict[str, dict[str, Any]],
    facts: list[dict[str, Any]],
) -> int:
    routing = review.get("routing") or {}
    recommended = routing.get("recommended_threshold") or {}
    if not recommended:
        return 0
    routing_node = "embedding_helper_routing:session-section-chunks"
    nodes[routing_node] = node(routing_node, "embedding_helper_routing_candidate", "embedding helper routing", {
        "decision": routing.get("decision"),
        "threshold": recommended.get("threshold"),
        "min_positive_recall": routing.get("min_positive_recall"),
        "setfit_call_reduction_rate_mean": recommended.get("setfit_call_reduction_rate_mean"),
        "positive_recall_after_routing_mean": recommended.get("positive_recall_after_routing_mean"),
        "none_rejection_precision_mean": recommended.get("none_rejection_precision_mean"),
        "none_rejection_recall_mean": recommended.get("none_rejection_recall_mean"),
        "positive_false_rejections_mean": recommended.get("positive_false_rejections_mean"),
    })
    emitted_edge = f"edge:{fact_id(f'{source_node}->emitted_routing_candidate->{routing_node}')}"
    edges[emitted_edge] = edge(emitted_edge, "emitted_routing_candidate", source_node, routing_node, source_path, {
        "threshold": recommended.get("threshold"),
        "decision": routing.get("decision"),
    })
    facts.append(fact(
        f"fact:{fact_id(f'{routing_node}:recommended_threshold')}",
        "embedding_helper_routing_candidate",
        routing_node,
        "recommended_threshold",
        [emitted_edge],
        {
            "threshold": recommended.get("threshold"),
            "setfit_call_reduction_rate_mean": recommended.get("setfit_call_reduction_rate_mean"),
            "positive_recall_after_routing_mean": recommended.get("positive_recall_after_routing_mean"),
            "none_rejection_precision_mean": recommended.get("none_rejection_precision_mean"),
            "none_rejection_recall_mean": recommended.get("none_rejection_recall_mean"),
            "positive_false_rejections_mean": recommended.get("positive_false_rejections_mean"),
            "review_required": True,
        },
        value={
            "threshold": recommended.get("threshold"),
            "positive_recall_after_routing_mean": recommended.get("positive_recall_after_routing_mean"),
        },
    ))
    return 1


def hard_negative_projection(
    review: dict[str, Any],
    source_node: str,
    source_path: str,
    nodes: dict[str, dict[str, Any]],
    edges: dict[str, dict[str, Any]],
    facts: list[dict[str, Any]],
    promoted_fixtures: list[dict[str, Any]] | None = None,
) -> int:
    count = 0
    promoted_by_key = promoted_fixture_index(promoted_fixtures)
    for candidate in review.get("hard_negative_candidates") or []:
        source_fixture_id = str(candidate.get("source_fixture_id") or "")
        if not source_fixture_id:
            continue
        candidate_id = str(candidate.get("id") or "")
        status = str(candidate.get("status") or "")
        promoted_fixture = promoted_by_key.get(candidate_id) or promoted_by_key.get(source_fixture_id)
        candidate_node = f"embedding_helper_hard_negative:{fact_id(source_fixture_id)}"
        fixture_node = f"classifier_evidence:{fact_id(source_fixture_id)}"
        nodes[candidate_node] = node(candidate_node, "embedding_helper_hard_negative_candidate", source_fixture_id, {
            "status": status,
            "proposed_label": candidate.get("proposed_label"),
            "seed_count": candidate.get("seed_count"),
            "seen_in_seeds": candidate.get("seen_in_seeds"),
            "predicted_label_counts": candidate.get("predicted_label_counts"),
            "max_confidence": candidate.get("max_confidence"),
            "max_margin": candidate.get("max_margin"),
            "max_nearest_positive_similarity": candidate.get("max_nearest_positive_similarity"),
            "review_instruction": candidate.get("review_instruction"),
            "promoted_fixture_id": promoted_fixture.get("id") if promoted_fixture else None,
        })
        nodes[fixture_node] = node(fixture_node, "classifier_fixture_evidence", source_fixture_id, {
            "fixture_id": source_fixture_id,
        })
        emitted_edge = f"edge:{fact_id(f'{source_node}->emitted_hard_negative_candidate->{candidate_node}')}"
        fixture_edge = f"edge:{fact_id(f'{candidate_node}->reviews_fixture->{fixture_node}')}"
        edges[emitted_edge] = edge(emitted_edge, "emitted_hard_negative_candidate", source_node, candidate_node, source_path, {
            "status": candidate.get("status"),
        })
        edges[fixture_edge] = edge(fixture_edge, "reviews_fixture", candidate_node, fixture_node, source_path, {
            "proposed_label": candidate.get("proposed_label"),
        })
        evidence_edges = [emitted_edge, fixture_edge]
        object_node = fixture_node
        predicate = "pending_human_acceptance"
        value = True
        review_required = True
        if status == "accepted" and promoted_fixture:
            promoted_fixture_id = str(promoted_fixture.get("id") or "")
            promoted_node = f"classifier_promoted_fixture:{fact_id(promoted_fixture_id)}"
            nodes[promoted_node] = node(promoted_node, "classifier_promoted_fixture", promoted_fixture_id, {
                "fixture_id": promoted_fixture_id,
                "source_fixture_id": source_fixture_id,
                "source_candidate_id": candidate_id,
                "label": promoted_fixture.get("label"),
                "target": promoted_fixture.get("target"),
                "source_group": promoted_fixture.get("source_group"),
            })
            promoted_edge = f"edge:{fact_id(f'{candidate_node}->promoted_as_fixture->{promoted_node}')}"
            edges[promoted_edge] = edge(promoted_edge, "promoted_as_fixture", candidate_node, promoted_node, source_path, {
                "fixture_id": promoted_fixture_id,
                "label": promoted_fixture.get("label"),
                "target": promoted_fixture.get("target"),
            })
            evidence_edges.append(promoted_edge)
            object_node = promoted_node
            predicate = "promoted_hard_negative_fixture"
            review_required = False
        elif status == "accepted":
            predicate = "accepted_missing_promoted_fixture"
        elif status == "rejected":
            predicate = "rejected_hard_negative_candidate"
            value = False
            review_required = False
        for neighbor in candidate.get("nearest_neighbors") or []:
            neighbor_id = str(neighbor.get("id") or "")
            if not neighbor_id:
                continue
            neighbor_node = f"classifier_evidence:{fact_id(neighbor_id)}"
            nodes.setdefault(neighbor_node, node(neighbor_node, "classifier_fixture_evidence", neighbor_id, {
                "fixture_id": neighbor_id,
                "label": neighbor.get("label"),
            }))
            neighbor_edge = f"edge:{fact_id(f'{candidate_node}->nearest_reviewed_fixture->{neighbor_node}')}"
            edges[neighbor_edge] = edge(neighbor_edge, "nearest_reviewed_fixture", candidate_node, neighbor_node, source_path, {
                "label": neighbor.get("label"),
                "similarity": neighbor.get("similarity"),
            })
            evidence_edges.append(neighbor_edge)
        facts.append(fact(
            f"fact:{fact_id(f'{candidate_node}:{predicate}')}",
            "embedding_helper_hard_negative_candidate",
            candidate_node,
            predicate,
            evidence_edges,
            {
                "source_fixture_id": source_fixture_id,
                "status": status,
                "proposed_label": candidate.get("proposed_label"),
                "seed_count": candidate.get("seed_count"),
                "predicted_label_counts": candidate.get("predicted_label_counts"),
                "max_nearest_positive_similarity": candidate.get("max_nearest_positive_similarity"),
                "promoted_fixture_id": promoted_fixture.get("id") if promoted_fixture else None,
                "review_required": review_required,
            },
            object_id=object_node,
            value=value,
        ))
        count += 1
    return count


def dedupe_projection(
    review: dict[str, Any],
    source_node: str,
    source_path: str,
    nodes: dict[str, dict[str, Any]],
    edges: dict[str, dict[str, Any]],
    facts: list[dict[str, Any]],
) -> int:
    count = 0
    for cluster in review.get("dedupe_clusters") or []:
        cluster_id = str(cluster.get("id") or "")
        if not cluster_id:
            continue
        cluster_node = f"embedding_helper_dedupe_cluster:{fact_id(cluster_id)}"
        nodes[cluster_node] = node(cluster_node, "embedding_helper_dedupe_cluster", cluster_id, {
            "status": cluster.get("status"),
            "source_fixture_ids": cluster.get("source_fixture_ids"),
            "labels": cluster.get("labels"),
            "review_instruction": cluster.get("review_instruction"),
        })
        emitted_edge = f"edge:{fact_id(f'{source_node}->emitted_dedupe_cluster->{cluster_node}')}"
        edges[emitted_edge] = edge(emitted_edge, "emitted_dedupe_cluster", source_node, cluster_node, source_path, {
            "status": cluster.get("status"),
        })
        evidence_edges = [emitted_edge]
        for fixture_id in cluster.get("source_fixture_ids") or []:
            fixture_node = f"classifier_evidence:{fact_id(str(fixture_id))}"
            nodes.setdefault(fixture_node, node(fixture_node, "classifier_fixture_evidence", str(fixture_id), {
                "fixture_id": fixture_id,
            }))
            fixture_edge = f"edge:{fact_id(f'{cluster_node}->dedupes_fixture->{fixture_node}')}"
            edges[fixture_edge] = edge(fixture_edge, "dedupes_fixture", cluster_node, fixture_node, source_path, {
                "cluster": cluster_id,
            })
            evidence_edges.append(fixture_edge)
        facts.append(fact(
            f"fact:{fact_id(f'{cluster_node}:pending_dedupe_review')}",
            "embedding_helper_dedupe_cluster",
            cluster_node,
            "pending_dedupe_review",
            evidence_edges,
            {
                "source_fixture_ids": cluster.get("source_fixture_ids"),
                "labels": cluster.get("labels"),
                "review_required": True,
            },
            value=True,
        ))
        count += 1
    return count


def projection_from_review(review: dict[str, Any], source_path: str, promoted_fixtures: list[dict[str, Any]] | None = None) -> dict[str, Any]:
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
        "schema": review.get("schema"),
        "decision": review.get("decision"),
        "classifier": review.get("classifier"),
        "model": review.get("model"),
        "label_mode": review.get("label_mode"),
    })
    package_edge = f"edge:{fact_id(f'{package_node}->has_helper_review->{source_node}')}"
    edges[package_edge] = edge(package_edge, "has_helper_review", package_node, source_node, source_path, {
        "decision": review.get("decision"),
    })

    routing_count = routing_projection(review, source_node, source_path, nodes, edges, facts)
    hard_negative_count = hard_negative_projection(review, source_node, source_path, nodes, edges, facts, promoted_fixtures)
    dedupe_count = dedupe_projection(review, source_node, source_path, nodes, edges, facts)
    health = health_from_projection(review, list(nodes.values()), list(edges.values()), facts)
    return {
        "schema": "ax.embedding_helper_graph_projection.v1",
        "source_schema": review.get("schema"),
        "source_decision": review.get("decision"),
        "source_report": source_path,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "facts": facts,
        "health": health,
        "totals": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "fact_count": len(facts),
            "routing_candidate_fact_count": routing_count,
            "hard_negative_candidate_fact_count": hard_negative_count,
            "dedupe_cluster_fact_count": dedupe_count,
            "promoted_hard_negative_fact_count": len([entry for entry in facts if entry["predicate"] == "promoted_hard_negative_fixture"]),
            "nearest_neighbor_edge_count": len([entry for entry in edges.values() if entry["kind"] == "nearest_reviewed_fixture"]),
        },
        "decision": "embedding_helper_graph_projection_ready" if not health["failures"] else "needs_embedding_helper_graph_projection_work",
    }


def health_from_projection(
    review: dict[str, Any],
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    facts: list[dict[str, Any]],
) -> dict[str, Any]:
    routing_facts = [entry for entry in facts if entry["kind"] == "embedding_helper_routing_candidate"]
    hard_negative_facts = [entry for entry in facts if entry["kind"] == "embedding_helper_hard_negative_candidate"]
    accepted_missing_promotion_facts = [entry for entry in facts if entry["predicate"] == "accepted_missing_promoted_fixture"]
    dedupe_facts = [entry for entry in facts if entry["kind"] == "embedding_helper_dedupe_cluster"]
    hard_negative_nodes = [entry for entry in nodes if entry["kind"] == "embedding_helper_hard_negative_candidate"]
    nearest_edges = [entry for entry in edges if entry["kind"] == "nearest_reviewed_fixture"]
    hard_negatives_without_neighbors = [
        entry["id"]
        for entry in hard_negative_nodes
        if not any(edge_entry["from"] == entry["id"] for edge_entry in nearest_edges)
    ]
    failures = list(review.get("failures") or [])
    if review.get("decision") != "ready_for_helper_review":
        failures.append("source helper review is not ready_for_helper_review")
    if not routing_facts:
        failures.append("no routing candidate fact")
    if not hard_negative_facts:
        failures.append("no hard-negative candidate facts")
    if accepted_missing_promotion_facts:
        failures.append("accepted hard-negative candidates missing promoted fixture evidence")
    if hard_negatives_without_neighbors:
        failures.append("hard-negative candidates missing nearest-neighbor evidence")
    if not dedupe_facts:
        failures.append("no dedupe cluster facts")
    return {
        "routing_candidate_fact_count": len(routing_facts),
        "hard_negative_candidate_fact_count": len(hard_negative_facts),
        "promoted_hard_negative_fact_count": len([entry for entry in facts if entry["predicate"] == "promoted_hard_negative_fixture"]),
        "dedupe_cluster_fact_count": len(dedupe_facts),
        "nearest_neighbor_edge_count": len(nearest_edges),
        "hard_negatives_without_neighbors": hard_negatives_without_neighbors,
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
            ("source_kind", surreal_string(SOURCE_KIND)),
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
            ("source_kind", surreal_string(SOURCE_KIND)),
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
            ("source_kind", surreal_string(SOURCE_KIND)),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["facts"]
    ]
    cleanup_statements = [
        f"DELETE {record_ref('classifier_graph_fact', legacy_pending_hard_negative_fact_id(str(entry['subject'])))};"
        for entry in projection["facts"]
        if entry["kind"] == "embedding_helper_hard_negative_candidate" and entry["predicate"] != "pending_human_acceptance"
    ]
    statements = [*cleanup_statements, *node_statements, *edge_statements, *fact_statements]
    return {
        "schema": "ax.embedding_helper_graph_surreal_write_plan.v1",
        "source_projection_schema": projection["schema"],
        "source_report": projection["source_report"],
        "tables": ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
        "statements": statements,
        "totals": {
            "statement_count": len(statements),
            "cleanup_statement_count": len(cleanup_statements),
            "node_statement_count": len(node_statements),
            "edge_statement_count": len(edge_statements),
            "fact_statement_count": len(fact_statements),
        },
        "decision": "ready_to_apply" if projection["decision"] == "embedding_helper_graph_projection_ready" else "blocked",
    }


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    promoted_fixtures = load_jsonl(args.fixtures)
    projection = projection_from_review(review, args.review, promoted_fixtures=promoted_fixtures)
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
        print("embedding helper graph projection")
        print(f"decision: {projection['decision']}")
        print(f"nodes/edges/facts: {projection['totals']['node_count']}/{projection['totals']['edge_count']}/{projection['totals']['fact_count']}")
        print(f"hard-negative candidates: {projection['totals']['hard_negative_candidate_fact_count']}")
        print(f"nearest-neighbor edges: {projection['totals']['nearest_neighbor_edge_count']}")
        print(f"dedupe clusters: {projection['totals']['dedupe_cluster_fact_count']}")
        print(f"write plan statements: {write_plan['totals']['statement_count']}")
        print(f"projection out: {out}")
        print(f"write plan out: {write_plan_out}")
    return 0 if write_plan["decision"] == "ready_to_apply" else 1


if __name__ == "__main__":
    raise SystemExit(main())
