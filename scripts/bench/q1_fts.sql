SELECT id, ts FROM turn WHERE text_excerpt @@ 'ingest pipeline' ORDER BY ts DESC LIMIT 20;
