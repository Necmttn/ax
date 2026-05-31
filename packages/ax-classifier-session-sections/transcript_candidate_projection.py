#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

import sys

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project persisted transcript-backed classifier results into graph-ready candidate facts.")
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--min-confidence", type=float, default=0.74)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8521")
    parser.add_argument("--user", default="root")
    parser.add_argument("--pass", dest="password", default="root")
    parser.add_argument("--ns", default="ax")
    parser.add_argument("--db", default="main")
    parser.add_argument("--out", default=".ax/experiments/transcript-candidate-graph-projection-e155.json")
    parser.add_argument("--write-plan", default=".ax/experiments/transcript-candidate-graph-write-plan-e155.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def action_for_result(row: dict[str, Any]) -> str:
    classifier = str(row.get("classifier_key") or "")
    label = str(row.get("label") or "")
    target = str(row.get("target") or "")
    if classifier == "verification-event" or target in {"verification", "regression_guard", "test_required", "output_required"}:
        return "add_verification_gate"
    if label == "correction" or target in {"wrong_output", "wrong_artifact", "missing_context", "prototype_completeness"}:
        return "add_context_guardrail"
    if label == "approval":
        return "record_approval_checkpoint"
    if label == "direction":
        return "record_guidance_or_environment_preference"
    return "review_section_pattern"


def group_key(row: dict[str, Any]) -> str:
    return "::".join([
        str(row.get("classifier_key") or "unknown"),
        str(row.get("label") or "unknown"),
        str(row.get("target") or "unknown"),
        action_for_result(row),
    ])


def run_surreal_query(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    limit = max(1, int(args.limit))
    min_confidence = max(0.0, min(1.0, float(args.min_confidence)))
    sql = f"""
SELECT type::string(id) AS id, classifier_key, classifier_version, label, target, polarity, durability, confidence, method, type::string(session) AS session_id, type::string(turn) AS turn_id, turn.text_excerpt AS turn_text_excerpt, turn.seq AS turn_seq, ts, type::string(ts) AS ts_text
FROM classifier_result
WHERE confidence >= {min_confidence}
ORDER BY ts DESC
LIMIT {limit};
SELECT type::string(in) AS result_id, type::string(out) AS evidence_id, kind
FROM cites_evidence
WHERE type::string(in) CONTAINS "classifier_result:";
"""
    completed = subprocess.run(
        [
            "surreal",
            "sql",
            "--hide-welcome",
            "--json",
            "--multi",
            "--endpoint",
            args.endpoint,
            "--user",
            args.user,
            "--pass",
            args.password,
            "--ns",
            args.ns,
            "--db",
            args.db,
        ],
        input=sql,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "surreal query failed")
    chunks = []
    for line in completed.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            chunks.append(json.loads(stripped))
    if len(chunks) < 2:
        raise RuntimeError(f"expected two Surreal result chunks, got {len(chunks)}")
    return list(chunks[0][0] or []), list(chunks[1][0] or [])


def wrapper_like(row: dict[str, Any]) -> bool:
    text = str(row.get("turn_text_excerpt") or "").lstrip()
    return (
        text.startswith("<goal_context>") or
        text.startswith("<subagent_notification>") or
        text.startswith("<task>") or
        text.startswith("<task-notification>") or
        text.startswith("<environment_context>") or
        text.startswith("# AGENTS.md") or
        text.startswith("# CLAUDE.md") or
        "<INSTRUCTIONS>" in text
    )


def projection_from_rows(
    rows: list[dict[str, Any]],
    evidence_refs: list[dict[str, Any]],
    source: str,
    limit: int,
    min_confidence: float,
) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    facts: list[dict[str, Any]] = []
    refs_by_result: dict[str, list[dict[str, Any]]] = {}
    selected_ids = {str(row.get("id")) for row in rows}
    for ref in evidence_refs:
        result_id = str(ref.get("result_id") or "")
        if result_id in selected_ids:
            refs_by_result.setdefault(result_id, []).append(ref)

    source_node = f"artifact:{fact_id(source)}"
    nodes[source_node] = node(source_node, "artifact", source, {
        "path": source,
        "source": "classifier_result",
        "limit": limit,
        "min_confidence": min_confidence,
    })
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("ts_text") and not row.get("ts"):
            row["ts"] = row["ts_text"]
        groups.setdefault(group_key(row), []).append(row)

    result_fact_count = 0
    for key, group_rows in sorted(groups.items()):
        first = group_rows[0]
        action = action_for_result(first)
        classifier = str(first.get("classifier_key") or "unknown")
        label = str(first.get("label") or "unknown")
        target = str(first.get("target") or "unknown")
        group_node = f"classifier_candidate_group:{fact_id(f'transcript/{key}')}"
        action_node = f"classifier_graph_action:{fact_id(action)}"
        nodes[group_node] = node(group_node, "classifier_candidate_group", f"{classifier}:{label}:{target}", {
            "source": "transcript_classifier_results",
            "classifier_key": classifier,
            "label": label,
            "target": target,
            "proposed_action": action,
            "support_count": len(group_rows),
            "wrapper_like_count": sum(1 for row in group_rows if wrapper_like(row)),
        })
        nodes[action_node] = node(action_node, "classifier_graph_action", action, {"action": action})
        action_edge = f"edge:{fact_id(f'{group_node}->suggests_action->{action_node}')}"
        edges[action_edge] = edge(action_edge, "suggests_action", group_node, action_node, source, {
            "classifier_key": classifier,
            "label": label,
            "target": target,
            "support_count": len(group_rows),
        })
        support_edges = [action_edge]
        for row in group_rows:
            result_id = str(row.get("id") or "")
            result_node = f"classifier_result_ref:{fact_id(result_id)}"
            nodes[result_node] = node(result_node, "classifier_result", result_id, {
                "classifier_key": row.get("classifier_key"),
                "classifier_version": row.get("classifier_version"),
                "label": row.get("label"),
                "target": row.get("target"),
                "confidence": row.get("confidence"),
                "turn": row.get("turn_id"),
                "session": row.get("session_id"),
                "ts": row.get("ts"),
                "wrapper_like": wrapper_like(row),
            })
            emitted_edge = f"edge:{fact_id(f'{group_node}->supported_by_result->{result_node}')}"
            edges[emitted_edge] = edge(emitted_edge, "supported_by_result", group_node, result_node, source, {
                "confidence": row.get("confidence"),
                "turn": row.get("turn_id"),
            })
            support_edges.append(emitted_edge)
            turn_id = str(row.get("turn_id") or "")
            if turn_id and turn_id != "None":
                evidence_node = f"classifier_evidence:{fact_id(turn_id)}"
                nodes[evidence_node] = node(evidence_node, "classifier_transcript_evidence", turn_id, {
                    "session": row.get("session_id"),
                    "seq": row.get("turn_seq"),
                    "text_excerpt": row.get("turn_text_excerpt"),
                    "ts": row.get("ts"),
                })
                evidence_edge = f"edge:{fact_id(f'{result_node}->cites_turn->{evidence_node}')}"
                edges[evidence_edge] = edge(evidence_edge, "cites_transcript_evidence", result_node, evidence_node, source, {
                    "kind": "classified_turn",
                })
                support_edges.append(evidence_edge)
            for ref in refs_by_result.get(result_id, []):
                evidence_id = str(ref.get("evidence_id") or "")
                if not evidence_id:
                    continue
                evidence_node = f"classifier_evidence:{fact_id(evidence_id)}"
                nodes.setdefault(evidence_node, node(evidence_node, "classifier_transcript_evidence", evidence_id, {
                    "evidence_id": evidence_id,
                }))
                evidence_edge = f"edge:{fact_id(f'{result_node}->cites_evidence->{evidence_node}:{ref.get('kind')}')}"
                edges[evidence_edge] = edge(evidence_edge, "cites_transcript_evidence", result_node, evidence_node, source, {
                    "kind": ref.get("kind"),
                })
                support_edges.append(evidence_edge)
            facts.append(fact(
                f"fact:{fact_id(f'{result_node}:supports:{group_node}')}",
                "classifier_candidate_evidence",
                group_node,
                "supported_by_classifier_result",
                [emitted_edge],
                {
                    "result_id": result_id,
                    "classifier_key": row.get("classifier_key"),
                    "label": row.get("label"),
                    "target": row.get("target"),
                    "confidence": row.get("confidence"),
                    "turn": row.get("turn_id"),
                    "text_excerpt": row.get("turn_text_excerpt"),
                    "wrapper_like": wrapper_like(row),
                },
                object_id=result_node,
                value=True,
            ))
            result_fact_count += 1
        facts.append(fact(
            f"fact:{fact_id(f'{group_node}:suggests:{action}')}",
            "classifier_candidate_group",
            group_node,
            "suggests_graph_action",
            support_edges,
            {
                "classifier_key": classifier,
                "label": label,
                "target": target,
                "proposed_action": action,
                "support_count": len(group_rows),
                "wrapper_like_count": sum(1 for row in group_rows if wrapper_like(row)),
            },
            object_id=action_node,
            value=action,
        ))

    health = health_from_projection(list(nodes.values()), list(edges.values()), facts)
    return {
        "schema": "ax.transcript_classifier_candidate_graph_projection.v1",
        "source": source,
        "limit": limit,
        "min_confidence": min_confidence,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "facts": facts,
        "health": health,
        "totals": {
            "source_result_count": len(rows),
            "candidate_group_count": len(groups),
            "node_count": len(nodes),
            "edge_count": len(edges),
            "fact_count": len(facts),
            "candidate_group_fact_count": len(groups),
            "candidate_evidence_fact_count": result_fact_count,
        },
        "decision": "transcript_candidate_graph_projection_ready" if not health["failures"] else "needs_transcript_candidate_graph_projection_work",
    }


def health_from_projection(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], facts: list[dict[str, Any]]) -> dict[str, Any]:
    group_nodes = [entry for entry in nodes if entry["kind"] == "classifier_candidate_group"]
    result_edges = [entry for entry in edges if entry["kind"] == "supported_by_result"]
    evidence_edges = [entry for entry in edges if entry["kind"] == "cites_transcript_evidence"]
    action_edges = [entry for entry in edges if entry["kind"] == "suggests_action"]
    groups_without_results = [group["id"] for group in group_nodes if not any(edge["from"] == group["id"] for edge in result_edges)]
    groups_without_actions = [group["id"] for group in group_nodes if not any(edge["from"] == group["id"] for edge in action_edges)]
    groups_without_transcript_evidence = [
        group["id"]
        for group in group_nodes
        if not any(
            result_edge["from"] == group["id"] and any(evidence_edge["from"] == result_edge["to"] for evidence_edge in evidence_edges)
            for result_edge in result_edges
        )
    ]
    wrapper_like_count = sum(1 for fact_entry in facts if fact_entry["kind"] == "classifier_candidate_evidence" and fact_entry["properties"].get("wrapper_like") is True)
    failures: list[str] = []
    if not group_nodes:
        failures.append("no candidate group nodes")
    if groups_without_results:
        failures.append("candidate groups missing classifier result support")
    if groups_without_actions:
        failures.append("candidate groups missing suggested action")
    if groups_without_transcript_evidence:
        failures.append("candidate groups missing transcript evidence")
    return {
        "candidate_group_count": len(group_nodes),
        "supported_result_edge_count": len(result_edges),
        "transcript_evidence_edge_count": len(evidence_edges),
        "wrapper_like_result_count": wrapper_like_count,
        "groups_without_results": groups_without_results,
        "groups_without_actions": groups_without_actions,
        "groups_without_transcript_evidence": groups_without_transcript_evidence,
        "failures": failures,
        "review_warnings": ["wrapper-like classifier results need review"] if wrapper_like_count else [],
        "decision": "healthy" if not failures else "needs_review",
    }


def write_plan_from_projection(projection: dict[str, Any]) -> dict[str, Any]:
    node_statements = [
        f"UPSERT {record_ref('classifier_graph_node', entry['id'])} CONTENT " + surreal_object([
            ("graph_id", surreal_string(entry["id"])),
            ("kind", surreal_string(entry["kind"])),
            ("label", surreal_string(entry["label"])),
            ("properties_json", surreal_json_text(entry["properties"])),
            ("source_kind", surreal_string("transcript_classifier_projection")),
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
            ("source_kind", surreal_string("transcript_classifier_projection")),
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
            ("source_kind", surreal_string("transcript_classifier_projection")),
            ("updated_at", "time::now()"),
        ]) + ";"
        for entry in projection["facts"]
    ]
    statements = [*node_statements, *edge_statements, *fact_statements]
    return {
        "schema": "ax.transcript_classifier_candidate_graph_surreal_write_plan.v1",
        "source_projection_schema": projection["schema"],
        "source": projection["source"],
        "tables": ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"],
        "statements": statements,
        "totals": {
            "statement_count": len(statements),
            "node_statement_count": len(node_statements),
            "edge_statement_count": len(edge_statements),
            "fact_statement_count": len(fact_statements),
        },
        "decision": "ready_to_apply" if projection["decision"] == "transcript_candidate_graph_projection_ready" else "blocked",
    }


def main() -> int:
    args = parse_args()
    rows, refs = run_surreal_query(args)
    source = f"surrealdb://{args.ns}/{args.db}/classifier_result"
    projection = projection_from_rows(rows, refs, source, args.limit, args.min_confidence)
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
        print("transcript candidate graph projection")
        print(f"decision: {projection['decision']}")
        print(f"source results: {projection['totals']['source_result_count']}")
        print(f"candidate groups: {projection['totals']['candidate_group_count']}")
        print(f"nodes/edges/facts: {projection['totals']['node_count']}/{projection['totals']['edge_count']}/{projection['totals']['fact_count']}")
        print(f"transcript evidence edges: {projection['health']['transcript_evidence_edge_count']}")
        print(f"wrapper-like results: {projection['health']['wrapper_like_result_count']}")
        print(f"write plan statements: {write_plan['totals']['statement_count']}")
        print(f"projection out: {out}")
        print(f"write plan out: {write_plan_out}")
    return 0 if write_plan["decision"] == "ready_to_apply" else 1


if __name__ == "__main__":
    raise SystemExit(main())
