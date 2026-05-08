#!/usr/bin/env bash
# Populate .references/ with Effect source for AI agent lookup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF_DIR="$ROOT/.references"
EFFECT_DIR="$REF_DIR/effect-smol"

mkdir -p "$REF_DIR"

if [ -d "$EFFECT_DIR/.git" ]; then
    echo "[refs] updating effect-smol"
    git -C "$EFFECT_DIR" fetch --depth 1 origin main
    git -C "$EFFECT_DIR" reset --hard origin/main
else
    echo "[refs] cloning effect-smol"
    git clone --depth 1 https://github.com/Effect-TS/effect-smol.git "$EFFECT_DIR"
fi
echo "[refs] effect-smol: $(du -sh "$EFFECT_DIR" | cut -f1) at HEAD $(git -C "$EFFECT_DIR" rev-parse --short HEAD)"
