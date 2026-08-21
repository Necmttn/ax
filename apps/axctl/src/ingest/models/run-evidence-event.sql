-- model: run_evidence_event
-- inputs: session, tool_call, command_outcome, compaction, plan_snapshot, turn, hook_command_invocation, checkout, spawned
-- rebuild: incremental
--
-- The run-evidence event ledger (#578), derived INSIDE DuckDB (#888) - this
-- replaces the TS round trip (12 reads -> JS map -> putMany) that cost ~74s
-- per ingest. Semantics mirror derive-run-evidence.ts's pure mappers, which
-- stay in the tree as the shadow implementation (AX_RUN_EVIDENCE_IMPL=ts) for
-- one release; the parity test diffs the two row-for-row on the natural key.
--
-- DELIBERATE DIFFERENCES from the TS builders (rebuildable-cache freedoms):
--  * id = md5(session <US> source_table <US> source_id) - stableDigest is
--    Bun.hash and cannot be computed in SQL. The cutover wipes TS-era rows
--    (version-marked), so the two schemes never coexist.
--  * verification uses the STAMPED command_outcome.check_family (#471
--    text-first fix) - the TS classifier stays the single source of truth,
--    stamped at outcomes-write time; this model never re-classifies.
--
-- Window: SET VARIABLE since_days (NULL/unset = full derivation).
-- ICU-less build: the clock MUST be spelled CAST(CURRENT_TIMESTAMP AS TIMESTAMP).
INSERT INTO run_evidence_event (
    id, session, root_session, parent_session, ts, provider, kind, backing,
    turn, tool_call, agent_event, compaction, plan_snapshot, command_outcome,
    hook_invocation, artifact, file, checkout, "commit",
    source_table, source_id, summary, content_hash, input_hash, output_hash, attrs
)
WITH RECURSIVE
params AS (
    SELECT CASE
        WHEN getvariable('since_days') IS NULL THEN NULL
        ELSE CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(getvariable('since_days') AS INTEGER) * INTERVAL '1 day')
    END AS cutoff
),
-- Parent/root lineage from `spawned` (parent -> child). min(in_id) makes a
-- duplicate-parent child deterministic; depth cap 32 guards cycles (the TS
-- walker's seen-set equivalent).
parent_of AS (
    SELECT out_id AS child, min(in_id) AS parent
    FROM spawned
    WHERE in_id IS NOT NULL AND out_id IS NOT NULL AND in_id <> out_id
    GROUP BY 1
),
walk AS (
    SELECT child, parent, parent AS root, 1 AS depth FROM parent_of
    UNION ALL
    SELECT w.child, w.parent, p.parent AS root, w.depth + 1
    FROM walk w
    JOIN parent_of p ON p.child = w.root
    WHERE w.depth < 32
),
lineage AS (
    SELECT child, any_value(parent) AS parent, arg_max(root, depth) AS root
    FROM walk GROUP BY child
),
affected_objective_sessions AS (
    SELECT DISTINCT t.session
    FROM turn t, params p
    WHERE t.session IS NOT NULL AND t.role = 'user' AND t.message_kind = 'task'
      AND (p.cutoff IS NULL OR t.ts > p.cutoff)
),
src AS (
    -- tool_call -> tool_observation (tool_backed). The NULL link columns are
    -- CAST here because UNION type inference reads the FIRST branch: a bare
    -- NULL types as INTEGER and the repo_state branch's checkout id would
    -- then fail to cast.
    SELECT tc.session AS session, tc.ts AS ts, 'tool_observation' AS kind, 'tool_backed' AS backing,
           CAST(NULL AS VARCHAR) AS turn, tc.id AS tool_call,
           CAST(NULL AS VARCHAR) AS compaction, CAST(NULL AS VARCHAR) AS plan_snapshot,
           CAST(NULL AS VARCHAR) AS command_outcome, CAST(NULL AS VARCHAR) AS hook_invocation,
           CAST(NULL AS VARCHAR) AS checkout,
           'tool_call' AS source_table, tc.id AS source_id,
           tc.name AS summary,
           -- Chains start from '{}': merge-patch drops a NULL only when it is
           -- in the PATCH argument, so a json_object base would keep null keys.
           json_merge_patch(json_merge_patch(json_merge_patch('{}',
               json_object('tool', tc.name)),
               json_object('has_error', coalesce(tc.has_error, FALSE))),
               json_object('command_norm', tc.command_norm)) AS attrs
    FROM tool_call tc, params p
    WHERE tc.session IS NOT NULL AND (p.cutoff IS NULL OR tc.ts > p.cutoff)

    UNION ALL
    -- command_outcome -> verification (verifier_backed): ONLY genuine checks,
    -- via the stamped check_family (never re-classified here).
    SELECT co.session, co.ts, 'verification', 'verifier_backed',
           NULL, co.tool_call, NULL, NULL,
           co.id, NULL, NULL,
           'command_outcome', co.id,
           co.check_family || ': ' || coalesce(co.status, '?'),
           json_merge_patch(json_merge_patch(json_merge_patch('{}',
               json_object('family', co.check_family)),
               json_object('kind', co.kind)),
               json_object('status', co.status))
    FROM command_outcome co, params p
    WHERE co.session IS NOT NULL AND co.check_family IS NOT NULL
      AND (p.cutoff IS NULL OR co.ts > p.cutoff)

    UNION ALL
    -- compaction -> boundary (derived): a system-recorded lifecycle boundary.
    SELECT c.session, c.ts, 'boundary', 'derived',
           NULL, NULL, c.id, NULL,
           NULL, NULL, NULL,
           'compaction', c.id,
           'compaction (' || coalesce(c.strategy, '?')
               || CASE WHEN c.trigger IS NOT NULL THEN ', ' || c.trigger ELSE '' END || ')',
           json_merge_patch(json_merge_patch(json_merge_patch('{}',
               json_object('trigger', c.trigger)),
               json_object('strategy', c.strategy)),
               json_object('tokens_before', CAST(c.tokens_before AS DOUBLE)))
    FROM compaction c, params p
    WHERE c.session IS NOT NULL AND (p.cutoff IS NULL OR c.ts > p.cutoff)

    UNION ALL
    -- compaction summary TEXT -> derived_summary, keyed 'compaction_summary'
    -- so it cannot collide with the boundary event off the same row.
    SELECT c.session, c.ts, 'derived_summary', 'derived',
           NULL, NULL, c.id, NULL,
           NULL, NULL, NULL,
           'compaction_summary', c.id,
           c.summary, NULL
    FROM compaction c, params p
    WHERE c.session IS NOT NULL AND c.summary IS NOT NULL AND c.summary <> ''
      AND (p.cutoff IS NULL OR c.ts > p.cutoff)

    UNION ALL
    -- plan_snapshot -> task_state (tool_backed: TodoWrite / update_plan).
    SELECT ps.session, ps.ts, 'task_state', 'tool_backed',
           NULL, NULL, NULL, ps.id,
           NULL, NULL, NULL,
           'plan_snapshot', ps.id,
           ps.summary, NULL
    FROM plan_snapshot ps, params p
    WHERE ps.session IS NOT NULL AND (p.cutoff IS NULL OR ps.ts > p.cutoff)

    UNION ALL
    -- Earliest `task` user turn per affected session -> objective. Rank ALL
    -- task turns in each session, including turns before the active window.
    SELECT t.session, t.ts, 'objective', 'derived',
           t.id, NULL, NULL, NULL,
           NULL, NULL, NULL,
           'turn', t.id,
           t.text_excerpt, NULL
    FROM (
        SELECT *, row_number() OVER (
            PARTITION BY session ORDER BY seq NULLS LAST, ts, id
        ) AS rn
        FROM turn
        WHERE session IN (SELECT session FROM affected_objective_sessions)
          AND role = 'user' AND message_kind = 'task'
    ) t
    WHERE t.rn = 1

    UNION ALL
    -- hook invocations with a real intervention -> policy_decision.
    SELECT h.session, h.ts, 'policy_decision', 'policy_backed',
           NULL, h.tool_call, NULL, NULL,
           NULL, h.id, NULL,
           'hook_command_invocation', h.id,
           coalesce(h.hook_name, 'hook') || ': ' || coalesce(h.effect, '?'),
           json_merge_patch(json_merge_patch(json_merge_patch('{}',
               json_object('effect', h.effect)),
               json_object('hook_name', h.hook_name)),
               json_object('provider_status', h.provider_status))
    FROM hook_command_invocation h, params p
    WHERE h.session IS NOT NULL
      AND h.effect IN ('blocked', 'injected_context', 'modified_input', 'notified')
      AND (p.cutoff IS NULL OR h.ts > p.cutoff)

    UNION ALL
    -- session checkout -> repo_state. dirty is NOT read (git writes it
    -- always-false, #578 review).
    SELECT s.id, s.started_at, 'repo_state', 'derived',
           NULL, NULL, NULL, NULL,
           NULL, NULL, s.checkout,
           'checkout', s.checkout,
           coalesce(c.repository, 'repo')
               || CASE WHEN c.branch IS NOT NULL THEN ' @ ' || c.branch ELSE '' END
               || CASE WHEN c.head_sha IS NOT NULL THEN ' · ' || substr(c.head_sha, 1, 7) ELSE '' END,
           json_merge_patch(json_merge_patch(json_merge_patch('{}',
               json_object('repository', c.repository)),
               json_object('branch', c.branch)),
               json_object('head_sha', c.head_sha))
    FROM session s
    JOIN checkout c ON c.id = s.checkout
    CROSS JOIN params p
    WHERE s.checkout IS NOT NULL AND (p.cutoff IS NULL OR s.started_at > p.cutoff)
)
SELECT
    md5(src.session || chr(31) || src.source_table || chr(31) || src.source_id) AS id,
    src.session,
    lin.root AS root_session,
    lin.parent AS parent_session,
    src.ts,
    coalesce(sess.source, 'unknown') AS provider,
    src.kind, src.backing,
    src.turn, src.tool_call, NULL AS agent_event, src.compaction, src.plan_snapshot,
    src.command_outcome, src.hook_invocation, NULL AS artifact, NULL AS file,
    src.checkout, NULL AS "commit",
    src.source_table, src.source_id, src.summary,
    NULL AS content_hash, NULL AS input_hash, NULL AS output_hash,
    src.attrs
FROM src
LEFT JOIN session sess ON sess.id = src.session
LEFT JOIN lineage lin ON lin.child = src.session
-- Defensive: a duplicate id inside one INSERT is a DuckDB error, not an upsert.
QUALIFY row_number() OVER (PARTITION BY md5(src.session || chr(31) || src.source_table || chr(31) || src.source_id) ORDER BY src.ts) = 1
ON CONFLICT (id) DO UPDATE SET
    session = excluded.session, root_session = excluded.root_session,
    parent_session = excluded.parent_session, ts = excluded.ts,
    provider = excluded.provider, kind = excluded.kind, backing = excluded.backing,
    turn = excluded.turn, tool_call = excluded.tool_call, agent_event = excluded.agent_event,
    compaction = excluded.compaction, plan_snapshot = excluded.plan_snapshot,
    command_outcome = excluded.command_outcome, hook_invocation = excluded.hook_invocation,
    artifact = excluded.artifact, file = excluded.file, checkout = excluded.checkout,
    "commit" = excluded."commit", source_table = excluded.source_table,
    source_id = excluded.source_id, summary = excluded.summary,
    content_hash = excluded.content_hash, input_hash = excluded.input_hash,
    output_hash = excluded.output_hash, attrs = excluded.attrs
