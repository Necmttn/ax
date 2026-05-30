-- ax turn content blocks: Surrealist inspection pack
--
-- Prereq:
--   axctl ingest --stages=turn-content-blocks --since=7
--
-- Surrealist connection:
--   endpoint: ws://127.0.0.1:8521
--   user/pass: root/root
--   namespace: ax
--   database: main

-- 1. Latest parsed turn documents.
SELECT
    id,
    source_ref,
    turn,
    session,
    agent_event,
    title,
    parser_id,
    parser_version,
    blockset_hash,
    metrics,
    ts
FROM content_document
WHERE source_kind = "turn"
ORDER BY ts DESC
LIMIT 20;

-- 2. Pick the newest parsed turn document and show its block tree.
LET $doc = (
    SELECT VALUE id
    FROM content_document
    WHERE source_kind = "turn"
    ORDER BY ts DESC
    LIMIT 1
)[0];

SELECT
    id,
    seq,
    parent_seq,
    kind,
    role,
    heading,
    start_offset,
    end_offset,
    text_excerpt,
    labels
FROM content_block
WHERE document = $doc
ORDER BY seq;

-- 3. Atoms extracted from that same turn, grouped by block.
SELECT
    id,
    block,
    kind,
    value,
    normalized,
    confidence,
    raw
FROM content_atom
WHERE document = $doc
ORDER BY block, kind, value;

-- 4. Single payload for the prototype UI.
-- Copy the result JSON into docs/prototypes/turn-content-blocks-dashboard.html.
LET $doc_for_ui = (
    SELECT VALUE id
    FROM content_document
    WHERE source_kind = "turn"
    ORDER BY ts DESC
    LIMIT 1
)[0];

RETURN {
    document: (SELECT * FROM ONLY $doc_for_ui),
    blocks: (
        SELECT
            id,
            seq,
            parent_seq,
            kind,
            role,
            heading,
            text,
            text_excerpt,
            search_text,
            start_offset,
            end_offset,
            confidence,
            parser,
            labels,
            metrics
        FROM content_block
        WHERE document = $doc_for_ui
        ORDER BY seq
    ),
    atoms: (
        SELECT
            id,
            block,
            document,
            source_kind,
            session,
            kind,
            value,
            normalized,
            start_offset,
            end_offset,
            confidence,
            raw
        FROM content_atom
        WHERE document = $doc_for_ui
        ORDER BY block, kind, value
    )
};

-- 5. Provider/session coverage: how many turn documents and extracted parts exist.
SELECT
    session,
    count() AS documents,
    math::sum(<int>metrics.textLength) AS raw_chars
FROM content_document
WHERE source_kind = "turn"
GROUP BY session
ORDER BY documents DESC
LIMIT 25;

SELECT
    kind,
    count() AS blocks
FROM content_block
WHERE source_kind = "turn"
GROUP BY kind
ORDER BY blocks DESC;

SELECT
    kind,
    count() AS atoms
FROM content_atom
WHERE source_kind = "turn"
GROUP BY kind
ORDER BY atoms DESC;

-- 6. Find turns mentioning a file, symbol, URL, command, or tool.
-- Replace "src/ingest/turn-content-blocks.ts" with the thing you care about.
LET $needle = "src/ingest/turn-content-blocks.ts";

SELECT
    document,
    session,
    kind,
    value,
    block
FROM content_atom
WHERE source_kind = "turn"
  AND (value = $needle OR normalized = $needle)
ORDER BY document
LIMIT 50;

-- 7. BM25 search over capped block text.
-- Replace "content blocks" with any keywords.
SELECT
    id,
    document,
    kind,
    role,
    heading,
    search::score(0) AS score,
    search::highlight("<mark>", "</mark>", 0) AS highlighted
FROM content_block
WHERE source_kind = "turn"
  AND search_text @0@ "content blocks"
ORDER BY score DESC
LIMIT 25;

-- 8. A session-level block timeline.
-- Pick latest session with parsed turn content.
LET $session = (
    SELECT VALUE session
    FROM content_document
    WHERE source_kind = "turn" AND session != NONE
    ORDER BY ts DESC
    LIMIT 1
)[0];

SELECT
    document,
    seq,
    kind,
    role,
    heading,
    text_excerpt
FROM content_block
WHERE source_kind = "turn"
  AND document IN (
      SELECT VALUE id
      FROM content_document
      WHERE source_kind = "turn" AND session = $session
  )
ORDER BY document, seq
LIMIT 200;

-- 9. Same data via curl, if you do not want Surrealist.
-- curl -sS -u root:root \
--   -H 'Accept: application/json' \
--   -H 'NS: ax' \
--   -H 'DB: main' \
--   --data-binary 'SELECT count() AS blocks FROM content_block WHERE source_kind = "turn" GROUP ALL;' \
--   http://127.0.0.1:8521/sql
