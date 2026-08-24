#!/usr/bin/env python3
"""Optional embedding/SVM prioritizer for transcript label mining.

This helper is **advisory only**. It ranks weak-label candidates (from the
Task 3 mining report) by their nearest *reviewed* examples, surfaces hard
negatives (candidates whose nearest reviewed example carries a different label
than the weak label), and reports precision@20 when reviewed labels are present.

Hard rule (see plan "Promotion Rules"): this script must NEVER emit a
``promotion_safe=true`` field. Embedding/SVM output is raw model signal and may
not be promoted without human review. Every emitted row and the report carry
``promotion_safe=false`` so downstream consumers cannot mistake ranking for a
promotion decision.

Inputs:
- ``--candidates``: Task 3 mining report JSON (``{"review_rows": [...]}`` or a
  bare list of candidate rows). Each candidate needs ``candidate_id``,
  ``label_family``, ``weak_label`` and either a precomputed ``embedding`` or
  ``excerpt`` text (embedded with sentence-transformers).
- ``--reviewed``: reviewed fixture JSONL. One JSON object per line with
  ``candidate_id``, ``reviewed_label`` and either ``embedding`` or text.
- ``--embedding-cache`` (optional): path to a JSON ``{candidate_id: [floats]}``
  embedding cache to reuse vectors across runs.

Outputs:
- ``--out`` (default ``.ax/experiments/transcript-label-mining-priority-current.json``):
  ranked candidates, nearest reviewed candidate ids/scores, and precision@20.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

REPORT_SCHEMA = "ax.transcript_label_mining_priority.v1"
DEFAULT_OUT = ".ax/experiments/transcript-label-mining-priority-current.json"
PRECISION_AT_K = 20
TOP_NEIGHBORS = 3


class EmbeddingModelError(RuntimeError):
    """Raised when the embedding model is missing or a row has no embedding."""


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------


def load_candidates(path: str) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = raw.get("review_rows") or raw.get("candidates") or raw.get("items") or []
    else:  # pragma: no cover - defensive
        rows = []
    return [dict(row) for row in rows if isinstance(row, dict)]


def load_reviewed(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    text = Path(path).read_text()
    stripped = text.strip()
    if not stripped:
        return rows
    # The reviewed fixture is JSONL by spec, but tolerate a JSON array or a
    # wrapper object ({"items": [...]} / {"reviewed": [...]}). A *single* JSONL
    # line is itself a `{...}` object, so only treat a top-level object as a
    # wrapper when it actually carries an items/reviewed array - otherwise fall
    # through to per-line parsing so single-row JSONL is not silently dropped.
    if stripped[0] == "[":
        parsed = json.loads(stripped)
        if isinstance(parsed, list):
            return [dict(row) for row in parsed if isinstance(row, dict)]
    elif stripped[0] == "{" and "\n" not in stripped.rstrip():
        parsed = json.loads(stripped)
        if isinstance(parsed, dict) and ("items" in parsed or "reviewed" in parsed):
            items = parsed.get("items") or parsed.get("reviewed") or []
            return [dict(row) for row in items if isinstance(row, dict)]
        if isinstance(parsed, dict):
            return [dict(parsed)]
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if isinstance(obj, dict):
            rows.append(dict(obj))
    return rows


def load_embedding_cache(path: str | None) -> dict[str, list[float]]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    raw = json.loads(p.read_text())
    if not isinstance(raw, dict):
        return {}
    return {str(k): [float(x) for x in v] for k, v in raw.items() if isinstance(v, list)}


def write_json(path: str, payload: dict[str, Any]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n")


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------


def _row_text(row: dict[str, Any]) -> str:
    return str(row.get("excerpt") or row.get("text") or row.get("weak_label") or "")


def _row_id(row: dict[str, Any]) -> str:
    return str(row.get("candidate_id") or row.get("id") or "")


def _encode_texts(model_name: str, texts: list[str]) -> list[list[float]]:
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:  # pragma: no cover - import only when used
        raise EmbeddingModelError(
            f"embedding model '{model_name}' requested but sentence-transformers is unavailable: {exc}"
        ) from exc
    try:
        model = SentenceTransformer(model_name)
    except Exception as exc:  # pragma: no cover - network/model load
        raise EmbeddingModelError(
            f"failed to load embedding model '{model_name}': {exc}"
        ) from exc
    vectors = model.encode(texts, normalize_embeddings=False)
    return [[float(x) for x in vec] for vec in vectors]


def resolve_embeddings(
    rows: list[dict[str, Any]],
    embedding_model: str,
    cache: dict[str, list[float]],
    *,
    kind: str,
) -> list[list[float]]:
    """Return one embedding vector per row.

    ``embedding_model == "precomputed"`` means every row must already carry an
    ``embedding`` (or be present in the cache); a missing vector is a hard error
    so we never silently rank rows with no signal.
    """
    if not embedding_model:
        raise EmbeddingModelError(
            "embedding model is required: pass a sentence-transformers model name "
            "or 'precomputed' with per-row embedding vectors"
        )

    precomputed: list[list[float] | None] = []
    missing_text_rows: list[int] = []
    for index, row in enumerate(rows):
        vec = row.get("embedding")
        if vec is None:
            vec = cache.get(_row_id(row))
        if isinstance(vec, list) and vec:
            precomputed.append([float(x) for x in vec])
        else:
            precomputed.append(None)
            missing_text_rows.append(index)

    if not missing_text_rows:
        return [v for v in precomputed if v is not None]

    if embedding_model == "precomputed":
        missing_ids = [_row_id(rows[i]) or f"index:{i}" for i in missing_text_rows]
        raise EmbeddingModelError(
            f"embedding model 'precomputed' requires an embedding on every {kind} row; "
            f"missing for: {', '.join(missing_ids)}"
        )

    texts = [_row_text(rows[i]) for i in missing_text_rows]
    encoded = _encode_texts(embedding_model, texts)
    for slot, vec in zip(missing_text_rows, encoded):
        precomputed[slot] = vec
    return [v if v is not None else [] for v in precomputed]


# ---------------------------------------------------------------------------
# Similarity + ranking
# ---------------------------------------------------------------------------


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _reviewed_label(row: dict[str, Any]) -> str:
    return str(row.get("reviewed_label") or row.get("label") or row.get("weak_label") or "")


def nearest_neighbors(
    cand_vec: list[float],
    reviewed_vecs: list[list[float]],
    reviewed: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    scored = [
        {
            "candidate_id": _row_id(reviewed[i]),
            "label": _reviewed_label(reviewed[i]),
            "score": round(cosine(cand_vec, reviewed_vecs[i]), 6),
        }
        for i in range(len(reviewed))
    ]
    scored.sort(key=lambda item: (-float(item["score"]), str(item["candidate_id"])))
    return scored[:TOP_NEIGHBORS]


def prioritize(
    candidates: list[dict[str, Any]],
    reviewed: list[dict[str, Any]],
    *,
    embedding_model: str,
    embedding_cache: dict[str, list[float]] | None = None,
) -> dict[str, Any]:
    cache = embedding_cache or {}
    cand_vecs = resolve_embeddings(candidates, embedding_model, cache, kind="candidate")
    reviewed_vecs = (
        resolve_embeddings(reviewed, embedding_model, cache, kind="reviewed") if reviewed else []
    )

    ranked: list[dict[str, Any]] = []
    hard_negative_ids: list[str] = []
    for index, cand in enumerate(candidates):
        neighbors = nearest_neighbors(cand_vecs[index], reviewed_vecs, reviewed)
        nearest_ids = [n["candidate_id"] for n in neighbors]
        nearest_scores = [n["score"] for n in neighbors]
        nearest_label = neighbors[0]["label"] if neighbors else ""
        weak_label = str(cand.get("weak_label") or "")
        hard_negative = bool(neighbors) and nearest_label != "" and nearest_label != weak_label
        cid = _row_id(cand)
        if hard_negative:
            hard_negative_ids.append(cid)
        ranked.append(
            {
                "candidate_id": cid,
                "label_family": cand.get("label_family"),
                "weak_label": weak_label,
                "weak_confidence": cand.get("weak_confidence"),
                "nearest_reviewed_candidate_ids": nearest_ids,
                "nearest_scores": nearest_scores,
                "nearest_reviewed_label": nearest_label,
                "top_score": nearest_scores[0] if nearest_scores else 0.0,
                "hard_negative": hard_negative,
                # Advisory only: model ranking is never promotion-safe.
                "promotion_safe": False,
            }
        )

    # Rank by nearest reviewed similarity, hard negatives broken to a stable
    # order by id. Higher top_score first.
    ranked.sort(key=lambda row: (-float(row["top_score"]), str(row["candidate_id"])))

    precision_at_20 = compute_precision_at_k(ranked, candidates, reviewed)

    return {
        "schema": REPORT_SCHEMA,
        "embedding_model": embedding_model,
        "candidate_count": len(candidates),
        "reviewed_count": len(reviewed),
        "ranked_candidates": ranked,
        "hard_negative_candidate_ids": hard_negative_ids,
        "hard_negative_count": len(hard_negative_ids),
        "precision_at_20": precision_at_20,
        # Report-level guard: nothing here may be promoted without review.
        "promotion_safe": False,
        "advisory_only": True,
    }


def compute_precision_at_k(
    ranked: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    reviewed: list[dict[str, Any]],
) -> float | None:
    """Precision@20: fraction of the top-K ranked candidates whose weak label
    matches the reviewed (accepted) label for the same candidate id.

    Returns ``None`` when no reviewed labels overlap the ranked candidates.
    """
    if not reviewed:
        return None
    reviewed_by_id: dict[str, str] = {}
    for row in reviewed:
        status = str(row.get("review_status") or "accepted")
        if status not in ("accepted", "revised"):
            continue
        reviewed_by_id[_row_id(row)] = _reviewed_label(row)
    if not reviewed_by_id:
        return None

    top = ranked[:PRECISION_AT_K]
    evaluated = 0
    correct = 0
    for row in top:
        cid = str(row["candidate_id"])
        if cid not in reviewed_by_id:
            continue
        evaluated += 1
        if str(row.get("weak_label") or "") == reviewed_by_id[cid]:
            correct += 1
    if evaluated == 0:
        return None
    return round(correct / evaluated, 6)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Advisory embedding/SVM prioritizer for transcript label mining (never promotion-safe)."
    )
    parser.add_argument(
        "--candidates",
        default=".ax/experiments/transcript-label-mining-current.json",
        help="Task 3 mining report JSON.",
    )
    parser.add_argument(
        "--reviewed",
        default="",
        help="Reviewed fixture JSONL (optional; enables precision@20 + hard negatives).",
    )
    parser.add_argument(
        "--embedding-cache",
        default="",
        help="Optional JSON embedding cache {candidate_id: [floats]}.",
    )
    parser.add_argument(
        "--embedding-model",
        default="sentence-transformers/all-MiniLM-L6-v2",
        help="sentence-transformers model name, or 'precomputed' to require per-row vectors.",
    )
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    candidates = load_candidates(args.candidates)
    reviewed = load_reviewed(args.reviewed) if args.reviewed else []
    cache = load_embedding_cache(args.embedding_cache or None)

    try:
        report = prioritize(
            candidates,
            reviewed,
            embedding_model=args.embedding_model,
            embedding_cache=cache,
        )
    except EmbeddingModelError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    report["out_path"] = args.out
    write_json(args.out, report)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("transcript label mining priority report")
        print(f"candidates: {report['candidate_count']}")
        print(f"reviewed: {report['reviewed_count']}")
        print(f"hard negatives: {report['hard_negative_count']}")
        print(f"precision@20: {report['precision_at_20']}")
        print(f"promotion_safe: {report['promotion_safe']}")
        print(f"out: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
