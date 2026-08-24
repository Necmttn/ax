#!/usr/bin/env python3
from __future__ import annotations

MIN_REVIEW_NOTE_CHARS = 8
MIN_REVIEW_NOTE_WORDS = 2
PENDING_REVIEW_NOTES = {"", "_pending_"}


def note_present(value: str | None) -> bool:
    return str(value or "").strip() not in PENDING_REVIEW_NOTES


def note_substantive(value: str | None) -> bool:
    if not note_present(value):
        return False
    normalized = " ".join(str(value).strip().split())
    return len(normalized) >= MIN_REVIEW_NOTE_CHARS and len(normalized.split()) >= MIN_REVIEW_NOTE_WORDS
