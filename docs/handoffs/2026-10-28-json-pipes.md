# JSON pipe repair checkpoint

The four session and retrospective JSON handlers wait for stdout writes before command exit. A delayed reader previously received only 65,536 bytes. The candidate produces complete JSON above 500 KB in the reproduction fixtures.

Source checkpoint: a3100ffe338d3c5dbc04711fbd8dbac7221bb2d4. The delivery branch uses origin/main as its parent. Its source tree is identical to that checkpoint, apart from this record. The original source base 873903c1 has the same tree as origin/main at preparation.

Recorded checks: 36 focused tests pass; typecheck and build pass. Forced timeout checks leave no owned processes. An installed binary produces 277,041 bytes of valid JSON through a delayed reader. These checks precede this documentation checkpoint; no new source changes occur during wrap-up.

Claude source and test review verdicts are PASS. The full repository gate is not recorded as run. Existing EPIPE handling remains a separate follow-up. The original local binary stays available until a complete scheduled weekly run succeeds. No merge or release occurs here.

Owner: repository owner. Next action: run the repository merge gates and review this draft before merge. PR URL and final delivery SHA belong in the external task receipt after publication.
