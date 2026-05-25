# Changelog

## [0.1.1](https://github.com/Necmttn/ax/compare/v0.1.0...v0.1.1) (2026-05-09)


### Bug Fixes

* accept release checksum asset paths ([76859ff](https://github.com/Necmttn/ax/commit/76859ffbf6690e88790a75cc999df8900a1897c5))

## [0.1.0](https://github.com/Necmttn/ax/compare/v0.0.1...v0.1.0) (2026-05-09)


### Features

* agentctl v0 — skills, claude + codex transcript ingest, CLI ([5d4a81f](https://github.com/Necmttn/ax/commit/5d4a81f81a53a90c195c533b2e5547f70588cf55))
* body column on skill ([#2](https://github.com/Necmttn/ax/issues/2)) ([#10](https://github.com/Necmttn/ax/issues/10)) ([b9128c3](https://github.com/Necmttn/ax/commit/b9128c36ae1a1a534a6dd9be75ca0ee77cf30c27))
* composite taste score ([#18](https://github.com/Necmttn/ax/issues/18)) ([#28](https://github.com/Necmttn/ax/issues/28)) ([489c6cd](https://github.com/Necmttn/ax/commit/489c6cd3f745ebed6d25f4e418db6621e7b0ab0e))
* derive correction + proposed signals ([#5](https://github.com/Necmttn/ax/issues/5)) ([#12](https://github.com/Necmttn/ax/issues/12)) ([48565d9](https://github.com/Necmttn/ax/commit/48565d9ea485756e4194626c24054d681959222f))
* Effect v4 refactor (foundation) ([#8](https://github.com/Necmttn/ax/issues/8)) ([1fc199e](https://github.com/Necmttn/ax/commit/1fc199e13efd997a558db13ce2f0a1578ef78e7d)), closes [#1](https://github.com/Necmttn/ax/issues/1)
* git ingest — commits + file touches per repo ([#17](https://github.com/Necmttn/ax/issues/17)) ([#24](https://github.com/Necmttn/ax/issues/24)) ([f4cf488](https://github.com/Necmttn/ax/commit/f4cf488fa38a909beaa4addf59f2c10aad3d933c))
* **install:** seamless auto-install of pinned SurrealDB ([853ff44](https://github.com/Necmttn/ax/commit/853ff440070412f5aeadb7fa4e98f979c55ff652))
* launchd WatchPaths plist for incremental ingest ([#6](https://github.com/Necmttn/ax/issues/6)) ([#9](https://github.com/Necmttn/ax/issues/9)) ([2b7e94c](https://github.com/Necmttn/ax/commit/2b7e94cbe9e24cf7817224e845d2e7b633822750))
* live TUI updates via SurrealDB live queries ([#22](https://github.com/Necmttn/ax/issues/22)) ([#27](https://github.com/Necmttn/ax/issues/27)) ([ffaab40](https://github.com/Necmttn/ax/commit/ffaab40416cb2a67214fe16283a018c02cc821e1))
* OpenTUI dashboard ([#4](https://github.com/Necmttn/ax/issues/4)) ([#14](https://github.com/Necmttn/ax/issues/14)) ([5a73ad3](https://github.com/Necmttn/ax/commit/5a73ad3521e01d90f77744d56f3b9192ebd117f9))
* **project:** add context and verify commands ([3fcb225](https://github.com/Necmttn/ax/commit/3fcb225062ff07cacccae38789af98adc164b210))
* **project:** add diagnostics adapter ([6a8490c](https://github.com/Necmttn/ax/commit/6a8490c767b81aba0cdcfd3dd511e8b2fb0e25f2))
* **project:** add grounding types ([32a69b8](https://github.com/Necmttn/ax/commit/32a69b8bec9c81b5806852bd1363b3140947a4b9))
* **project:** build grounding payloads ([312e6e8](https://github.com/Necmttn/ax/commit/312e6e861a988ab1e6a0c173658a143d9a52e320))
* **project:** collect git state ([883bf0c](https://github.com/Necmttn/ax/commit/883bf0c0c65a9cf248863035bdab22632dba80d2))
* **project:** derive verification checks ([5de81c7](https://github.com/Necmttn/ax/commit/5de81c7c3f83566c8e152e0f4a65f69262925d12))
* **project:** detect stack and instructions ([1b87db7](https://github.com/Necmttn/ax/commit/1b87db761ea9a53f530081affa4f0e440eb8e087))
* search FTS via SurrealDB BM25 analyzer ([#21](https://github.com/Necmttn/ax/issues/21)) ([#26](https://github.com/Necmttn/ax/issues/26)) ([d6eb9e0](https://github.com/Necmttn/ax/commit/d6eb9e0b1d4a200904a31c5255e589d2b71200be))
* self-improve weekly ingest + deprecate hook ([#7](https://github.com/Necmttn/ax/issues/7)) ([#11](https://github.com/Necmttn/ax/issues/11)) ([cdf7da6](https://github.com/Necmttn/ax/commit/cdf7da6e789e899a556cb8f190f4473f4462e4ce))
* single-binary install — `agentctl install/uninstall` + bun --compile ([4f76d6f](https://github.com/Necmttn/ax/commit/4f76d6f885b912cf0ace6a90fd00e0efa8a6369f))
* skill_pairs + skill_after_error signals ([#19](https://github.com/Necmttn/ax/issues/19), [#20](https://github.com/Necmttn/ax/issues/20)) ([#25](https://github.com/Necmttn/ax/issues/25)) ([128c211](https://github.com/Necmttn/ax/commit/128c2111d0dbbd08e8b85552bbc8114671cab9ed))
* SurrealDB file buckets for transcript snapshots + codex artifacts ([#13](https://github.com/Necmttn/ax/issues/13)) ([3e8b23c](https://github.com/Necmttn/ax/commit/3e8b23c1922dbdb03b5dad2f118c54d91fb25c12)), closes [#3](https://github.com/Necmttn/ax/issues/3)


### Bug Fixes

* **bin:** resolve symlinks so ln -s install works ([d358ecb](https://github.com/Necmttn/ax/commit/d358ecb887d07dc5a94820072f14cdb44566db7a))
* **cli:** hardening - input validation, error UX, output bugs ([#55](https://github.com/Necmttn/ax/issues/55)) ([6476727](https://github.com/Necmttn/ax/commit/6476727f3b01bb5de42eefd3b2289a2a3fa2aae4))
* **db:** connect timeout + transaction conflict retry ([#35](https://github.com/Necmttn/ax/issues/35), [#39](https://github.com/Necmttn/ax/issues/39)) ([#54](https://github.com/Necmttn/ax/issues/54)) ([9d7c3cb](https://github.com/Necmttn/ax/commit/9d7c3cbe4979097b3963b492669f3b71a885ed0d))
* **ingest:** cwd null coalesce + ingest .claude/commands as scope='command' skills ([#56](https://github.com/Necmttn/ax/issues/56)) ([3f739af](https://github.com/Necmttn/ax/commit/3f739afe93a12308deb122e83aa57f2499a06e84))
* **install:** uninstall accuracy + ANSI strip + cold-vs-warm feedback ([#53](https://github.com/Necmttn/ax/issues/53)) ([edf198c](https://github.com/Necmttn/ax/commit/edf198c7130bfef723f5ddf441113a1577e13373))
* **project:** harden diagnostics config parsing ([8ac95e9](https://github.com/Necmttn/ax/commit/8ac95e9a61e8c6321e1fa64c8d86a2048f98be65))
* **project:** harden git state parsing ([89eecc4](https://github.com/Necmttn/ax/commit/89eecc40169c500e97c33623c8f93ca7cf4bf5d5))
* **project:** harden stack detection ([659c171](https://github.com/Necmttn/ax/commit/659c171884d7d56925a1f07438e6a2a044eec2a2))
* **project:** parse git status as nul records ([cbbb912](https://github.com/Necmttn/ax/commit/cbbb91290b76b09520d6af50c6ca2a51b4bf6576))
* **project:** respect package manager in checks ([ad4a3f1](https://github.com/Necmttn/ax/commit/ad4a3f1c7e26be438d9159a5798586adbcfcbb50))
* **tui:** add JSX namespace reference for typecheck on main ([371ed3a](https://github.com/Necmttn/ax/commit/371ed3a4925bda349bfd35b6c84d601a2aa596bb))
* **tui:** perf regression + error copy + col widths ([#33](https://github.com/Necmttn/ax/issues/33), [#49](https://github.com/Necmttn/ax/issues/49), [#52](https://github.com/Necmttn/ax/issues/52)) ([#57](https://github.com/Necmttn/ax/issues/57)) ([181ba9f](https://github.com/Necmttn/ax/commit/181ba9fe7df23b3d6a161b0acc4d7de5eeb1da09))
* **watcher:** add ~/.bun/bin to launchd PATH ([bb0e83a](https://github.com/Necmttn/ax/commit/bb0e83aa1c1864e24b121cea6393b01bbd2610d5))


### Performance

* add indexes on relation tables ([#29](https://github.com/Necmttn/ax/issues/29)) ([#30](https://github.com/Necmttn/ax/issues/30)) ([b28f814](https://github.com/Necmttn/ax/commit/b28f81427699741452f881587180093d9667fcc6))
* cmdTaste/Search/Unused single-pass aggregate ([#31](https://github.com/Necmttn/ax/issues/31)) ([#32](https://github.com/Necmttn/ax/issues/32)) ([9c996cf](https://github.com/Necmttn/ax/commit/9c996cfd2ac5b6f0cae24e92e8ca6569e225c3e5))
