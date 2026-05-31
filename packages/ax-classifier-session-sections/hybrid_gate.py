#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "setfit>=1.1,<2",
#   "transformers>=4.41,<4.57",
# ]
# ///
from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any


COARSE_BY_LIGHT_LABEL = {
    "direction": "environment_or_preference_signal",
    "tooling_or_environment_issue": "environment_or_preference_signal",
    "correction": "correction_or_rejection_signal",
    "rejection": "correction_or_rejection_signal",
    "verification_request": "verification_or_recovery_signal",
    "recovery_action": "verification_or_recovery_signal",
    "approval": "approval",
    "none": "none",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate deterministic + SetFit hybrid classifier gating.")
    parser.add_argument("--windows", default=".ax/experiments/model-windows-e1.jsonl")
    parser.add_argument("--model-dir", default=".ax/experiments/setfit-session-sections-coarse-model")
    parser.add_argument("--out", default=".ax/experiments/hybrid-gate-e4.json")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--deterministic-confidence", type=float, default=0.75)
    parser.add_argument("--model-confidence", type=float, default=0.60)
    parser.add_argument("--unlabeled-min-tokens", type=int, default=180)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_windows(path: str, limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
        if len(rows) >= limit:
            break
    return rows


def light_results(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [result for result in row.get("light_results") or [] if isinstance(result, dict)]


def evidence_refs(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [evidence for evidence in row.get("evidence") or [] if isinstance(evidence, dict)]


def has_evidence_kind(row: dict[str, Any], kind: str) -> bool:
    return any(str(evidence.get("kind")) == kind for evidence in evidence_refs(row))


def has_tool_or_file_evidence(row: dict[str, Any]) -> bool:
    return any(str(evidence.get("kind")) in {"recent_tool_failure", "recent_edited_file"} for evidence in evidence_refs(row))


def has_causal_evidence(row: dict[str, Any]) -> bool:
    return has_evidence_kind(row, "previous_assistant") and has_tool_or_file_evidence(row)


def coarse_labels_for_light(row: dict[str, Any]) -> set[str]:
    labels = set()
    for result in light_results(row):
        label = str(result.get("label") or "")
        if label in COARSE_BY_LIGHT_LABEL:
            labels.add(COARSE_BY_LIGHT_LABEL[label])
    return labels


def max_light_confidence(row: dict[str, Any]) -> float:
    confidences = [
        float(result.get("confidence") or 0.0)
        for result in light_results(row)
    ]
    return max(confidences) if confidences else 0.0


def should_run_setfit(row: dict[str, Any], deterministic_confidence: float, unlabeled_min_tokens: int = 180) -> tuple[bool, str]:
    results = light_results(row)
    if not results:
        if not has_causal_evidence(row):
            return False, "unlabeled_without_causal_evidence"
        if int(row.get("approx_tokens") or 0) < unlabeled_min_tokens:
            return False, "unlabeled_not_context_rich"
        return True, "unlabeled"
    coarse = coarse_labels_for_light(row)
    if len(coarse) > 1:
        return True, "conflicting_deterministic_labels"
    if max_light_confidence(row) < deterministic_confidence:
        return True, "low_confidence_deterministic"
    return False, "deterministic_high_confidence"


def positive_model_label(label: str, confidence: float, threshold: float) -> bool:
    return label != "none" and confidence >= threshold


def failure_reasons(report: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if report["setfit_run_rate"] >= 0.40:
        failures.append("SetFit run rate is not below 40% of windows")
    if report["model_only_positive_count"] > 0 and report["model_only_evidence_coverage"] < 1.0:
        failures.append("model-only positive labels do not all have evidence refs")
    if report["useful_new_fact_rate"] < 0.10:
        failures.append("model-only useful fact rate is below 10% of deterministic positives")
    return failures


def tensor_rows(value: Any) -> list[list[float]]:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return [[float(item) for item in row] for row in value.tolist()]


def predict_batch(model: Any, texts: list[str], labels: list[str]) -> list[dict[str, Any]]:
    probas = tensor_rows(model.predict_proba(texts))
    rows = []
    for proba in probas:
        best_index = max(range(len(proba)), key=lambda index: proba[index])
        rows.append({
            "label": labels[best_index],
            "confidence": round(proba[best_index], 4),
        })
    return rows


def compact_text(text: str, limit: int = 220) -> str:
    squashed = " ".join(text.split())
    if len(squashed) <= limit:
        return squashed
    return squashed[: limit - 1].rstrip() + "..."


def model_candidate(row: dict[str, Any], prediction: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "label": prediction["label"],
        "confidence": prediction["confidence"],
        "run_reason": reason,
        "session": row.get("session"),
        "turn": row.get("turn"),
        "seq": row.get("seq"),
        "ts": row.get("ts"),
        "approx_tokens": row.get("approx_tokens"),
        "evidence": evidence_refs(row),
        "text_excerpt": compact_text(str(row.get("text") or "")),
    }


def build_report(
    windows: list[dict[str, Any]],
    predictions_by_id: dict[str, dict[str, Any]],
    run_reasons: dict[str, str],
    elapsed_seconds: float,
    model_confidence: float,
) -> dict[str, Any]:
    total = len(windows)
    deterministic_positive = [row for row in windows if light_results(row)]
    sent = [row for row in windows if row.get("id") in predictions_by_id]
    model_only_positive = []
    model_only_candidates = []
    disagreements = []
    for row in sent:
        prediction = predictions_by_id[str(row.get("id"))]
        label = str(prediction["label"])
        confidence = float(prediction["confidence"])
        if not positive_model_label(label, confidence, model_confidence):
            continue
        coarse = coarse_labels_for_light(row)
        if not coarse:
            model_only_positive.append(row)
            model_only_candidates.append(model_candidate(row, prediction, run_reasons.get(str(row.get("id")), "unknown")))
        elif label not in coarse:
            disagreements.append({
                "id": row.get("id"),
                "light_labels": sorted(coarse),
                "model_label": label,
                "confidence": confidence,
            })

    with_evidence = [row for row in model_only_positive if evidence_refs(row)]
    reason_counts = Counter(run_reasons.values())
    prediction_counts = Counter(str(prediction["label"]) for prediction in predictions_by_id.values())
    report = {
        "windows": total,
        "deterministic_positive_count": len(deterministic_positive),
        "setfit_sent_count": len(sent),
        "setfit_run_rate": round(len(sent) / total, 4) if total else 0.0,
        "run_reasons": dict(sorted(reason_counts.items())),
        "model_confidence_threshold": model_confidence,
        "model_prediction_counts": dict(sorted(prediction_counts.items())),
        "model_only_positive_count": len(model_only_positive),
        "model_only_with_evidence": len(with_evidence),
        "model_only_evidence_coverage": round(len(with_evidence) / len(model_only_positive), 4) if model_only_positive else 1.0,
        "model_only_candidates": model_only_candidates[:250],
        "useful_new_fact_rate": round(len(model_only_positive) / len(deterministic_positive), 4) if deterministic_positive else 0.0,
        "disagreement_count": len(disagreements),
        "disagreements": disagreements[:20],
        "elapsed_seconds": round(elapsed_seconds, 2),
        "p95_ms_per_1k_windows": round((elapsed_seconds * 1000 / max(1, len(sent))) * 1000, 2) if sent else 0.0,
    }
    report["failures"] = failure_reasons(report)
    return report


def main() -> int:
    from setfit import SetFitModel

    args = parse_args()
    windows = load_windows(args.windows, args.limit)
    run_reasons: dict[str, str] = {}
    skip_reasons: Counter[str] = Counter()
    selected = []
    for row in windows:
        should_run, reason = should_run_setfit(row, args.deterministic_confidence, args.unlabeled_min_tokens)
        if should_run:
            selected.append(row)
            run_reasons[str(row.get("id"))] = reason
        else:
            skip_reasons[reason] += 1

    model = SetFitModel.from_pretrained(args.model_dir)
    labels = list(model.labels)
    predictions_by_id: dict[str, dict[str, Any]] = {}
    started = time.perf_counter()
    for start in range(0, len(selected), args.batch_size):
        batch = selected[start : start + args.batch_size]
        predictions = predict_batch(model, [str(row.get("text") or "") for row in batch], labels)
        for row, prediction in zip(batch, predictions, strict=True):
            predictions_by_id[str(row.get("id"))] = prediction
    elapsed_seconds = time.perf_counter() - started

    report = build_report(
        windows=windows,
        predictions_by_id=predictions_by_id,
        run_reasons=run_reasons,
        elapsed_seconds=elapsed_seconds,
        model_confidence=args.model_confidence,
    )
    report.update({
        "windows_path": args.windows,
        "model_dir": args.model_dir,
        "deterministic_confidence_threshold": args.deterministic_confidence,
        "unlabeled_min_tokens": args.unlabeled_min_tokens,
        "skip_reasons": dict(sorted(skip_reasons.items())),
    })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("hybrid classifier gate report")
        print(f"windows: {report['windows']}")
        print(f"deterministic positives: {report['deterministic_positive_count']}")
        print(f"setfit sent: {report['setfit_sent_count']} ({report['setfit_run_rate']})")
        print(f"run reasons: {report['run_reasons']}")
        print(f"skip reasons: {report['skip_reasons']}")
        print(f"model-only positives: {report['model_only_positive_count']}")
        print(f"model-only evidence coverage: {report['model_only_evidence_coverage']}")
        print(f"useful new fact rate: {report['useful_new_fact_rate']}")
        print(f"disagreements: {report['disagreement_count']}")
        print(f"runtime p95 ms / 1k sent windows: {report['p95_ms_per_1k_windows']}")
        print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
