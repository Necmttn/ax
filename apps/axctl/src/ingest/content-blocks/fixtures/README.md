# Content Block Fixtures

This corpus is intentionally small. Each parser family starts with:

- accepted `.input.*` examples that should produce stable semantic blocks and atoms
- rejected `.input.*` examples that look nearby but should not be claimed by the parser
- matching files in `../golden/**` for accepted parser output

Rules for contributors:

- Keep fixtures synthetic and under 100 lines unless the parser needs a larger shape.
- Do not include private paths, customer data, real tokens, or full transcripts.
- Add one rejected case for every new accepted document family.
- Prefer semantic assertions over full renderer snapshots in tests.
