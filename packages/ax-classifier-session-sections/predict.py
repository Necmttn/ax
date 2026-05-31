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
from pathlib import Path

from setfit import SetFitModel


def main() -> int:
    parser = argparse.ArgumentParser(description="Predict session-section chunk labels with a saved SetFit model.")
    parser.add_argument("--model-dir", default=".ax/experiments/setfit-session-sections-model")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    rows = [json.loads(line) for line in Path(args.input).read_text().splitlines() if line.strip()]
    model = SetFitModel.from_pretrained(args.model_dir)
    predictions = list(model.predict([str(row.get("text") or "") for row in rows]))
    out_rows = [
        {
            "id": row.get("id"),
            "label": str(prediction),
        }
        for row, prediction in zip(rows, predictions, strict=True)
    ]
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text("\n".join(json.dumps(row) for row in out_rows) + "\n")
    print(f"wrote {len(out_rows)} predictions to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
