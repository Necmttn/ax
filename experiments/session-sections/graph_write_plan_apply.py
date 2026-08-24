#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any, Callable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply a classifier graph Surreal write plan.")
    parser.add_argument("--write-plan", default=".ax/experiments/hybrid-window-candidate-graph-write-plan-current.json")
    parser.add_argument("--out", default=".ax/experiments/hybrid-window-candidate-graph-apply-current.json")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8521")
    parser.add_argument("--user", default="root")
    parser.add_argument("--pass", dest="password", default="root")
    parser.add_argument("--ns", default="ax")
    parser.add_argument("--db", default="main")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def run_surreal_statements(args: argparse.Namespace, statements: list[str]) -> None:
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
        input="\n".join(statements) + "\n",
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "surreal statement failed")


def apply_batched_report(
    write_plan: dict[str, Any],
    write_plan_path: str,
    apply_statements: Callable[[list[str]], None],
    dry_run: bool = False,
) -> dict[str, Any]:
    statements = [str(statement) for statement in write_plan.get("statements") or []]
    tables = [str(table) for table in write_plan.get("tables") or []]
    if write_plan.get("decision") != "ready_to_apply":
        return {
            "schema": "ax.classifier_graph_write_plan_apply_report.v1",
            "write_plan": write_plan_path,
            "source_write_plan_schema": write_plan.get("schema"),
            "source_projection_schema": write_plan.get("source_projection_schema"),
            "dry_run": dry_run,
            "applied": False,
            "attempted_statement_count": len(statements),
            "applied_statement_count": 0,
            "failed_statement_count": len(statements),
            "tables": tables,
            "failures": ["write plan is not ready_to_apply"],
            "decision": "blocked",
        }
    if dry_run:
        return {
            "schema": "ax.classifier_graph_write_plan_apply_report.v1",
            "write_plan": write_plan_path,
            "source_write_plan_schema": write_plan.get("schema"),
            "source_projection_schema": write_plan.get("source_projection_schema"),
            "dry_run": True,
            "applied": False,
            "attempted_statement_count": len(statements),
            "applied_statement_count": 0,
            "failed_statement_count": 0,
            "tables": tables,
            "failures": [],
            "decision": "dry_run_ready",
        }
    try:
        apply_statements(statements)
    except Exception as error:
        return {
            "schema": "ax.classifier_graph_write_plan_apply_report.v1",
            "write_plan": write_plan_path,
            "source_write_plan_schema": write_plan.get("schema"),
            "source_projection_schema": write_plan.get("source_projection_schema"),
            "dry_run": False,
            "applied": False,
            "attempted_statement_count": len(statements),
            "applied_statement_count": 0,
            "failed_statement_count": len(statements),
            "first_failure": {
                "index": None,
                "statement": None,
                "message": str(error),
            },
            "tables": tables,
            "failures": ["failed to apply write plan batch"],
            "decision": "failed",
        }
    return {
        "schema": "ax.classifier_graph_write_plan_apply_report.v1",
        "write_plan": write_plan_path,
        "source_write_plan_schema": write_plan.get("schema"),
        "source_projection_schema": write_plan.get("source_projection_schema"),
        "dry_run": False,
        "applied": True,
        "attempted_statement_count": len(statements),
        "applied_statement_count": len(statements),
        "failed_statement_count": 0,
        "tables": tables,
        "failures": [],
        "decision": "applied",
    }


def apply_report(
    write_plan: dict[str, Any],
    write_plan_path: str,
    apply_statement: Callable[[str], None],
    dry_run: bool = False,
) -> dict[str, Any]:
    statements = [str(statement) for statement in write_plan.get("statements") or []]
    tables = [str(table) for table in write_plan.get("tables") or []]
    if write_plan.get("decision") != "ready_to_apply":
        return {
            "schema": "ax.classifier_graph_write_plan_apply_report.v1",
            "write_plan": write_plan_path,
            "source_write_plan_schema": write_plan.get("schema"),
            "source_projection_schema": write_plan.get("source_projection_schema"),
            "dry_run": dry_run,
            "applied": False,
            "attempted_statement_count": len(statements),
            "applied_statement_count": 0,
            "failed_statement_count": len(statements),
            "tables": tables,
            "failures": ["write plan is not ready_to_apply"],
            "decision": "blocked",
        }
    if dry_run:
        return {
            "schema": "ax.classifier_graph_write_plan_apply_report.v1",
            "write_plan": write_plan_path,
            "source_write_plan_schema": write_plan.get("schema"),
            "source_projection_schema": write_plan.get("source_projection_schema"),
            "dry_run": True,
            "applied": False,
            "attempted_statement_count": len(statements),
            "applied_statement_count": 0,
            "failed_statement_count": 0,
            "tables": tables,
            "failures": [],
            "decision": "dry_run_ready",
        }
    applied = 0
    for index, statement in enumerate(statements):
        try:
            apply_statement(statement)
            applied += 1
        except Exception as error:
            return {
                "schema": "ax.classifier_graph_write_plan_apply_report.v1",
                "write_plan": write_plan_path,
                "source_write_plan_schema": write_plan.get("schema"),
                "source_projection_schema": write_plan.get("source_projection_schema"),
                "dry_run": False,
                "applied": False,
                "attempted_statement_count": len(statements),
                "applied_statement_count": applied,
                "failed_statement_count": len(statements) - applied,
                "first_failure": {
                    "index": index,
                    "statement": statement,
                    "message": str(error),
                },
                "tables": tables,
                "failures": ["failed to apply write plan statement"],
                "decision": "failed",
            }
    return {
        "schema": "ax.classifier_graph_write_plan_apply_report.v1",
        "write_plan": write_plan_path,
        "source_write_plan_schema": write_plan.get("schema"),
        "source_projection_schema": write_plan.get("source_projection_schema"),
        "dry_run": False,
        "applied": True,
        "attempted_statement_count": len(statements),
        "applied_statement_count": applied,
        "failed_statement_count": 0,
        "tables": tables,
        "failures": [],
        "decision": "applied",
    }


def main() -> int:
    args = parse_args()
    report = apply_batched_report(
        load_json(args.write_plan),
        args.write_plan,
        lambda statements: run_surreal_statements(args, statements),
        args.dry_run,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("classifier graph write plan apply")
        print(f"decision: {report['decision']}")
        print(f"applied: {report['applied']}")
        print(f"statements applied/attempted: {report['applied_statement_count']}/{report['attempted_statement_count']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] in {"applied", "dry_run_ready"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
