# Changelog

## [0.37.0](https://github.com/Necmttn/ax/compare/v0.36.0...v0.37.0) (2026-07-07)


### Features

* **cli:** ax runs evidence &lt;session&gt; + runs_evidence MCP ([#578](https://github.com/Necmttn/ax/issues/578), slice 3) ([#643](https://github.com/Necmttn/ax/issues/643)) ([a704f6f](https://github.com/Necmttn/ax/commit/a704f6f3575958d4f7308a30aa8539bd2b7fbcf5))
* edited (write) refs via turn-&gt;event bridge + ref counts in read surface ([#578](https://github.com/Necmttn/ax/issues/578), slice 5) ([#645](https://github.com/Necmttn/ax/issues/645)) ([82625ec](https://github.com/Necmttn/ax/commit/82625ec710e83071bf76381c07f6f91e43d42f66))
* ForesightJS predictive prefetch for studio + site ([#661](https://github.com/Necmttn/ax/issues/661)) ([#662](https://github.com/Necmttn/ax/issues/662)) ([2f7fe72](https://github.com/Necmttn/ax/commit/2f7fe7242c7a072a5238c087edc5e036e8d85ae3))
* **ingest:** derive-run-evidence stage populates the ledger ([#578](https://github.com/Necmttn/ax/issues/578), slice 2) ([#642](https://github.com/Necmttn/ax/issues/642)) ([2444edc](https://github.com/Necmttn/ax/commit/2444edc2a79be7896af4592d0ed3259ef3741ca1))
* **ingest:** first-class omp (oh-my-pi) harness support ([#636](https://github.com/Necmttn/ax/issues/636)) ([#637](https://github.com/Necmttn/ax/issues/637)) ([2eb0564](https://github.com/Necmttn/ax/commit/2eb056412acf6365a1ff8cfff1c8d5e2360c0b30))
* **ingest:** populate run_evidence_ref with file refs ([#578](https://github.com/Necmttn/ax/issues/578), slice 4) ([#644](https://github.com/Necmttn/ax/issues/644)) ([0391fd2](https://github.com/Necmttn/ax/commit/0391fd2a71b431aaffd6626fe82b50036bb09ce2))
* **ledger:** objective/policy_decision/repo_state/derived_summary + lineage + read headers ([#578](https://github.com/Necmttn/ax/issues/578), slice 6) ([#647](https://github.com/Necmttn/ax/issues/647)) ([1cbf57c](https://github.com/Necmttn/ax/commit/1cbf57cb03310669a4c4ff055e5e125511da6052))
* **schema:** run evidence ledger contract + tables ([#578](https://github.com/Necmttn/ax/issues/578), first slice) ([#641](https://github.com/Necmttn/ax/issues/641)) ([18c540d](https://github.com/Necmttn/ax/commit/18c540d614ba5e581444b1b8fa5e3623002fe850))
* **site:** /design-partners shareable pitch page ([#651](https://github.com/Necmttn/ax/issues/651)) ([#652](https://github.com/Necmttn/ax/issues/652)) ([f0f393d](https://github.com/Necmttn/ax/commit/f0f393d266df45c1efe158a1f20a7970880c59c0))
* **site:** consolidate 3 pitch pages into one /teams ([#656](https://github.com/Necmttn/ax/issues/656)) ([#657](https://github.com/Necmttn/ax/issues/657)) ([82fa069](https://github.com/Necmttn/ax/commit/82fa0694fde6988018e6c07c19b82d328090f57b))
* **site:** rebuild /design-partners — visuals + cohort scarcity + honest claim ([#653](https://github.com/Necmttn/ax/issues/653)) ([#654](https://github.com/Necmttn/ax/issues/654)) ([767c280](https://github.com/Necmttn/ax/commit/767c28033b8ebd30f642d6e017e26c1aa65210fc))
* **studio:** full-app demo mock data + toggleable labeled sidebar ([#659](https://github.com/Necmttn/ax/issues/659)) ([#660](https://github.com/Necmttn/ax/issues/660)) ([3542ee0](https://github.com/Necmttn/ax/commit/3542ee0042b9c18c74fdd5312ab68c6b692f3f3a))
* **studio:** run-evidence panel in the session inspector ([#578](https://github.com/Necmttn/ax/issues/578), slice 7) ([#648](https://github.com/Necmttn/ax/issues/648)) ([bd31444](https://github.com/Necmttn/ax/commit/bd3144434fe5ccac6bed41e9dd1cf91798ef3dd3))


### Bug Fixes

* **cost:** self-documenting headers + legend for `ax cost sessions` ([#669](https://github.com/Necmttn/ax/issues/669)) ([dea0765](https://github.com/Necmttn/ax/commit/dea0765315f2cfcc3fda8f9a9cc1550702cbc28c))
* **foresight:** include hash in link ledger keys, drop dead ForesightLinkProps export ([#663](https://github.com/Necmttn/ax/issues/663)) ([42cf522](https://github.com/Necmttn/ax/commit/42cf5225ac5b442b50ceba4aa59341269f7a87d5))
* **foresight:** stop emitting devtools chunk in prod dists via injected loader ([#667](https://github.com/Necmttn/ax/issues/667)) ([8722250](https://github.com/Necmttn/ax/commit/8722250c946c1ace29292cbe73e988c61eb9513c))
* **ledger:** verification = real checks only + clear stale hot refs ([#578](https://github.com/Necmttn/ax/issues/578), Codex review) ([#646](https://github.com/Necmttn/ax/issues/646)) ([2fbb452](https://github.com/Necmttn/ax/commit/2fbb4521d74a26a1cee00943cb2aa898a04a0fee))
* **site:** answer the what-works question on the teams page ([#668](https://github.com/Necmttn/ax/issues/668)) ([61c0c25](https://github.com/Necmttn/ax/commit/61c0c25b553804054a96d17f12d43e548c8b8cf1))

## [0.36.0](https://github.com/Necmttn/ax/compare/v0.35.0...v0.36.0) (2026-06-29)


### Features

* add community pattern contributions ([#629](https://github.com/Necmttn/ax/issues/629)) ([bc8715e](https://github.com/Necmttn/ax/commit/bc8715ecefa0998b2ccf6e322283046332fbfa4d))
* **advice:** link route-dispatch advice to dispatch outcomes ([#595](https://github.com/Necmttn/ax/issues/595)) ([386b782](https://github.com/Necmttn/ax/commit/386b7821b38f922508d6897fd89d4f2ce03c3082))
* compile community pattern stats ([#622](https://github.com/Necmttn/ax/issues/622)) ([1354fc0](https://github.com/Necmttn/ax/commit/1354fc050f2d2b6f3456f51721d25d2cf4b2a713))
* **hooks:** daemon /hooks/eval fast-path + guard env-forwarding (B, stage 3a) ([#612](https://github.com/Necmttn/ax/issues/612)) ([28934ca](https://github.com/Necmttn/ax/commit/28934ca3153ea67306b07bf350df75df5c5f3d11))
* **hooks:** daemon-first shim + opt-in --daemon install (B, stage 3b) ([#613](https://github.com/Necmttn/ax/issues/613)) ([3f7bb19](https://github.com/Necmttn/ax/commit/3f7bb19c7aee3bfa8720928e0912960d4faf986a))
* **hooks:** dispatcher core - multiplex all guards in one process ([#605](https://github.com/Necmttn/ax/issues/605)) ([0672a18](https://github.com/Necmttn/ax/commit/0672a18f9d9c88c9ff0169e7ae460088825fcb02))
* **hooks:** flip `install --all` to the dispatcher + migrate legacy (B, stage 2b) ([#607](https://github.com/Necmttn/ax/issues/607)) ([a0f98af](https://github.com/Necmttn/ax/commit/a0f98aff16af3b780cf1f3a63799001f1d14ee9a))
* **hooks:** one-shot `ax hooks install --all` + repo-free install nudge ([#603](https://github.com/Necmttn/ax/issues/603)) ([a6cabbe](https://github.com/Necmttn/ax/commit/a6cabbe5403a29ac1fd3c477d2fe3dba32e127cf))
* **hooks:** scaffold + embed the single dispatcher (B, stage 2) ([#606](https://github.com/Necmttn/ax/issues/606)) ([70a72d7](https://github.com/Necmttn/ax/commit/70a72d71b93335f520a97bf66a7e848042348d20))
* **ingest:** derive opencode compactions ([#634](https://github.com/Necmttn/ax/issues/634)) ([9ad4fd2](https://github.com/Necmttn/ax/commit/9ad4fd2b0e9d8fefe6e4f9c50252843fd79dea42))
* **mcp:** expose sessions_churn as a read-only MCP tool ([#311](https://github.com/Necmttn/ax/issues/311)) ([#596](https://github.com/Necmttn/ax/issues/596)) ([01a6dde](https://github.com/Necmttn/ax/commit/01a6dde454e1f12c7b2e229dea31236c6dbc48d9))
* n-gram-lift directive miner ([#587](https://github.com/Necmttn/ax/issues/587)) ([#592](https://github.com/Necmttn/ax/issues/592)) ([bbb5482](https://github.com/Necmttn/ax/commit/bbb54826538044582a14b783fa64b0617233ce3c))
* **otel:** `ax otel` — OTLP receiver coverage + freshness view ([#609](https://github.com/Necmttn/ax/issues/609)) ([dc4267b](https://github.com/Necmttn/ax/commit/dc4267b7e85ef5e2e31d070247dd14cd20ba3681))
* profile widget ([#626](https://github.com/Necmttn/ax/issues/626)) ([2899ef3](https://github.com/Necmttn/ax/commit/2899ef3d047b9692d1d568cab3c02568af7d31da))
* show full context startup budget ([#635](https://github.com/Necmttn/ax/issues/635)) ([b8353cb](https://github.com/Necmttn/ax/commit/b8353cbf51ad97ace447dce773fdc311ed444391))
* **site:** add state report page ([#632](https://github.com/Necmttn/ax/issues/632)) ([69d6d70](https://github.com/Necmttn/ax/commit/69d6d70903943aff4376e3d564d72134ff4968a7))
* **site:** browse community patterns ([#631](https://github.com/Necmttn/ax/issues/631)) ([9b6e26a](https://github.com/Necmttn/ax/commit/9b6e26a41d540daf812f9caf11d04ca6c16a501d))
* **studio:** expose session deeplinks in session outputs ([#563](https://github.com/Necmttn/ax/issues/563)) ([#584](https://github.com/Necmttn/ax/issues/584)) ([2b867ba](https://github.com/Necmttn/ax/commit/2b867ba21f3f80ea44e60cbc5829c6dfccf38a90))
* support team radar compare ([#633](https://github.com/Necmttn/ax/issues/633)) ([b3b2061](https://github.com/Necmttn/ax/commit/b3b2061b4da5189d744bb1622977675a0afb0cc3))
* workflow mining — codify recurring skill arcs ([#588](https://github.com/Necmttn/ax/issues/588)) ([#598](https://github.com/Necmttn/ax/issues/598)) ([4cb5211](https://github.com/Necmttn/ax/commit/4cb5211ecec4939e8b8290ca2dbddd9eb394b659))


### Bug Fixes

* **ingest:** additive schema self-heal at ingest start ([#283](https://github.com/Necmttn/ax/issues/283)) ([#601](https://github.com/Necmttn/ax/issues/601)) ([6d53e32](https://github.com/Necmttn/ax/commit/6d53e32f2a37ff35dea2d2b09a69d9303120da4f))
* **ingest:** auto-sweep stranded ingest_run rows at ingest start ([#282](https://github.com/Necmttn/ax/issues/282)) ([#597](https://github.com/Necmttn/ax/issues/597)) ([ef40bae](https://github.com/Necmttn/ax/commit/ef40bae3ed2fbf7c7a3912d8c920d890c3bab177))
* **ingest:** clear-then-derive friction/diagnostic events on full re-derive ([#549](https://github.com/Necmttn/ax/issues/549)) ([#602](https://github.com/Necmttn/ax/issues/602)) ([847bb6a](https://github.com/Necmttn/ax/commit/847bb6a00a2f3cfbcb1533f4c2a627cfce893bd4))
* **otel:** correlate telemetry_of by uuid match, session-grain + incremental ([#611](https://github.com/Necmttn/ax/issues/611)) ([7b45cbd](https://github.com/Necmttn/ax/commit/7b45cbda5f10c23194714ea7834d4a69f0803d56))
* **routability:** carry judgment from prose turns onto the edits behind them ([#591](https://github.com/Necmttn/ax/issues/591)) ([4bb7243](https://github.com/Necmttn/ax/commit/4bb72432d2288e687f5ef4a1c17acc5ab4f918b0))
* **site:** routing copy says advise, not auto-route ([#594](https://github.com/Necmttn/ax/issues/594)) ([30c5406](https://github.com/Necmttn/ax/commit/30c54068f289087465cb8d0b24f66b63132e7ad1))


### Performance

* bound session churn scans to failure candidates ([#620](https://github.com/Necmttn/ax/issues/620)) ([ad519d2](https://github.com/Necmttn/ax/commit/ad519d247f4a58a39128016e4d2cb0ef5d6fba39))

## [0.35.0](https://github.com/Necmttn/ax/compare/v0.34.2...v0.35.0) (2026-06-19)


### Features

* **hooks:** embed bundled SDK hooks in the compiled binary ([#573](https://github.com/Necmttn/ax/issues/573)) ([#574](https://github.com/Necmttn/ax/issues/574)) ([b152fb5](https://github.com/Necmttn/ax/commit/b152fb544f2dd4c3302dc8c4b3a3961763db9cb6))
* **routing:** ax routing impact — off-vs-on receipt per 5h plan window ([#575](https://github.com/Necmttn/ax/issues/575)) ([#576](https://github.com/Necmttn/ax/issues/576)) ([b783eac](https://github.com/Necmttn/ax/commit/b783eacc521286235fb379e9b0d4b288e6ba185c))
* **studio:** team metrics board + ax-for-teams paywall ([#567](https://github.com/Necmttn/ax/issues/567)) ([61645a5](https://github.com/Necmttn/ax/commit/61645a512af92547b36b896914a20d6a023a4d42))


### Bug Fixes

* **install:** make IDE daemon model graceful + doctor-aware ([#568](https://github.com/Necmttn/ax/issues/568)) ([#572](https://github.com/Necmttn/ax/issues/572)) ([1867d12](https://github.com/Necmttn/ax/commit/1867d12ba08a663f940e5aa6aa1fadfaac54dc01))
* keep inspect pagination on server window ([7726163](https://github.com/Necmttn/ax/commit/772616308c338969c8f05c7c840ae731cfdf347a))

## [0.34.2](https://github.com/Necmttn/ax/compare/v0.34.1...v0.34.2) (2026-06-19)


### Bug Fixes

* **hooks:** clear errors for SDK hooks on compiled binary ([#564](https://github.com/Necmttn/ax/issues/564)) ([#565](https://github.com/Necmttn/ax/issues/565)) ([b13a261](https://github.com/Necmttn/ax/commit/b13a26190638f0106047da39a8fff7b33ee92b45))

## [0.34.1](https://github.com/Necmttn/ax/compare/v0.34.0...v0.34.1) (2026-06-18)


### Bug Fixes

* omit null skill descriptions during ingest ([#560](https://github.com/Necmttn/ax/issues/560)) ([ab59f24](https://github.com/Necmttn/ax/commit/ab59f24521195d1fc96feec978e90e0c39213643))
* **setup:** run npx skills install from HOME, not caller cwd ([#562](https://github.com/Necmttn/ax/issues/562)) ([91f2af3](https://github.com/Necmttn/ax/commit/91f2af324389528ecaad2c8f61b2089677d50bfb))
* **studio:** speed up shared transcript viewer ([b8a7eb3](https://github.com/Necmttn/ax/commit/b8a7eb36a37bf1453828541dc01e20105c5eee89))

## [0.34.0](https://github.com/Necmttn/ax/compare/v0.33.0...v0.34.0) (2026-06-18)


### Features

* **attribution:** "Generated with ax" watermark on shareable artifacts ([#541](https://github.com/Necmttn/ax/issues/541)) ([d2347dc](https://github.com/Necmttn/ax/commit/d2347dcf0ac4a1ba4d2f1fd7ef55531000b0b3a6))
* **cost:** extend routability lens to Codex/gpt-5.x sessions ([#546](https://github.com/Necmttn/ax/issues/546)) ([#552](https://github.com/Necmttn/ax/issues/552)) ([828c68a](https://github.com/Necmttn/ax/commit/828c68a571026faf510ceebfa80d11038f998421))
* **ingest:** attribute Codex subagent cost separately (codex-subagent) ([#553](https://github.com/Necmttn/ax/issues/553)) ([#554](https://github.com/Necmttn/ax/issues/554)) ([27f01d2](https://github.com/Necmttn/ax/commit/27f01d2564b8d5ee9c380ae969f05bf8bf3f8395))
* **ingest:** surface Codex spawn_agent dispatches in ax dispatches ([#555](https://github.com/Necmttn/ax/issues/555)) ([#556](https://github.com/Necmttn/ax/issues/556)) ([469d949](https://github.com/Necmttn/ax/commit/469d949b22ddd6d32e598e1534d13191493bebb8))
* **profile:** ax profile interview — user-authored highlights ([#539](https://github.com/Necmttn/ax/issues/539)) ([0c3f7ef](https://github.com/Necmttn/ax/commit/0c3f7ef2aeeaf2b42ccac98d75a269db9ef16859))
* **site:** collapse highlight weapons + skills into click-toggle disclosure ([#544](https://github.com/Necmttn/ax/issues/544)) ([8effc1f](https://github.com/Necmttn/ax/commit/8effc1f5b828e5b1025336a147210f994d022cf0))


### Bug Fixes

* **install:** raise SurrealDB open-file limit to 65536 ([#558](https://github.com/Necmttn/ax/issues/558)) ([#559](https://github.com/Necmttn/ax/issues/559)) ([105366d](https://github.com/Necmttn/ax/commit/105366dde0a7ee48778425f5cef52b96c88988ad))
* **lib:** warn instead of silently defaulting to epoch in isoTimestamp ([#540](https://github.com/Necmttn/ax/issues/540)) ([#548](https://github.com/Necmttn/ax/issues/548)) ([5eb766e](https://github.com/Necmttn/ax/commit/5eb766e6bba48cd89e37857343030e78ac16ea34))
* **profile:** replace turn-table scans + add timeout/diagnostics to profile show ([#540](https://github.com/Necmttn/ax/issues/540)) ([#547](https://github.com/Necmttn/ax/issues/547)) ([ebcdddf](https://github.com/Necmttn/ax/commit/ebcdddf901100bb5c52e86cd0622f4f65e377080))
* **sessions:** SurrealDB 3.1.2 ORDER BY idiom parse error ([#540](https://github.com/Necmttn/ax/issues/540)) ([#543](https://github.com/Necmttn/ax/issues/543)) ([3022472](https://github.com/Necmttn/ax/commit/30224729339016f3f859db2e7aa36457a5da106e))
* **studio:** restore shared transcript contrast ([24dd504](https://github.com/Necmttn/ax/commit/24dd504acb4909be2952f99ddfb131882ca45a22))
* **wrapped:** exclude synthetic Codex tools from skill counts ([#540](https://github.com/Necmttn/ax/issues/540)) ([#545](https://github.com/Necmttn/ax/issues/545)) ([801a940](https://github.com/Necmttn/ax/commit/801a940f540012a613a260b860c7156b64513c72))

## [0.33.0](https://github.com/Necmttn/ax/compare/v0.32.0...v0.33.0) (2026-06-17)


### Features

* **analytics:** tier-1 adoption report + Cloudflare Web Analytics beacon ([#514](https://github.com/Necmttn/ax/issues/514)) ([5701119](https://github.com/Necmttn/ax/commit/570111962c6985238cd03621a5c17d1b197441b9))
* **community:** codegen the skill-provenance registry from known collections ([#501](https://github.com/Necmttn/ax/issues/501)) ([3e2ae73](https://github.com/Necmttn/ax/commit/3e2ae73b94d5544642a105f0de1d16a6803d227a))
* **community:** compile leaderboard on a Cloudflare Worker (alchemy) ([#492](https://github.com/Necmttn/ax/issues/492)) ([3d6db6d](https://github.com/Necmttn/ax/commit/3d6db6db687501b3f16cbb5d6339d4d0b60de89e))
* **community:** credit skill authors via a provenance registry ([#499](https://github.com/Necmttn/ax/issues/499)) ([365438e](https://github.com/Necmttn/ax/commit/365438e77e6ed7e9b6a03c1568353319600fc63c))
* content-type classification of tool outputs + read-path facets ([#524](https://github.com/Necmttn/ax/issues/524)) ([241f6f5](https://github.com/Necmttn/ax/commit/241f6f5cb49f19ed5c6ad8aee519b15604a8119b))
* **cost:** ax cost images lens + isolate-heavy-context dispatch pattern ([#529](https://github.com/Necmttn/ax/issues/529)) ([fc2a680](https://github.com/Necmttn/ax/commit/fc2a6807d8a3a6ddc2f19d07fd30eaf8b15875d5))
* **dojo:** spar-for-skills — controlled re-run test of a skill edit ([#486](https://github.com/Necmttn/ax/issues/486)) ([a494b7a](https://github.com/Necmttn/ax/commit/a494b7abe6e88761520daa49e15fa772d2a2ed60))
* **ingest:** deriveDirectives — proactive directives → guidance proposals ([#537](https://github.com/Necmttn/ax/issues/537)) ([#538](https://github.com/Necmttn/ax/issues/538)) ([4ca858e](https://github.com/Necmttn/ax/commit/4ca858e5eec3ca8fd5c8411b7626aaae0d433045))
* **memory:** ax memory ops — surface Claude memory writes ([#531](https://github.com/Necmttn/ax/issues/531)) ([#532](https://github.com/Necmttn/ax/issues/532)) ([5401d35](https://github.com/Necmttn/ax/commit/5401d35dc3c7bcebd27051110ec4b8e2c63cb6c1))
* **onboarding:** add value-tour steps to agent setup prompt ([#482](https://github.com/Necmttn/ax/issues/482)) ([0a67352](https://github.com/Necmttn/ax/commit/0a673525d1149243e08f31fc13b6b3d122201549))
* **onboarding:** parallel gather with cheap subagents, judgment stays on main ([#487](https://github.com/Necmttn/ax/issues/487)) ([1ab3f7b](https://github.com/Necmttn/ax/commit/1ab3f7bc200de671d10a1030d739d2400d947a7e))
* **onboarding:** single-source prompt + help-then-contribute loop ([#489](https://github.com/Necmttn/ax/issues/489)) ([9123a08](https://github.com/Necmttn/ax/commit/9123a08589cff3f93cab3b15a665885c9b80259a))
* **patterns:** directive-mining spec (rescoped to v1 MVP after review) + starter pack ([#535](https://github.com/Necmttn/ax/issues/535)) ([#536](https://github.com/Necmttn/ax/issues/536)) ([5317fb8](https://github.com/Necmttn/ax/commit/5317fb8be7546b9e75d19945c22b59d28dbae0f4))
* **site:** bespoke head-to-head duel layout for /u/&lt;a&gt;/vs/&lt;b&gt; ([#527](https://github.com/Necmttn/ax/issues/527)) ([58885f8](https://github.com/Necmttn/ax/commit/58885f835d466442262492cc7bc3a47348744e4a))
* **site:** challenge share-card — pairwise profile duels ([#494](https://github.com/Necmttn/ax/issues/494)) ([329daf3](https://github.com/Necmttn/ax/commit/329daf3341e6f9a07232f2cd8b884a8859898101))
* **site:** profile reskin + dedicated comparison + shared @ax/recap-deck charts ([#523](https://github.com/Necmttn/ax/issues/523)) ([8ae76a3](https://github.com/Necmttn/ax/commit/8ae76a33acc0d09d674599e8bf3a27571ef803f7))
* **site:** revamp /leaders into a unified builder roster ([#491](https://github.com/Necmttn/ax/issues/491)) ([8ecc69b](https://github.com/Necmttn/ax/commit/8ecc69b760307abfb19d7b736e53c0c6e3cee65f))
* **site:** unlisted /status page with live adoption stats ([#516](https://github.com/Necmttn/ax/issues/516)) ([f34307c](https://github.com/Necmttn/ax/commit/f34307cdcab8b91473f2683796131e76f59dbddf))
* **skills:** ship-checklist - definition-of-done for new ax writes ([#530](https://github.com/Necmttn/ax/issues/530)) ([16a3d2f](https://github.com/Necmttn/ax/commit/16a3d2f6a4bb79aeb8b042d40091b0f71f7b7997))
* **studio-desktop:** n/ax namespace logo (app icon + tray) ([#526](https://github.com/Necmttn/ax/issues/526)) ([91bd819](https://github.com/Necmttn/ax/commit/91bd819ba7487c02e143bb924540ba709be5b08b))
* **studio-desktop:** n/ax namespace logo (app icon + tray) ([#528](https://github.com/Necmttn/ax/issues/528)) ([dabbea3](https://github.com/Necmttn/ax/commit/dabbea346d05e3fac462162af116532a8396255c))


### Bug Fixes

* **ci:** wrangler r2 upload needs --remote (v4 defaults to local) ([#518](https://github.com/Necmttn/ax/issues/518)) ([1b3e24b](https://github.com/Necmttn/ax/commit/1b3e24b5bddf23bf6e0e5dc9ab55338f6db9b385))
* **community:** trend skills by canonical identity, not install source ([#498](https://github.com/Necmttn/ax/issues/498)) ([d3c706d](https://github.com/Necmttn/ax/commit/d3c706d2563ba491b67ac16cfd754b6f6606c54d))
* **ingest:** capture cursor + opencode file evidence ([#161](https://github.com/Necmttn/ax/issues/161), [#162](https://github.com/Necmttn/ax/issues/162)) ([#515](https://github.com/Necmttn/ax/issues/515)) ([8479bea](https://github.com/Necmttn/ax/commit/8479beaf074f855d336d833ad58be8af6bb53aac))
* **ingest:** dry-run coarse estimate instead of dead-end ([#478](https://github.com/Necmttn/ax/issues/478)) ([#496](https://github.com/Necmttn/ax/issues/496)) ([73a1c78](https://github.com/Necmttn/ax/commit/73a1c784c0da1ccc9a3585a6c146a99825971925))
* **ingest:** plain progress renders only stage spans ([#479](https://github.com/Necmttn/ax/issues/479)) ([#495](https://github.com/Necmttn/ax/issues/495)) ([404aa1a](https://github.com/Necmttn/ax/commit/404aa1abfefb710b8cbf46484dc248164a12e354))
* **ingest:** space before AND in content-types since clause ([#533](https://github.com/Necmttn/ax/issues/533)) ([#534](https://github.com/Necmttn/ax/issues/534)) ([b90b7d1](https://github.com/Necmttn/ax/commit/b90b7d1b063678f2c86e849d46f6d64dce5857bc))
* **insights:** render `ax insights tools` as a table, not raw JSON ([#484](https://github.com/Necmttn/ax/issues/484)) ([75a8df5](https://github.com/Necmttn/ax/commit/75a8df5c30e17897880f50e44f39852959ce0577))
* **onboarding:** gather subagents use the strongest model, not a cheap one ([#488](https://github.com/Necmttn/ax/issues/488)) ([88afdb0](https://github.com/Necmttn/ax/commit/88afdb0511b6de39b6bc56192b14490ddb1a0f88))
* **onboarding:** make the value-tour build the Agent Wrapped deck ([#485](https://github.com/Necmttn/ax/issues/485)) ([e588aca](https://github.com/Necmttn/ax/commit/e588aca47e2feeda2c1a0b2a9c68fbbd6c0697b0))
* **profile:** dedupe axis legend + fix sign blurb grammar ([#477](https://github.com/Necmttn/ax/issues/477)) ([7ec57a5](https://github.com/Necmttn/ax/commit/7ec57a5d24a0b3a6d52946e79104ff68599059de))
* **profile:** detect stale publish watcher ([819be4a](https://github.com/Necmttn/ax/commit/819be4adb82ffa05a35fb406107b3ed990f77ea5))
* **profile:** ecosystem-aware verification detection ([#471](https://github.com/Necmttn/ax/issues/471)) ([#474](https://github.com/Necmttn/ax/issues/474)) ([418a13d](https://github.com/Necmttn/ax/commit/418a13dff1d1071c47b36d72d98948427191feb3))
* **schema:** coerce proposal.origin NONE→'mined' to stop ingest crash ([#472](https://github.com/Necmttn/ax/issues/472)) ([#473](https://github.com/Necmttn/ax/issues/473)) ([e96cd6f](https://github.com/Necmttn/ax/commit/e96cd6f8199f7274871d2485195e5ffeac7ea91a))
* **serve:** SSE keep-alive heartbeat on /api/events ([#503](https://github.com/Necmttn/ax/issues/503)) ([#506](https://github.com/Necmttn/ax/issues/506)) ([298546b](https://github.com/Necmttn/ax/commit/298546b1ce773d812f28519909b2b14e3236fa3b))
* **skills:** unify weighted doctor count with classify ([#481](https://github.com/Necmttn/ax/issues/481)) ([#497](https://github.com/Necmttn/ax/issues/497)) ([49795a4](https://github.com/Necmttn/ax/commit/49795a423dd0fc72b315bc4b36cabf295d00d7ec))
* **studio-desktop:** bundle electron-updater (app crashed on launch) ([#519](https://github.com/Necmttn/ax/issues/519)) ([eb8bbcb](https://github.com/Necmttn/ax/commit/eb8bbcb1c2a7af56f4c63dd96def83eb453b55bf))
* **studio-desktop:** silence tsdown inline warning (CI escalates to error) ([#512](https://github.com/Necmttn/ax/issues/512)) ([efb4aeb](https://github.com/Necmttn/ax/commit/efb4aeb66fe0b8f4c2c310c1b82e0f426919c54d))
* **studio-desktop:** stage @ax/onboarding-prompt (release build) ([#511](https://github.com/Necmttn/ax/issues/511)) ([315bf36](https://github.com/Necmttn/ax/commit/315bf3632a07751d1287f4cfbeef9bf817594d49))
* two dogfood findings — wrapped cards fail-visible + ax ingest reap ([#490](https://github.com/Necmttn/ax/issues/490)) ([75b173d](https://github.com/Necmttn/ax/commit/75b173ddd49fae285284f17ea2c07f97ed896f32))


### Performance

* **studio-desktop:** prune serve-irrelevant deps from bundle (-128MB) ([#520](https://github.com/Necmttn/ax/issues/520)) ([3cc6b8e](https://github.com/Necmttn/ax/commit/3cc6b8e3268d1d5ea8fcef84da167cea9c5238b9))

## [0.32.0](https://github.com/Necmttn/ax/compare/v0.31.0...v0.32.0) (2026-06-16)


### Features

* ax cost routability — main-thread routability lens ([#437](https://github.com/Necmttn/ax/issues/437)) ([6b27808](https://github.com/Necmttn/ax/commit/6b27808935768ed5a5ba134a91ad263f170f6c3c))
* **insights:** multi-hop telemetry enrichment of behavior insights ([#439](https://github.com/Necmttn/ax/issues/439)) ([02b43d6](https://github.com/Necmttn/ax/commit/02b43d64d0f95f4b7ca99f176f3a119b274eae0d))
* **onboarding:** privacy block in agent setup prompt ([#467](https://github.com/Necmttn/ax/issues/467)) ([601bcac](https://github.com/Necmttn/ax/commit/601bcac26c3c10052858f8d9a2e10a19eb1a56cf))
* **profile:** print profile URL after publish + /@&lt;login&gt; alias ([91def51](https://github.com/Necmttn/ax/commit/91def51e0d00fd59849067037e901f40d00c6484))
* **profile:** redefine DEPTH as outcome-density + add radar axis legend ([#475](https://github.com/Necmttn/ax/issues/475)) ([e30fbf7](https://github.com/Necmttn/ax/commit/e30fbf7246c7fce7dd98f95ea9380557c7b3eebc))
* seed ax team rig (.ax/skills + .ax/agents) + un-ignore it ([#451](https://github.com/Necmttn/ax/issues/451)) ([30efbc3](https://github.com/Necmttn/ax/commit/30efbc362446f6a6f1160c5adb84ac656286aacd))
* **serve:** serve studio from the daemon at 127, drop the hosted-studio link ([#476](https://github.com/Necmttn/ax/issues/476)) ([81d643b](https://github.com/Necmttn/ax/commit/81d643bceb9d9e601c6fa72beba8ec22b9b53a3c))
* **site:** "used by engineers from" logo strip on landing ([#453](https://github.com/Necmttn/ax/issues/453)) ([d615fcb](https://github.com/Necmttn/ax/commit/d615fcbc4753a1bbe9f81b6ff3a499dd1c5baed6))
* **site:** blog section + origin-grade article system ([#452](https://github.com/Necmttn/ax/issues/452)) ([4908e8f](https://github.com/Necmttn/ax/commit/4908e8f42c6380f90b4eea0444404aed3ad3c80c))
* **site:** dark-instrument Mission Control mock on the landing + cycling wrapped popups ([#460](https://github.com/Necmttn/ax/issues/460)) ([f680c34](https://github.com/Necmttn/ax/commit/f680c3402e3b860e0d0a910301f3242396e80812))
* **site:** embed ax studio /cost screenshots in blog post + showcases ([#461](https://github.com/Necmttn/ax/issues/461)) ([25ade75](https://github.com/Necmttn/ax/commit/25ade75b4d23f0fb18ca9b99afdd73fcf4d9d795))
* **site:** grouped header nav dropdowns + dark-instrument how-it-works PROPOSE deck ([#465](https://github.com/Necmttn/ax/issues/465)) ([40467e5](https://github.com/Necmttn/ax/commit/40467e552fe1a0a354a332fcd732cd7f2c42719f))
* **skills:** SkillOpt-informed skill hygiene — token-budget lint, namespace dedup, auto-load capture ([#458](https://github.com/Necmttn/ax/issues/458)) ([571ec51](https://github.com/Necmttn/ax/commit/571ec51b152d45539f7b5c3f4804725ed212d099))
* **studio:** /cost view + interactive regex routing tuner ([#459](https://github.com/Necmttn/ax/issues/459)) ([53ccfa4](https://github.com/Necmttn/ax/commit/53ccfa485a4bb70c3b500789c761a3a26d5975f4))
* **studio:** instrument-ify /sessions — masthead, hairline ledger, dark story strips ([#433](https://github.com/Necmttn/ax/issues/433)) ([6259b3d](https://github.com/Necmttn/ax/commit/6259b3d6200c72e8e995172416e3aa674ade69c6))
* **team:** `.ax.local/` experiment overlay + promote (Mesh B) ([#455](https://github.com/Necmttn/ax/issues/455)) ([2ae4533](https://github.com/Necmttn/ax/commit/2ae4533f8421b085029124f09c91953cca687ddd))
* **team:** executable-hook trust layer — `ax team trust` (Mesh A) ([#454](https://github.com/Necmttn/ax/issues/454)) ([3a18bb6](https://github.com/Necmttn/ax/commit/3a18bb6ecedf9c23a7b65a740d0ef4d3044a17a8))
* **team:** local `ax team sync` — Slice 0 of the team improvement mesh ([#440](https://github.com/Necmttn/ax/issues/440)) ([281d232](https://github.com/Necmttn/ax/commit/281d232170f8b8996b2c98804686a8e1b19d8e08))


### Bug Fixes

* **cli:** doctor honors AX_DB_URL + classify dead-end loop (dogfood) ([#456](https://github.com/Necmttn/ax/issues/456)) ([347661e](https://github.com/Necmttn/ax/commit/347661e3416c69010b02d3a8deed308eab5a19ed))
* **db:** route SurrealDB auth through connect() so ax serve never goes anonymous ([#431](https://github.com/Necmttn/ax/issues/431)) ([#435](https://github.com/Necmttn/ax/issues/435)) ([63d19d1](https://github.com/Necmttn/ax/commit/63d19d1c4ff47aad6a15c1096de9b48ad7386d0e))
* **install:** profile publish watcher gate 6h -&gt; 2h ([#464](https://github.com/Necmttn/ax/issues/464)) ([3e31684](https://github.com/Necmttn/ax/commit/3e31684a682abb11aa6884f6117257a40a4bc232))
* **signals:** exclude harness-injected turns from correction derivation ([#442](https://github.com/Necmttn/ax/issues/442)) ([86cd863](https://github.com/Necmttn/ax/commit/86cd8638ddbae188405bd8c4c40600c86f3ffd05))
* **studio:** dark-bridge remaining light-era route stragglers ([#436](https://github.com/Necmttn/ax/issues/436)) ([224be92](https://github.com/Necmttn/ax/commit/224be920ff24f1803fb3eb8ddf0c9a577f2b9daf))

## [0.31.0](https://github.com/Necmttn/ax/compare/v0.30.0...v0.31.0) (2026-06-15)


### Features

* ax hooks latency - regression lens over real hook-fire telemetry ([#425](https://github.com/Necmttn/ax/issues/425)) ([f34374f](https://github.com/Necmttn/ax/commit/f34374fdb44be906a4132327515538adf5181641))
* **mcp:** dojo_agenda tool + retire deferred cron trigger ([#420](https://github.com/Necmttn/ax/issues/420)) ([7aaece9](https://github.com/Necmttn/ax/commit/7aaece920eb869eb0fdc52d400e329ba384b1de7))
* **otel:** OTLP logs ingestion — Codex events into ax serve ([#432](https://github.com/Necmttn/ax/issues/432)) ([9ec015e](https://github.com/Necmttn/ax/commit/9ec015ecdc8709929ad88155e89ab86ed47b34e5))
* **otel:** OTLP receiver — harness usage telemetry into ax serve ([#423](https://github.com/Necmttn/ax/issues/423)) ([43c85d1](https://github.com/Necmttn/ax/commit/43c85d1f0d64ca18db49bdc8ea03c862336a8fc9))
* **site:** nullframe dot-matrix treatment for /u profile ([#400](https://github.com/Necmttn/ax/issues/400)) ([77a1702](https://github.com/Necmttn/ax/commit/77a1702eb6c4fb514b82d60c3c4706457703b18a))
* spar analytics-exclusion tag (behavioral-only) ([#424](https://github.com/Necmttn/ax/issues/424)) ([07c05bb](https://github.com/Necmttn/ax/commit/07c05bb27284a1ef725591c668ab12b208e99ef4))
* **studio:** instrument-ify the rest of the dashboard + Context Budget (reclaim/drift) ([#427](https://github.com/Necmttn/ax/issues/427)) ([b83e217](https://github.com/Necmttn/ax/commit/b83e217f6e5c11107fd70136c3804df36a244d66))
* **usage:** self-telemetry + personal utilization view (adoption Fix [#1](https://github.com/Necmttn/ax/issues/1)a) ([#421](https://github.com/Necmttn/ax/issues/421)) ([c7ac1d2](https://github.com/Necmttn/ax/commit/c7ac1d2e908570994555eb2fdd3479ff66ad78e2))


### Bug Fixes

* **otel:** correct Codex [otel] config format (was breaking all codex commands) ([#426](https://github.com/Necmttn/ax/issues/426)) ([b136fb2](https://github.com/Necmttn/ax/commit/b136fb276f09a8148896d4fc153d1847f55a2274))
* **studio:** /api/sessions all-sources 400 — coalesce NONE columns to null ([#428](https://github.com/Necmttn/ax/issues/428)) ([83d4397](https://github.com/Necmttn/ax/commit/83d43978c140824520f4732d2991668a8d5b031b))

## [0.30.0](https://github.com/Necmttn/ax/compare/v0.29.0...v0.30.0) (2026-06-15)


### Features

* ax dojo - surplus-quota training loop (agenda CLI + skill) ([#390](https://github.com/Necmttn/ax/issues/390)) ([4bae321](https://github.com/Necmttn/ax/commit/4bae32103940b7e3e253ef58026701bc2c07c448))
* ax dojo report + outbox writers (dojo command family) ([#403](https://github.com/Necmttn/ax/issues/403)) ([6ebefc6](https://github.com/Necmttn/ax/commit/6ebefc6828b5e51717fb8a6ecb6582bdde8a6c54))
* ax dojo spar - replay benchmark (one task, one delta, scored) ([#405](https://github.com/Necmttn/ax/issues/405)) ([e4b2707](https://github.com/Necmttn/ax/commit/e4b2707eff542b545dcd52792c98e3555262406a))
* ax hooks bench - hook latency ledger ([#404](https://github.com/Necmttn/ax/issues/404)) ([6ec1a2d](https://github.com/Necmttn/ax/commit/6ec1a2d5c914a1cc87a55e28d2f53d053a53bf84))
* **axctl:** dispatch model-drop detection + thinking/reasoning capture ([#387](https://github.com/Necmttn/ax/issues/387)) ([af57c68](https://github.com/Necmttn/ax/commit/af57c689a9b9db84951ac5623f365f1a6149a8f3))
* **axctl:** thinking/reasoning cost USD in ax thinking ([#395](https://github.com/Necmttn/ax/issues/395)) ([b6ee723](https://github.com/Necmttn/ax/commit/b6ee723ad4909066abab09c1d74ee14bbf372f2e))
* cognitive-layer dispatch enforcement (shared model-tier classifier) ([#416](https://github.com/Necmttn/ax/issues/416)) ([8a6991f](https://github.com/Necmttn/ax/commit/8a6991f3eccc6439885cbf8098dd23279c418171))
* **digest:** push-value SessionStart digest (adoption Fix [#2](https://github.com/Necmttn/ax/issues/2)) ([#414](https://github.com/Necmttn/ax/issues/414)) ([106e0fe](https://github.com/Necmttn/ax/commit/106e0fe7ae92f51b41a66778488e6f504b09fbe6))
* **hooks-sdk:** enforce-worktree keeps the primary tree parked on the default branch ([#367](https://github.com/Necmttn/ax/issues/367)) ([bae9794](https://github.com/Necmttn/ax/commit/bae9794258907bc98ae92169ad859df1f85604f7))
* **profile:** stacked window chart, workflow arcs, leverage-sorted rig ([#369](https://github.com/Necmttn/ax/issues/369)) ([32a87db](https://github.com/Necmttn/ax/commit/32a87dbe1e2407fd8e5301e0477527a95fedbbfa))
* quota-aware dispatch economy (PR2) - surface, freshness, /dojo nudge, measurement ([#413](https://github.com/Necmttn/ax/issues/413)) ([9e9f2b4](https://github.com/Necmttn/ax/commit/9e9f2b4ae80acf460ceeb5794d54dcf2ae94be66))
* **site:** community surfaces polish - leaders + showcases ([#393](https://github.com/Necmttn/ax/issues/393)) ([6478955](https://github.com/Necmttn/ax/commit/6478955273ec833410b962f3d72d437dd62f169a))
* **site:** four new showcases - dispatch routing, quota, improve loop, churn ([#383](https://github.com/Necmttn/ax/issues/383)) ([2539b1a](https://github.com/Necmttn/ax/commit/2539b1a05b510f9d4e225d01c3217fad2dc518fc))
* **site:** IA restructure - install path, three-tier docs hub, sitemap footer, ADR demotion ([#392](https://github.com/Necmttn/ax/issues/392)) ([64e22eb](https://github.com/Necmttn/ax/commit/64e22ebd9454fa601c8fb46d4a5cc410651cab3e))
* **site:** landing demo mirrors the real Improve dashboard ([#384](https://github.com/Necmttn/ax/issues/384)) ([098ef31](https://github.com/Necmttn/ax/commit/098ef3178dd8913674eb0a5fcfae240ed3f9abd9))
* **site:** rebuild /brand as a self-demonstrating specimen page ([#399](https://github.com/Necmttn/ax/issues/399)) ([8a14fc1](https://github.com/Necmttn/ax/commit/8a14fc16299484a4e9803da6ca6c7a736c13f006))
* **site:** rebuild /docs/cli-reference as a purpose-built reference ([#394](https://github.com/Necmttn/ax/issues/394)) ([fb25f27](https://github.com/Necmttn/ax/commit/fb25f279094c15e0de644526ef7802bd9398565f))
* **site:** redesign /how-it-works as the five-act visual product narrative ([#402](https://github.com/Necmttn/ax/issues/402)) ([0b256de](https://github.com/Necmttn/ax/commit/0b256debb517fb220767e894eb28ed60f0821e7a))
* **site:** truth pass on teams/registry/routing + curated glossary ([#398](https://github.com/Necmttn/ax/issues/398)) ([a135dbb](https://github.com/Necmttn/ax/commit/a135dbbe9d79e498cdee6be72c0d380baa99ebbe))
* **site:** v0.27-v0.29 release announcements + index-ify /changelog ([#391](https://github.com/Necmttn/ax/issues/391)) ([44e42dd](https://github.com/Necmttn/ax/commit/44e42dd9ccc3c784fc6b27a43acec7477f3a175c))
* **studio:** nullframe instrument design system — Mission Control, living sigils, viz deck ([#415](https://github.com/Necmttn/ax/issues/415)) ([edc1c3f](https://github.com/Necmttn/ax/commit/edc1c3ff259df8232e62fa5bca4149d8323d1438))


### Bug Fixes

* **dojo:** spar-plan warns + flags subagent-only baselines ([#409](https://github.com/Necmttn/ax/issues/409)) ([59c44af](https://github.com/Necmttn/ax/commit/59c44af43628f05b467e9d4e619c33e5a269ccda))
* make installs survive broken releases ([#410](https://github.com/Necmttn/ax/issues/410)) ([#418](https://github.com/Necmttn/ax/issues/418)) ([31081c3](https://github.com/Necmttn/ax/commit/31081c31e59ab6384c7c39beb1e9e262afa44c91))
* **site:** contain CLI-reference receipt/signature blocks in their cards ([#406](https://github.com/Necmttn/ax/issues/406)) ([8f76527](https://github.com/Necmttn/ax/commit/8f7652749621d4ad5779a7936b292b5588ba2ece))
* **site:** document `ax dojo` in CLI reference (unbreak main) ([#396](https://github.com/Necmttn/ax/issues/396)) ([69ed593](https://github.com/Necmttn/ax/commit/69ed5938853375778008d9e321697d08d7fbcc91))
* **site:** truth pass on story/credibility pages (features, origin, manifesto) ([#401](https://github.com/Necmttn/ax/issues/401)) ([dfa50f3](https://github.com/Necmttn/ax/commit/dfa50f3308a9c709ecfafbcb5840c9f72861f7ff))
* **site:** window chart height matches the model-split legend column ([#370](https://github.com/Necmttn/ax/issues/370)) ([a809c40](https://github.com/Necmttn/ax/commit/a809c4005128a7f1cb8247fb9bf4785b47248500))

## [0.29.0](https://github.com/Necmttn/ax/compare/v0.28.0...v0.29.0) (2026-06-12)


### Features

* **axctl:** ax quota - Claude plan usage in CLI, statusline, and menubar ([#365](https://github.com/Necmttn/ax/issues/365)) ([cdaebed](https://github.com/Necmttn/ax/commit/cdaebedc1b3acb5b1fdba890e1c9e15c206490e6))
* **improve:** impact engine - backtested projected value per proposal (PR5a) ([#361](https://github.com/Necmttn/ax/issues/361)) ([2581e33](https://github.com/Necmttn/ax/commit/2581e339df47e850c8847db166fb4af2f523f82d))
* **profile:** port wrapped-style aggregates into ProfileV1 insights ([#359](https://github.com/Necmttn/ax/issues/359)) ([4e361b8](https://github.com/Necmttn/ax/commit/4e361b8c23d7d92b6b8dbb063f1cf8893428ab52))
* **site:** /routing marketing page + og-kit shared OG primitives ([#366](https://github.com/Necmttn/ax/issues/366)) ([599b99e](https://github.com/Necmttn/ax/commit/599b99e74249887ed7ac049bda1533c74ed9935d))
* **site:** agent-sign radar - six-axis spider chart, compare overlay, raw-values table ([#364](https://github.com/Necmttn/ax/issues/364)) ([4092f42](https://github.com/Necmttn/ax/commit/4092f428ca54555158149bb471beb0b693e96efc))
* **site:** generative dither art + trace minis on dossier insight cards ([#363](https://github.com/Necmttn/ax/issues/363)) ([6d93daa](https://github.com/Necmttn/ax/commit/6d93daa5761aab827a3404682a39689418c0eaf3))


### Bug Fixes

* **ci:** community-users validate reports on every PR (required-check safe) ([#358](https://github.com/Necmttn/ax/issues/358)) ([17a10df](https://github.com/Necmttn/ax/commit/17a10df059403147aa5d82a40a151e384d862629))
* **community:** compiled outputs move to the community-data branch ([#362](https://github.com/Necmttn/ax/issues/362)) ([74f24f1](https://github.com/Necmttn/ax/commit/74f24f1c3a5a6493a160500372b7eaa9da864fd8))

## [0.28.0](https://github.com/Necmttn/ax/compare/v0.27.0...v0.28.0) (2026-06-12)


### Features

* **contract:** tighten bounded sessions payloads - completes curated-payload typing ([#349](https://github.com/Necmttn/ax/issues/349)) ([7f5e57a](https://github.com/Necmttn/ax/commit/7f5e57adb1340d6666b0c1015c13594f12b230f3))
* **contract:** tighten curated payloads - skills + insights families (13 endpoints) ([#347](https://github.com/Necmttn/ax/issues/347)) ([698d1c3](https://github.com/Necmttn/ax/commit/698d1c3218ec8f31891d2da334dfe6d8bc253380))
* **contract:** tighten the recall response to a real Schema (payload-typing template) ([#346](https://github.com/Necmttn/ax/issues/346)) ([c7a4ee3](https://github.com/Necmttn/ax/commit/c7a4ee3aa1a2f38dbf9a8d57f312bb76c7593d61))
* **improve:** agent write-path - ax improve propose/analyze + origin badges (PR3) ([#340](https://github.com/Necmttn/ax/issues/340)) ([4ca3574](https://github.com/Necmttn/ax/commit/4ca35742fbcab74ee66ab9ca2ee0abbd644b1675))
* **og:** design-review polish - crisp single-color mark, named peak, full-bleed grid ([#341](https://github.com/Necmttn/ax/issues/341)) ([9bce56c](https://github.com/Necmttn/ax/commit/9bce56cdb78ad4f95b05ea494e498f13b8f9fc2f))
* **site:** shared og-kit, canonical block AX logo, dense profile card ([#337](https://github.com/Necmttn/ax/issues/337)) ([1b1d7c2](https://github.com/Necmttn/ax/commit/1b1d7c2463f660bf4a26185cd3fed17cecba3996))
* **studio:** nav re-home + ingest splash overlay (PR2) ([#332](https://github.com/Necmttn/ax/issues/332)) ([e96eb44](https://github.com/Necmttn/ax/commit/e96eb44941835815a96cff1836406999b1275b9e))
* **wrapped:** paxel-style agent-generated recap cards (PR4) ([#344](https://github.com/Necmttn/ax/issues/344)) ([e6618bd](https://github.com/Necmttn/ax/commit/e6618bdac7a3ea63746a57ec0c35399546048a8a))


### Bug Fixes

* **marketing+site:** plain-language pass - kill pinned/mines jargon, add the misconception hook ([#352](https://github.com/Necmttn/ax/issues/352)) ([a84002c](https://github.com/Necmttn/ax/commit/a84002c58be567936803777ff5f13749c3165878))
* **site:** /routing speaks to the reader + mobile layout fixes ([#342](https://github.com/Necmttn/ax/issues/342)) ([adea4a3](https://github.com/Necmttn/ax/commit/adea4a310cee7c29c3b28fdbbb51b8c0b725592b))


### Performance

* **dashboard:** worktrees overview via deref-free aggregates - 57s timeout to under 4s ([#343](https://github.com/Necmttn/ax/issues/343)) ([ad955cc](https://github.com/Necmttn/ax/commit/ad955cc6516848ae076689fd9d1c9663b8ce3d00))

## [0.27.0](https://github.com/Necmttn/ax/compare/v0.26.0...v0.27.0) (2026-06-12)


### Features

* **community:** repo rails - registration auto-merge + nightly compile (plan 3) ([#320](https://github.com/Necmttn/ax/issues/320)) ([86f44d4](https://github.com/Necmttn/ax/commit/86f44d493a7fac6750a05f34b51ef1648ee663b5))
* **dashboard+studio:** insights family on the contract + DB-down hardening ([#329](https://github.com/Necmttn/ax/issues/329)) ([89154ec](https://github.com/Necmttn/ax/commit/89154ec2807c013d4e209d08f483cb6b7f8b9c78))
* **dashboard+studio:** sessions family on the contract ([#331](https://github.com/Necmttn/ax/issues/331)) ([57dfdb4](https://github.com/Necmttn/ax/commit/57dfdb44d998f5b58806f148f3ae4f0b6ab4b22f))
* **dashboard+studio:** skills, improve, and ingest on the contract - migration complete ([#334](https://github.com/Necmttn/ax/issues/334)) ([3d4287b](https://github.com/Necmttn/ax/commit/3d4287bf07201b43b9bea1c1eda092999d225eed))
* **dashboard:** improve-first - next actions panel with agent briefs (PR1) ([#327](https://github.com/Necmttn/ax/issues/327)) ([5d6bc85](https://github.com/Necmttn/ax/commit/5d6bc85fbf5ea18f25c453d4a499a0ef97de5c16))
* **dashboard:** Insights Surface Contract v1 - system family on Effect HttpApi + Scalar docs ([#322](https://github.com/Necmttn/ax/issues/322)) ([479a8d0](https://github.com/Necmttn/ax/commit/479a8d0d12937813c770e916e32f2ace2cc9f918))
* **dashboard:** server-scoped Effect runtime behind the EffectRunner seam ([#314](https://github.com/Necmttn/ax/issues/314)) ([d1980fd](https://github.com/Necmttn/ax/commit/d1980fd373162d9470bcb5cbfc78fc71168e3101))
* **profile:** activity + insights sections & profile-page redesign ([#330](https://github.com/Necmttn/ax/issues/330)) ([9627970](https://github.com/Necmttn/ax/commit/9627970735b63b784f9117612ea4be5b3c5cb73a))
* **profile:** ax profile publish/unpublish - profiles spec, plan 2 (gist + fork rails) ([#319](https://github.com/Necmttn/ax/issues/319)) ([157b8b2](https://github.com/Necmttn/ax/commit/157b8b26f542bde3210a056b9b68a785ad071435))
* **profile:** ax profile show - profiles spec, plan 1 (local renderer) ([#318](https://github.com/Necmttn/ax/issues/318)) ([8cc6e6f](https://github.com/Necmttn/ax/commit/8cc6e6ff6418f77a9adfacd296f6204cb64caa37))
* **routing:** ax routing tune - user-facing routing-table tuning ([#328](https://github.com/Necmttn/ax/issues/328)) ([2dffb62](https://github.com/Necmttn/ax/commit/2dffb6232599b660d6589ee1eeb4a0940244fd30))
* **serve:** self-aware daemon - friendly already-running UX, status/stop ([#315](https://github.com/Necmttn/ax/issues/315)) ([a262f0e](https://github.com/Necmttn/ax/commit/a262f0efb2f8b658114740bb1713cda2819229be))
* **site:** /routing feature page + launch marketing assets ([#336](https://github.com/Necmttn/ax/issues/336)) ([56c9658](https://github.com/Necmttn/ax/commit/56c9658d2c2541ae4042538b4a789976097242f7))
* **site:** /u/&lt;login&gt; profiles + /leaders boards - profiles spec, plan 4 ([#321](https://github.com/Necmttn/ax/issues/321)) ([29a761c](https://github.com/Necmttn/ax/commit/29a761c49c3bb9e2ac081190b03983512eac21fb))
* **site:** profile OG cards, crawler meta, visitor CTA ([#333](https://github.com/Necmttn/ax/issues/333)) ([46d1ffe](https://github.com/Necmttn/ax/commit/46d1ffe0989a4a73d66f642bf2e72385e4828a87))
* **studio:** generated HttpApiClient for the version handshake (contract PR B) ([#325](https://github.com/Necmttn/ax/issues/325)) ([6c31aa3](https://github.com/Necmttn/ax/commit/6c31aa35158f97efc969f7980fc8ce79b7110f9d))


### Bug Fixes

* **community:** live-test findings - lowercase registration filename, raw-URL gist fetch ([#324](https://github.com/Necmttn/ax/issues/324)) ([b7f42ef](https://github.com/Necmttn/ax/commit/b7f42ef70aae50386589094f767aa354dc8722fd))
* **community:** lowercase registration filename (necmttn) ([fb84eeb](https://github.com/Necmttn/ax/commit/fb84eeb78b9422547a155fe970c7c33077a996a4))
* **community:** remove uppercase duplicate registration ([2fdffb9](https://github.com/Necmttn/ax/commit/2fdffb9489168d2e148a240320438974e6b8d8a9))
* **site:** correct repo-root mirror import depth for 2-level functions ([#335](https://github.com/Necmttn/ax/issues/335)) ([49d2e16](https://github.com/Necmttn/ax/commit/49d2e16016d9b6d30e125555ab50e8ffce5b45c3))
* **studio:** guard sessionInsights against old-daemon catch-all payload ([#317](https://github.com/Necmttn/ax/issues/317)) ([118afbe](https://github.com/Necmttn/ax/commit/118afbe801068181aa35e161d2cf86027af312ca))

## [0.26.0](https://github.com/Necmttn/ax/compare/v0.25.0...v0.26.0) (2026-06-12)


### Features

* **cli:** ax cost models/sessions/split + MCP cost tools ([#301](https://github.com/Necmttn/ax/issues/301)) ([a77a082](https://github.com/Necmttn/ax/commit/a77a082d6c7f6b720b5d4c64385a5b44f54e02f2))
* **cli:** ax dispatches + --candidates + compile-routing ([#303](https://github.com/Necmttn/ax/issues/303)) ([8d11f5f](https://github.com/Necmttn/ax/commit/8d11f5fc515c7c48f197185de079ec73c2efa0d3))
* **cli:** ax sessions churn - verification churn insight ([#308](https://github.com/Necmttn/ax/issues/308)) ([f75036d](https://github.com/Necmttn/ax/commit/f75036da7801eb92840df939ed572a7506b79530))
* **cli:** manifest owns command visibility - uniform registration loop ([#293](https://github.com/Necmttn/ax/issues/293)) ([6d1dabc](https://github.com/Necmttn/ax/commit/6d1dabc0c543cc66909a617282ef6a71eeabf066))
* **dashboard:** sessions list remakeover - enriched rows + insight accordion ([#299](https://github.com/Necmttn/ax/issues/299)) ([c73dd1f](https://github.com/Necmttn/ax/commit/c73dd1fbdafc3c0c8be2705f1509a039ace9b90a))
* **dashboard:** surface skipped-file failures from ingest in the Live tab ([#294](https://github.com/Necmttn/ax/issues/294)) ([d3818ef](https://github.com/Necmttn/ax/commit/d3818ef74d8d92943d094ea4db60c541e70540c9)), closes [#262](https://github.com/Necmttn/ax/issues/262)
* **hooks-sdk:** route-dispatch hook - model-routing suggestions on Agent dispatches ([#302](https://github.com/Necmttn/ax/issues/302)) ([0750963](https://github.com/Necmttn/ax/commit/075096379ba6f93e4509f13b7ab1a393cc285a3d))
* **improve:** routing proposal rule in the proposals derive stage ([#306](https://github.com/Necmttn/ax/issues/306)) ([739258c](https://github.com/Necmttn/ax/commit/739258c42ffcac81c71cc6a17c90e898f197ce9e))
* **ingest:** extend per-file failure isolation to Pi, OpenCode, and Cursor ([#295](https://github.com/Necmttn/ax/issues/295)) ([b1cf97c](https://github.com/Necmttn/ax/commit/b1cf97c5f1e1bb9e03a737e7b5664a1b62f52172)), closes [#261](https://github.com/Necmttn/ax/issues/261)
* **routing:** apply /routing-tune mined classes - task-N-impl, bug-fix, feature-add ([#310](https://github.com/Necmttn/ax/issues/310)) ([009103d](https://github.com/Necmttn/ax/commit/009103d6dd39a981060b0fb70f1162bd97dc75e8))
* **skills:** efficient-dispatch - measured model-routing orchestration ([#307](https://github.com/Necmttn/ax/issues/307)) ([d999d2e](https://github.com/Necmttn/ax/commit/d999d2e9dc5ffcccc905e2b5078ef4cc395dd6bf))
* **studio:** files-touched tree, review view, and session narration ([#235](https://github.com/Necmttn/ax/issues/235)) ([ec464f3](https://github.com/Necmttn/ax/commit/ec464f3d5ee2f7b29cdad0451a93a256883435cf))
* **studio:** Story tab as narration-grounded review surface (share manifest v5) ([#309](https://github.com/Necmttn/ax/issues/309)) ([bb943aa](https://github.com/Necmttn/ax/commit/bb943aa27da8b278af451df872621dc97db0d022))


### Bug Fixes

* **cli:** route share/star through family manifests, drop dispatch bypass ([#286](https://github.com/Necmttn/ax/issues/286)) ([f0fe014](https://github.com/Necmttn/ax/commit/f0fe0144107cdfc7023f492077edf381274e8a0d)), closes [#242](https://github.com/Necmttn/ax/issues/242)
* **dashboard:** short-circuit empty-q /api/recall before AppLayer ([#284](https://github.com/Necmttn/ax/issues/284)) ([683596a](https://github.com/Necmttn/ax/commit/683596a76df2db42a4c6ee852109a5f35fef4377)), closes [#245](https://github.com/Necmttn/ax/issues/245)
* **hooks-sdk:** align route-dispatch defaults with tuned ROUTING_CLASSES ([#304](https://github.com/Necmttn/ax/issues/304)) ([c1666bc](https://github.com/Necmttn/ax/commit/c1666bc3d26ac8eb8feb4b63ea161cebe156799d))
* **hooks-sdk:** honor worktree guard bypasses ([0be68e1](https://github.com/Necmttn/ax/commit/0be68e1d98e8ebb5785dd3430c4bc9d115b1c80e))
* **ingest:** subagent model attribution + spawned edge dispatch metadata ([#300](https://github.com/Necmttn/ax/issues/300)) ([91e86d8](https://github.com/Necmttn/ax/commit/91e86d89d7341915765eaec0f307ba63fc978a25))
* **inspect:** bound and chunk the direct block/atom ref fan-out ([#290](https://github.com/Necmttn/ax/issues/290)) ([ecdcbf2](https://github.com/Necmttn/ax/commit/ecdcbf2959a2207013d967482e3422452523a254)), closes [#263](https://github.com/Necmttn/ax/issues/263)


### Performance

* **schema:** add skill_paired endpoint indexes ([#285](https://github.com/Necmttn/ax/issues/285)) ([fc5c5c5](https://github.com/Necmttn/ax/commit/fc5c5c5a562b77f2a547d60a1978027ba92f4129)), closes [#246](https://github.com/Necmttn/ax/issues/246)

## [0.25.0](https://github.com/Necmttn/ax/compare/v0.24.0...v0.25.0) (2026-06-11)


### Features

* **ingest:** per-file failure isolation for Claude + Codex stages ([#257](https://github.com/Necmttn/ax/issues/257)) ([9a0ab11](https://github.com/Necmttn/ax/commit/9a0ab115edb1ff3c19347cc12f0489f21e4ba14e))
* **share:** target-ingest the session when it isn't in the graph yet ([#277](https://github.com/Necmttn/ax/issues/277)) ([84d4891](https://github.com/Necmttn/ax/commit/84d48914d6eb39d7111c0c608756fdd727737257)), closes [#270](https://github.com/Necmttn/ax/issues/270)
* **studio:** enrich tool stdout blocks - Read files highlighted, log outputs tinted ([#238](https://github.com/Necmttn/ax/issues/238)) ([738bff7](https://github.com/Necmttn/ax/commit/738bff79deaf7764c4bbe54b1c242e832d5a2816))
* **studio:** poll stats when the live stream sidecar is unavailable ([#278](https://github.com/Necmttn/ax/issues/278)) ([b7cef15](https://github.com/Necmttn/ax/commit/b7cef156735d2a7d8959e808541035d278eec82e)), closes [#272](https://github.com/Necmttn/ax/issues/272)
* **studio:** render edit tool calls as syntax-highlighted diffs ([#239](https://github.com/Necmttn/ax/issues/239)) ([7fcdab8](https://github.com/Necmttn/ax/commit/7fcdab82070b62d25fa635a750026a312d31309b))
* **timeline:** carry command + intent in tool event titles ([#256](https://github.com/Necmttn/ax/issues/256)) ([1e9a7d9](https://github.com/Necmttn/ax/commit/1e9a7d9b0e82e276f25ea0dbc18a4285554cae94))


### Bug Fixes

* **ci:** stop release publish jobs racing on asset upload ([#260](https://github.com/Necmttn/ax/issues/260)) ([0350e23](https://github.com/Necmttn/ax/commit/0350e232e3c99f9777aa06ea1262d4e590548c6c))
* **docs:** align dashboard port references with serve default 1738 ([#275](https://github.com/Necmttn/ax/issues/275)) ([02cd27f](https://github.com/Necmttn/ax/commit/02cd27f5523a12cc4ab6dd8cfffa279f4c7eb673)), closes [#268](https://github.com/Necmttn/ax/issues/268)
* **ingest:** dry-run estimates remaining backfill instead of refusing when populated ([#276](https://github.com/Necmttn/ax/issues/276)) ([f69798a](https://github.com/Necmttn/ax/commit/f69798a79ecb98aca0400b5cf95f5680d9e10434)), closes [#267](https://github.com/Necmttn/ax/issues/267)
* **ingest:** finalize run lifecycle on every exit path, honest exit codes ([#279](https://github.com/Necmttn/ax/issues/279)) ([86fa208](https://github.com/Necmttn/ax/commit/86fa20882450c82e01dc7d55469dc8f69f7aac04))
* **install:** report expected vs actual hash on checksum mismatch instead of silent abort ([#273](https://github.com/Necmttn/ax/issues/273)) ([a56bc57](https://github.com/Necmttn/ax/commit/a56bc574485fccf01c0e09fc35e50505b63c25a0)), closes [#271](https://github.com/Necmttn/ax/issues/271)
* **share:** adapt recover to discriminated ingest-lock outcome ([#280](https://github.com/Necmttn/ax/issues/280)) ([31b5289](https://github.com/Necmttn/ax/commit/31b52891c0b2fa92d3a49496fbb74ad7901ba051))
* **skills:** emit classify briefs as top-of-file frontmatter so lint can parse them ([#274](https://github.com/Necmttn/ax/issues/274)) ([92fab55](https://github.com/Necmttn/ax/commit/92fab55c621bc299beb07fdd1886727324248457)), closes [#264](https://github.com/Necmttn/ax/issues/264)

## [0.24.0](https://github.com/Necmttn/ax/compare/v0.23.0...v0.24.0) (2026-06-11)


### Features

* @ax/hooks-sdk - typed cross-harness hooks with install + backtest ([#252](https://github.com/Necmttn/ax/issues/252)) ([a7aaf92](https://github.com/Necmttn/ax/commit/a7aaf92cbc8197bf01a7211ffd4125fa59c3f5fa))


### Bug Fixes

* **ingest:** SurrealDB 3.0.x record-list select abort + per-machine bucket paths ([#253](https://github.com/Necmttn/ax/issues/253)) ([1c71f36](https://github.com/Necmttn/ax/commit/1c71f369502dbfdbdc06b170eb6c99abdd7c0922))
* **share:** bucket turn usage onto kept turns so cost-so-far accumulates ([#237](https://github.com/Necmttn/ax/issues/237)) ([3306631](https://github.com/Necmttn/ax/commit/330663135e0f72ba59e4c7ae6209611d095b967f))

## [0.23.0](https://github.com/Necmttn/ax/compare/v0.22.2...v0.23.0) (2026-06-10)


### Features

* **og:** version og:image URLs so social caches pick up poster changes ([#234](https://github.com/Necmttn/ax/issues/234)) ([1fdd2d0](https://github.com/Necmttn/ax/commit/1fdd2d077562bde59c8eeacf9a0ce228d9ce8d64))
* **studio:** syntax highlighting in session/share transcript views ([6d9a182](https://github.com/Necmttn/ax/commit/6d9a182b344182bee6310fb80743f60ac5212a09))

## [0.22.2](https://github.com/Necmttn/ax/compare/v0.22.1...v0.22.2) (2026-06-10)


### Bug Fixes

* **ingest:** add claude-fable-5 + claude-haiku-4-5 to builtin pricing catalog ([#225](https://github.com/Necmttn/ax/issues/225)) ([0830a49](https://github.com/Necmttn/ax/commit/0830a49d62dcfc7da299c8b3c36312fd3bdc5aa7))

## [0.22.1](https://github.com/Necmttn/ax/compare/v0.22.0...v0.22.1) (2026-06-10)


### Bug Fixes

* **deploy:** functions for the Pages git integration + post-deploy verification ([#214](https://github.com/Necmttn/ax/issues/214)) ([18e508d](https://github.com/Necmttn/ax/commit/18e508ddbf1f4dd593446155a6467923c8c8fa51))
* NavLink round-3 - next block first, session id prefix resolve, summary floor ([df4e346](https://github.com/Necmttn/ax/commit/df4e3463d51b6f5579d9f90f0d7f369f9f23cb3a))
* NavLink round-3 — next block first, session id prefix resolve, summary floor ([b0d4698](https://github.com/Necmttn/ax/commit/b0d4698aa0759adb526508f2d0225807494ceb60))
* **studio:** cost rail sticky offset clears the jump bar ([#212](https://github.com/Necmttn/ax/issues/212)) ([d35d03a](https://github.com/Necmttn/ax/commit/d35d03a101ab746e9e93b49fe361325d33333db2))

## [0.22.0](https://github.com/Necmttn/ax/compare/v0.21.0...v0.22.0) (2026-06-10)


### Features

* **share:** session poster hero + per-session OG images ([#201](https://github.com/Necmttn/ax/issues/201)) ([7239f5a](https://github.com/Necmttn/ax/commit/7239f5a364bdd346f2c787d456a8f504e398844f))


### Bug Fixes

* cast stderr stub instead of ts-expect-error (CI strict tsc) ([29e7cb1](https://github.com/Necmttn/ax/commit/29e7cb1a4075887306b07ce0f56c53ff02e34a5e))
* NavLink retro findings - stderr footer, teaching stats error, full header id ([1900a40](https://github.com/Necmttn/ax/commit/1900a40d7ec7972d09e092076be5173e0b94502c))
* NavLink retro findings — stderr footer, teaching stats error, full header id ([a80149e](https://github.com/Necmttn/ax/commit/a80149ed54b619c8c95dbefb939ae5fd2f6cdf2b))
* **og:** buffer the poster render; version the edge cache key ([#203](https://github.com/Necmttn/ax/issues/203)) ([93c011c](https://github.com/Necmttn/ax/commit/93c011cde2487f314e0457182105a48de4f4529e))
* **og:** make the poster render — error surfacing, px geometry, SVG-img lanes ([#205](https://github.com/Necmttn/ax/issues/205)) ([78f0f48](https://github.com/Necmttn/ax/commit/78f0f487f4a62d2270d919b55e6aee3c40ea7792))
* **share:** rewrite head meta at the edge so crawlers see the session poster ([#207](https://github.com/Necmttn/ax/issues/207)) ([65d1d25](https://github.com/Necmttn/ax/commit/65d1d2578bb7cac258b372248506aeb02fca48b2))

## [0.21.0](https://github.com/Necmttn/ax/compare/v0.20.0...v0.21.0) (2026-06-10)


### Features

* extend NavLink next[] to skills, roles, and improve surfaces ([8488108](https://github.com/Necmttn/ax/commit/848810899cc1fd6992cf118ebe014b8284b1ea26))
* NavLink next[] follow-ups — self-documenting query surface (HATEOAS for LLMs) ([f875e10](https://github.com/Necmttn/ax/commit/f875e10a5ab862d56cbc51c2bd7dfd0f7b1cfe77))
* NavLink next[] follow-ups on recall/sessions/session-show ([be51240](https://github.com/Necmttn/ax/commit/be512401f8f1e28d2daa4ccfd60ec6aebe317196))
* **otel:** deep span instrumentation for ingest stages ([#197](https://github.com/Necmttn/ax/issues/197)) ([939f974](https://github.com/Necmttn/ax/commit/939f974b5a3a5f6fcf7338bc64bc0d5f55667e22))
* **timeline:** +/- line counts, smart shell titles, subagent landing continuity ([#191](https://github.com/Necmttn/ax/issues/191)) ([903c3eb](https://github.com/Necmttn/ax/commit/903c3ebb20e70795d610bcf303906a7cacb01c9c))


### Bug Fixes

* **share:** mobile layout + 'recorded with ax' CTA ([#192](https://github.com/Necmttn/ax/issues/192)) ([452d504](https://github.com/Necmttn/ax/commit/452d50493882425c68b7365a0ad5f49c25562629))
* **share:** subagent nav state isolation + deep-linkable sub/view + timeline turn jumps ([#190](https://github.com/Necmttn/ax/issues/190)) ([277c94c](https://github.com/Necmttn/ax/commit/277c94c1b9aa77bf4e68aa75f4e83f30151b960f))
* **studio:** share-view polish - overflow, scroll reset, embedded timeline ([#187](https://github.com/Necmttn/ax/issues/187)) ([6e58a41](https://github.com/Necmttn/ax/commit/6e58a4151133cf56c7cf95cf5f81da7995d0d480))
* **timeline:** title Agent dispatches with their description ([#189](https://github.com/Necmttn/ax/issues/189)) ([da594e5](https://github.com/Necmttn/ax/commit/da594e597c29a726b451354f5317a5520fd7e143))
* **timeline:** widen command_text slice so shell descriptions survive ([#193](https://github.com/Necmttn/ax/issues/193)) ([39d9b2e](https://github.com/Necmttn/ax/commit/39d9b2e91c187f5352500dcce64a180cbc542f41))


### Performance

* **ingest:** github-pr per-repo fetch cooldown + OTLP env passthrough in installed plists ([#194](https://github.com/Necmttn/ax/issues/194)) ([aad3285](https://github.com/Necmttn/ax/commit/aad328525e48a4460ef5034c541d1c750be53494))

## [0.20.0](https://github.com/Necmttn/ax/compare/v0.19.1...v0.20.0) (2026-06-10)


### Features

* **metrics:** dogfood follow-ups — provider parity, fragility cascade, PR freshness, cost, aggregates ([#170](https://github.com/Necmttn/ax/issues/170)-[#178](https://github.com/Necmttn/ax/issues/178)) ([#183](https://github.com/Necmttn/ax/issues/183)) ([30f903c](https://github.com/Necmttn/ax/commit/30f903cec55f4138288e862890d389c480b3cec8))


### Bug Fixes

* **cli:** reject non-date args to sessions around instead of empty window ([#184](https://github.com/Necmttn/ax/issues/184)) ([aef5d7c](https://github.com/Necmttn/ax/commit/aef5d7c7afe650dd57e17007df1680a66dc09b3f))
* **studio:** accept schema_version 4 share manifests ([#186](https://github.com/Necmttn/ax/issues/186)) ([69652d0](https://github.com/Necmttn/ax/commit/69652d0f63e8274c919913ce7088957c909fdfce))

## [0.19.1](https://github.com/Necmttn/ax/compare/v0.19.0...v0.19.1) (2026-06-10)


### Bug Fixes

* **ingest:** unwedge ingest (quadratic clear DELETE) + OTLP profiling instrumentation ([#180](https://github.com/Necmttn/ax/issues/180)) ([f9bc433](https://github.com/Necmttn/ax/commit/f9bc433005d5d2af9401b914f88737718fa00c97))

## [0.19.0](https://github.com/Necmttn/ax/compare/v0.18.0...v0.19.0) (2026-06-10)


### Features

* graph-derived session metrics (ax sessions metrics + ax signals) ([#166](https://github.com/Necmttn/ax/issues/166)) ([df701ad](https://github.com/Necmttn/ax/commit/df701ad490c74195035baca7e35ced166ef98204))
* **studio:** show studio build version + daemon mismatch nag in live banner ([9b28786](https://github.com/Necmttn/ax/commit/9b28786605a0ec915f59f512b8ecfacac8306891))


### Bug Fixes

* **metrics:** anchor time-to-land on commit ts; fix stale sort description ([#169](https://github.com/Necmttn/ax/issues/169)) ([d7f77a6](https://github.com/Necmttn/ax/commit/d7f77a6cd2a631c03b53b94505b5967105efe289))
* **sessions,ingest,share:** unhang session queries + single-flight ingest + share perf ([#167](https://github.com/Necmttn/ax/issues/167)) ([b66fb0b](https://github.com/Necmttn/ax/commit/b66fb0b7f692e18734824f639127bbb7e63fbbf2))
* **site:** pass /studio/assets/* through before the studio SPA catch-all ([4b8043f](https://github.com/Necmttn/ax/commit/4b8043fde52ec2a89efb3583cb1116d07e3a8f70))
* **site:** studio deep-link rewrite targets the dir, not /studio/index.html ([2d7b4a9](https://github.com/Necmttn/ax/commit/2d7b4a91eef9f90ad02c6f3121f449137ab4b274))


### Performance

* kill IN-membership scans + correlated $parent.session derefs on read paths ([#168](https://github.com/Necmttn/ax/issues/168)) ([1cf8c3f](https://github.com/Necmttn/ax/commit/1cf8c3f63abd8a64f6dea3a13d51947f7bf8b36d))

## [0.18.0](https://github.com/Necmttn/ax/compare/v0.17.0...v0.18.0) (2026-06-09)


### Features

* **ingest:** add gh pr list fetch module ([1ac2c2b](https://github.com/Necmttn/ax/commit/1ac2c2b1b7db4d0a77554c34a0fa767c468b08b3))
* **ingest:** add PR/review/check/delivery writer with session linking ([88d8b60](https://github.com/Necmttn/ax/commit/88d8b605e5e3a6ad2ec4de752304167952da58a2))
* **ingest:** extend PR normalizers for gh CLI + check/review aggregators ([d8d1c87](https://github.com/Necmttn/ax/commit/d8d1c87ce070fedbe8e6596d311055598c6a2c4b))
* **ingest:** register github-pr stage (fetch+normalize+write+link) ([b77106f](https://github.com/Necmttn/ax/commit/b77106fd132afd8b72c50f0ccd3fc351772b76d6))


### Bug Fixes

* **ingest:** escape PR datetimes, content-stable child keys, document delivery uniqueness ([793039d](https://github.com/Necmttn/ax/commit/793039df9a152a9b63800e6f973cc558231f29c5))
* **ingest:** make github-pr stage work end-to-end against live gh ([1096686](https://github.com/Necmttn/ax/commit/1096686ed82b97de0c659c199ee2f0af17819d92))
* **ingest:** remove incomplete github-pr stage (restore 25-stage set, unblock CI) ([2cd3fd1](https://github.com/Necmttn/ax/commit/2cd3fd18db0edda4c52a991cc4a785159521aa37))
* **ingest:** scope github-pr stage to ctx.repoPaths ([02745e1](https://github.com/Necmttn/ax/commit/02745e1325e2336738656ac1dd8339a2156746f9))
* **studio:** populate tool_calls in the graph inspect path ([9276cf3](https://github.com/Necmttn/ax/commit/9276cf3762c536267575d0a31f25261236094cc3))

## [0.17.0](https://github.com/Necmttn/ax/compare/v0.16.0...v0.17.0) (2026-06-09)


### Features

* **metrics:** add `ax loc` lines-of-code metric ([9d04bb6](https://github.com/Necmttn/ax/commit/9d04bb6f59d650f4cced94cf0cfefe129f9fb6f1))
* **studio:** sessions design pass - share outcome header ([#158](https://github.com/Necmttn/ax/issues/158)) ([4d2894b](https://github.com/Necmttn/ax/commit/4d2894b01cfdf37f26d0e97e0541ee6d45694264))
* **studio:** unified transcript tool rendering (ported onto studio structure) ([b0d0bce](https://github.com/Necmttn/ax/commit/b0d0bce2f8d2f7784815d85e49fbefb597e4087e))
* **timeline:** LLM-free session timeline service (highlights + segments + events) ([#160](https://github.com/Necmttn/ax/issues/160)) ([4ee78fd](https://github.com/Necmttn/ax/commit/4ee78fd5c32295e87c8003e8a305cde5c1e4d601))


### Bug Fixes

* speed up session inspect paging ([27142e6](https://github.com/Necmttn/ax/commit/27142e69f46104de3966fdb3ab6361aed7a039dd))
* **studio:** gate graph explorer ([3b1a81f](https://github.com/Necmttn/ax/commit/3b1a81f7c6d6e0c349820296410a9fe789773ae4))
* **studio:** URL-drive subagent selection in share viewer ([34e465b](https://github.com/Necmttn/ax/commit/34e465bef6e8679c3b02b3ae3961ce700d22c0f7))


### Performance

* cache workflow dashboard payload ([7855417](https://github.com/Necmttn/ax/commit/7855417c36995182028d367002d0841fdaf859f3))
* speed up session detail skills ([585a4b1](https://github.com/Necmttn/ax/commit/585a4b1b41bb8d7dde3e7d149f552f1040e219e3))

## [0.16.0](https://github.com/Necmttn/ax/compare/v0.15.0...v0.16.0) (2026-06-09)


### Features

* **share:** surface harness hooks in the shared transcript ([#153](https://github.com/Necmttn/ax/issues/153)) ([04036a1](https://github.com/Necmttn/ax/commit/04036a1eb0fbe3c728b61b22626f755914fc8496))
* **studio:** extract @ax/studio + standalone Electron desktop app ([#156](https://github.com/Necmttn/ax/issues/156)) ([a0025e8](https://github.com/Necmttn/ax/commit/a0025e8b6361a779a9ea70e2c601fce46515e44d))
* **studio:** unify sessions palette + share outcome header ([#157](https://github.com/Necmttn/ax/issues/157)) ([6b61251](https://github.com/Necmttn/ax/commit/6b61251338c1326df417c7827e63fe3501b89806))


### Performance

* **studio:** virtualize shared transcript paint via content-visibility ([#155](https://github.com/Necmttn/ax/issues/155)) ([1c495c4](https://github.com/Necmttn/ax/commit/1c495c44092bcf12e71568fbaa38812f7559a310))

## [0.15.0](https://github.com/Necmttn/ax/compare/v0.14.0...v0.15.0) (2026-06-08)


### Features

* **share:** export+render hook fires; bound export concurrency ([#152](https://github.com/Necmttn/ax/issues/152)) ([bacf96b](https://github.com/Necmttn/ax/commit/bacf96b816faedaa7b3bdd26074e0e195c9523a8))
* **share:** render tool arguments in synthesized tool turns ([#150](https://github.com/Necmttn/ax/issues/150)) ([0027b54](https://github.com/Necmttn/ax/commit/0027b54cd15d4ad41e50ab441ebc32b258f406f6))

## [0.14.0](https://github.com/Necmttn/ax/compare/v0.13.0...v0.14.0) (2026-06-08)


### Features

* **share:** multi-file gist bundles + progressive studio + per-turn pricing ([#147](https://github.com/Necmttn/ax/issues/147)) ([6aadd24](https://github.com/Necmttn/ax/commit/6aadd241b575560f512e27bab397f4f68609e21d))
* **studio:** dock the turn inspector under the cost rail, hover-driven ([#148](https://github.com/Necmttn/ax/issues/148)) ([af11a42](https://github.com/Necmttn/ax/commit/af11a42a82ae5ca25c34198d469a497de3ac31d7))

## [0.13.0](https://github.com/Necmttn/ax/compare/v0.12.1...v0.13.0) (2026-06-08)


### Features

* **share:** export subagent transcripts + price Claude sessions ([#145](https://github.com/Necmttn/ax/issues/145)) ([#146](https://github.com/Necmttn/ax/issues/146)) ([7b8d050](https://github.com/Necmttn/ax/commit/7b8d050031853e647b2b06500aa6d1b4879b2a43))


### Bug Fixes

* **ingest:** clear agent_event by primary id so index drift can't crash re-ingest ([#141](https://github.com/Necmttn/ax/issues/141)) ([1090c5f](https://github.com/Necmttn/ax/commit/1090c5f2616d57c2994539447cb0906e28c16470))

## [0.12.1](https://github.com/Necmttn/ax/compare/v0.12.0...v0.12.1) (2026-06-07)


### Bug Fixes

* **serve:** echo Allow-Private-Network so hosted studio can reach loopback daemon ([#138](https://github.com/Necmttn/ax/issues/138)) ([3f7eee1](https://github.com/Necmttn/ax/commit/3f7eee14248298f7aec6b63101a97cd034e5a1f0))

## [0.12.0](https://github.com/Necmttn/ax/compare/v0.11.0...v0.12.0) (2026-06-07)


### Features

* **canvas:** auto-focus detail on deep zoom + default to focus mode ([4980eca](https://github.com/Necmttn/ax/commit/4980eca4470a758e37203f332da1eaf43d0e92bc))
* **canvas:** inline session detail (in-place + focus), sub-row lanes, hover-prefetch ([62e7422](https://github.com/Necmttn/ax/commit/62e7422413d46ae6787fc4849e51b2cb6fb47680))
* **canvas:** progressive pill labels on zoom ([a379029](https://github.com/Necmttn/ax/commit/a379029e5d929149203f11d95e9a861160c002c6))
* **canvas:** raise time-axis zoom cap 80x -&gt; 2000x ([4511dd2](https://github.com/Necmttn/ax/commit/4511dd2504aab2b8d45bebdc6bcba7a3df6ce734))
* **canvas:** show detail card on hover (instant via prefetch + ~30ms summary) ([72dbe7b](https://github.com/Necmttn/ax/commit/72dbe7beb0536671ac9d415db6cc0570f4047bf2))
* **canvas:** swimlanes + subagent orchestration timeline ([f67a8f5](https://github.com/Necmttn/ax/commit/f67a8f5bb72f302d81cccfbafd8329267a688313))
* **canvas:** time-axis zoom/pan + 30x faster node query ([8fe9cc9](https://github.com/Necmttn/ax/commit/8fe9cc98f67f48af24b1ef21241ddd497a2cc505))
* **dashboard:** canvas size = context tokens + compaction epochs ([e073f71](https://github.com/Necmttn/ax/commit/e073f71c7d3615a227ea70645eb45b4ea989a18f))
* **dashboard:** session canvas - semantic-zoom lineage graph ([33abcef](https://github.com/Necmttn/ax/commit/33abcefde52419331b04cebcbd118777f59effee))


### Bug Fixes

* **canvas:** compaction query ts order, token M-formatting, dedupe boundaries ([15eb4eb](https://github.com/Necmttn/ax/commit/15eb4ebfe0731448e61ff1586eb6fe9894a5d6ba))


### Performance

* **canvas:** DB-only session-summary for detail card (20-58s -&gt; ~30ms) + gold bench ([f2ef307](https://github.com/Necmttn/ax/commit/f2ef307f35df867ef4aa55704566314c6937b133))

## [0.11.0](https://github.com/Necmttn/ax/compare/v0.10.0...v0.11.0) (2026-06-05)


### Features

* first-class compaction signal across harnesses ([#133](https://github.com/Necmttn/ax/issues/133)) ([c1d7a91](https://github.com/Necmttn/ax/commit/c1d7a912d014b6930fd9469ede9b464c47adae40))
* **ingest:** emit live progress deltas for codex/claude stages ([8b40ac5](https://github.com/Necmttn/ax/commit/8b40ac5c5fd443ff6784b101ab4611921a9c1087))
* migrate node:fs/path → @effect/platform (FileSystem/Path) ([bed3ecd](https://github.com/Necmttn/ax/commit/bed3ecda6df549ba6cefc1dd1e38a131f7ab0a65))
* **site:** Flue-style copy-prompt pill in hero, simplify install section ([c477a74](https://github.com/Necmttn/ax/commit/c477a74c1061197ecfe71e25601787ed420de23e))
* **site:** honest impact section on /teams ([09643c4](https://github.com/Necmttn/ax/commit/09643c45f810a004efce9c80f29f1e148d47e7a7))
* **site:** landing→teams upsell, teams copy trim, interventions fix ([2aecb23](https://github.com/Necmttn/ax/commit/2aecb2327caf75e7d5f96a4696a0530321be267b))
* **site:** reframe /teams from cost-savings to opportunity cost ([79813ee](https://github.com/Necmttn/ax/commit/79813ee31323417c930afb5ed5d6990e8ce09e0d))
* **site:** two A/B positioning pages for ax cloud team layer ([ed40e06](https://github.com/Necmttn/ax/commit/ed40e069ad3797f39736346a23e08172fc4fca75))
* **site:** unify page layouts, responsive header, and changelog freshness ([d72f3fb](https://github.com/Necmttn/ax/commit/d72f3fbfab782257cba545d4ba49dffbe4494deb))
* **skills:** exclude provider built-in tools from weighted ranking ([347e4ea](https://github.com/Necmttn/ax/commit/347e4ea3aa14b00bc352368386b50865ec65212e))


### Bug Fixes

* **cli:** install.ts await launchctl loads (Effect.promise); classifyNoFollow for symlink slots so a regular file doesn't abort uninstall (review fixes) [REVIEW-BLOCKER] ([8abfa5c](https://github.com/Necmttn/ax/commit/8abfa5c7c98979977ddaf8847f82e8679bc81111))
* **ingest:** canonicalize session.project off the repository edge ([21839ac](https://github.com/Necmttn/ax/commit/21839ac663daecc19b576c5e6628860aa6cd0558))
* **ingest:** claude reader -&gt; FileSystem streaming; vanished transcript skips instead of aborting run ([6854fc5](https://github.com/Necmttn/ax/commit/6854fc585b28b8fcfc9b8b526a82a9b2f697428f))
* **ingest:** codex mid-stream NotFound no longer silently skips partial writes; route production through streamCodexFile (review fixes) ([1dcad1c](https://github.com/Necmttn/ax/commit/1dcad1ce2fd9ad2378809d122c017a0ec841924a))
* **ingest:** codex reader -&gt; FileSystem streaming; vanished session skips; flush cadence preserved ([e9864bc](https://github.com/Necmttn/ax/commit/e9864bcec9a2dd07510cbc172a2e19e6e2980f9c))
* **ingest:** preserve no-follow symlink semantics in directory walks (classifyNoFollow); follow symlinks only where the old code did ([7a55ce1](https://github.com/Necmttn/ax/commit/7a55ce11233371e773e9510fe8e8afaed68b3d64))
* **progress:** suppress noise-inflated speed for sub-100ms stages ([f45f9ef](https://github.com/Necmttn/ax/commit/f45f9ef83be6ad47f99a4dae402ebd3dd503bd1d))
* **schema:** idempotent schema apply - IF NOT EXISTS on all indexes ([ad62420](https://github.com/Necmttn/ax/commit/ad624202f0de7991ce5d91af365356cf2af8d457))
* **site:** refine card hover, drop accent left-bar + hard rings ([16768e7](https://github.com/Necmttn/ax/commit/16768e7d5e87d02a25a8047c5e33a9c83c29e830))
* **site:** rewrite open-source body, correct footer license to AGPL-3.0 ([bfd0ec2](https://github.com/Necmttn/ax/commit/bfd0ec206a9fd2f64c2be8e999d94be46aa87794))
* **skills:** role.weight NONE crash + weighted-query per-edge deref hang ([e7b82c5](https://github.com/Necmttn/ax/commit/e7b82c563e63f546ef2e463b9000685fa24235aa))

## [0.10.0](https://github.com/Necmttn/ax/compare/v0.9.0...v0.10.0) (2026-06-03)


### Features

* **cli:** ascii wordmark landing on bare `ax` ([ef46e02](https://github.com/Necmttn/ax/commit/ef46e0241291623723ea164e048e3d17ecc5b37e))
* **onboarding:** agent-instructions prompt + labeling loop (effect.solutions-style) ([9d06018](https://github.com/Necmttn/ax/commit/9d0601800c45293f7b469be0a895da211f19884e))
* **setup:** `ax setup` command (skills + first ingest + doctor) ([b00f362](https://github.com/Necmttn/ax/commit/b00f36299e711f6bd490b1e3b8c4ae01fe7b8117))
* **site:** cinematic demo — score-climb arc + multi-harness retro terminal ([9357912](https://github.com/Necmttn/ax/commit/9357912ccb054e2a2dd1d5f10a7d890145508cf0))
* **site:** hover slows + holds the retro terminal (instead of pausing) ([a0d769f](https://github.com/Necmttn/ax/commit/a0d769f0165cddfc7c9cfe19f48b301faa0d97ea))
* **site:** typewriter the user lines in the retro terminal ([2edb7d9](https://github.com/Necmttn/ax/commit/2edb7d9965425acc8f86565147adcc0478a3ce2d))


### Bug Fixes

* **hooks:** align ax hooks config table columns ([547c840](https://github.com/Necmttn/ax/commit/547c840c5034866886200933bb285cc04960805e))
* **site:** unify CLI name to `ax` across landing demos ([9dbc4f9](https://github.com/Necmttn/ax/commit/9dbc4f947dc79a8e026353eeac35f8fd843fdc23))

## [0.9.0](https://github.com/Necmttn/ax/compare/v0.8.0...v0.9.0) (2026-06-03)


### Features

* **agents:** repo-qualified project scope (project:&lt;repo&gt;) ([eb81d57](https://github.com/Necmttn/ax/commit/eb81d570499b8e9238ad55e1119ec81131ec4511))
* **cli:** hide agent-scoped skills in `ax skills unused` ([51e8596](https://github.com/Necmttn/ax/commit/51e8596d5641aa80a01516c142cdf56f928c041a))
* **config-core:** Wave 0 shared spine for config front door ([2b1536b](https://github.com/Necmttn/ax/commit/2b1536b7ad6ef656fbcce20059973d20035cd24b))
* **config-front-door:** CLI wiring for hooks/skills/agents config + smoke fixes ([9123579](https://github.com/Necmttn/ax/commit/91235795d9a0e8b404bad0b52ba450bedd781c70))
* **config-front-door:** graph integration (schema, agentDefStage, reconcile filters) ([a21e747](https://github.com/Necmttn/ax/commit/a21e747485e3614be016ca0f67bf1fd65d3fd0eb))
* **config-front-door:** Wave 1 domain modules (hooks, skills, agents) ([161aece](https://github.com/Necmttn/ax/commit/161aecedb3a1e48cc6c930210360cc4edb3820be))
* **skills:** distinguish out-of-scope rows from orphans in config view ([5ab251a](https://github.com/Necmttn/ax/commit/5ab251a5d7ac616148c8c4c20dfbba270dd08286))


### Bug Fixes

* **hooks+agents:** codex identity/routing, ambiguous-id, transactional toggle ([0b750fa](https://github.com/Necmttn/ax/commit/0b750fa4b9600f70ba14f059fe2f56ebbe90f1a5))
* **hooks:** preserve ax marker on edit so hook id stays stable ([0b8c11f](https://github.com/Necmttn/ax/commit/0b8c11fa3d9fa819f8469c99f4e2e30473f2050b))
* **queries:** mirror agent_def in SCHEMA_TABLES ([7ea2918](https://github.com/Necmttn/ax/commit/7ea2918ae507961582900effa017e7e7de341d58))
* **reconcile:** scope-partition so reconcile only touches owned scopes ([1bae738](https://github.com/Necmttn/ax/commit/1bae738d0ef6a9eb21b73d46d978f47835c1245b))


### Performance

* **config:** run independent reads concurrently in readAll* ([2892676](https://github.com/Necmttn/ax/commit/2892676c8e96c146f3828d814193eb9b14326837))

## [0.8.0](https://github.com/Necmttn/ax/compare/v0.7.0...v0.8.0) (2026-06-03)


### Features

* add Discord community link across site, README, and CLI ([31bd003](https://github.com/Necmttn/ax/commit/31bd0034e1c9bda7eb77018022fa8e203b8b3921))
* **classifiers:** export transcript label review queue ([1f7b64c](https://github.com/Necmttn/ax/commit/1f7b64c1beb9aabec7de38856d48f80a55e95475))
* **classifiers:** expose transcript label mining cli ([a6797fe](https://github.com/Necmttn/ax/commit/a6797fe99e9a5db563f2986e2413198806698d85))
* **classifiers:** gate transcript label mining iterations ([498c867](https://github.com/Necmttn/ax/commit/498c867010c20848284ae8dd120ea379ceb57af2))
* **classifiers:** mine transcript label candidates ([1b8d4fd](https://github.com/Necmttn/ax/commit/1b8d4fd6b73b61d211a93c33d4eb10a9a264badf))
* **classifiers:** prioritize transcript label review with embeddings ([54ce534](https://github.com/Necmttn/ax/commit/54ce53468901819332bd743402b7d99a379312d0))
* **classifiers:** project reviewed transcript labels to graph ([82d06d5](https://github.com/Necmttn/ax/commit/82d06d5d9b7af7c5f9f0c26284861c6b6855518c))
* **cli:** ax sessions compare — side-by-side run comparison (P0) ([1f18409](https://github.com/Necmttn/ax/commit/1f18409b229c967ac1d108fa13db999319258fb2))
* **cli:** move star/feedback nudge from skill into the CLI ([2be7867](https://github.com/Necmttn/ax/commit/2be78672abe651cdcbad4b5b4e755076fc003bd6))
* **cli:** only show the star nudge after value commands ([68c0aa3](https://github.com/Necmttn/ax/commit/68c0aa39cff460fe0e817699f8bd33b9273c9c69))
* **cli:** per-turn appendix for ax sessions compare (P1) ([47ac854](https://github.com/Necmttn/ax/commit/47ac85406b9ceb8c4ef0ab81772ca6dc110aeb80))
* **dashboard:** live ingest view over Durable Streams (catch-up + resume + animate) ([09be382](https://github.com/Necmttn/ax/commit/09be38217245d1ce2e873b45d81422600df7c941))
* **dashboard:** session compare swimlane view (P2) ([63725de](https://github.com/Necmttn/ax/commit/63725de101d68a200b4061d4cd7962ca58bd86ba))
* **dev:** `ax-dev` global command — source build on a disposable isolated DB ([07006a2](https://github.com/Necmttn/ax/commit/07006a2a4f1d1e42a2ebe756ce2df73f35997ca1))
* **ingest:** force CLI progress on non-TTY via AX_PROGRESS=on / --progress ([090f86b](https://github.com/Necmttn/ax/commit/090f86bbab93560f704b5e8cc49966d2b87d7dab))
* **ingest:** IngestStreamEvent payload mapped from live-trace spans ([d746bf0](https://github.com/Necmttn/ax/commit/d746bf04072633dda4e9d70a02ea861b8ada9645))
* **ingest:** render ingest progress through the OpenTUI/React renderer on a TTY ([ecf3012](https://github.com/Necmttn/ax/commit/ecf30125e3dc023f7e4b78a132a7fb0e7cbe41d9))
* **ingest:** surface per-stage row counts in progress (rows/speed columns) ([3c33f99](https://github.com/Necmttn/ax/commit/3c33f99d72f82977195568b0605bb2a3ffc004c4))
* **mcp:** add stdio MCP server scaffold with recall tool ([6b7b650](https://github.com/Necmttn/ax/commit/6b7b650b7db7ddeb0446985ebfe4ccf06fcade88))
* **mcp:** ax mcp — stdio MCP server exposing read-only graph queries ([296bb7d](https://github.com/Necmttn/ax/commit/296bb7d8c945e4bc8736811908b6fdb8cef5b72f))
* **mcp:** drop inert scope param from recall tool ([eaa2284](https://github.com/Necmttn/ax/commit/eaa228476e3c59332a8c05490e5a0a849e08784a))
* **mcp:** wire remaining read-only query tools ([e34d9f1](https://github.com/Necmttn/ax/commit/e34d9f1d5b6128916261f3119c0a9885c3997b1a))
* **serve:** Durable Streams backing for IngestStreamBus + mountable handler ([b8e25cb](https://github.com/Necmttn/ax/commit/b8e25cb61dfb5223cfaa1275a38146f58e9d74f1))
* **serve:** in-process ingest workflow runner publishing to the stream bus ([f13644e](https://github.com/Necmttn/ax/commit/f13644e4769ccae4304a47dd162d8433485bbbc7))
* **serve:** IngestStreamBus seam + in-memory impl ([dacfc66](https://github.com/Necmttn/ax/commit/dacfc661047117f842a02ff02e92a25371ebdb29))
* **serve:** POST /api/ingest triggers in-process ingest + mounts the run stream ([3eb654b](https://github.com/Necmttn/ax/commit/3eb654bef2b754a928adfe48a3c9a625874980c4))
* **skill:** ax-repo — star/issue/fork via gh + proactive star nudge ([93ca390](https://github.com/Necmttn/ax/commit/93ca3905fcc5077d3b9ed57f4ed022aae7cf1f00))
* **version:** show git provenance in `ax -v` (tag/sha/dirty + branch) ([376d1d9](https://github.com/Necmttn/ax/commit/376d1d93368930abfc6353602e4279dd5bcfb643))


### Bug Fixes

* **classifiers:** drop dispatch/affirmation noise, fix projection record ids ([ff6113c](https://github.com/Necmttn/ax/commit/ff6113c5b8f954845aa289e41be3ada0f18de484))
* **classifiers:** mine organic user turns only, broaden via intent_kind ([330ed1f](https://github.com/Necmttn/ax/commit/330ed1fcd3a069a0fb86036c8230556f2a12df95))
* **classifiers:** SCHEMA_TABLES mirror + classifier package operations tests (green main) ([35dd180](https://github.com/Necmttn/ax/commit/35dd180ea08648064b1fae6865b3f883e567f4fe))
* **dashboard:** recover from a stale live-ingest stream URL instead of retrying forever ([1b2fddb](https://github.com/Necmttn/ax/commit/1b2fddb2587e88d2e72c05f14295f73e4eff5fce))
* **ingest:** don't render the trace root span as a progress row ([a58a3ce](https://github.com/Necmttn/ax/commit/a58a3ce6b503393f3b00508085016783c7296ab3))
* **ingest:** idempotent re-ingest of agent_event (clear session events before re-insert) ([1dc3c47](https://github.com/Necmttn/ax/commit/1dc3c47b6073ed7935f1d2bae6c049b4761a3cc5))
* **ingest:** wire the progress/debug transport beneath TraceSink so events surface ([74a8b0e](https://github.com/Necmttn/ax/commit/74a8b0e3e5a608f6621e32cba415f89aa17c5fcb))
* **queries:** mirror ingest_file_state in SCHEMA_TABLES ([095d875](https://github.com/Necmttn/ax/commit/095d8758d8fa6375fa742bf163b16d6fc9a74e55))
* **serve:** degrade gracefully when the Durable Streams sidecar is unavailable (compiled binary) ([fa3cf80](https://github.com/Necmttn/ax/commit/fa3cf80331117802e0c749518c1a39e90471d964))
* **serve:** lazy-import @durable-streams/server so the compiled axctl binary boots ([8482cc3](https://github.com/Necmttn/ax/commit/8482cc31811ef707a4b9ec3026d279f95a9e921c))


### Performance

* **ingest:** attempt 005 chunkSize 250→1000 REVERTED (warm 23s vs 22s, no win) ([0429fcf](https://github.com/Necmttn/ax/commit/0429fcf22566f869f48e4d360f63efd2e59c5f21))
* **ingest:** claude skip-unchanged source (warm 13s vs 22s) ([1e6374c](https://github.com/Necmttn/ax/commit/1e6374cc9b8361db91ba3bfe8127a3aa0e35c768))
* **ingest:** closure skip-unchanged (warm 6s vs 8s) ([32f3092](https://github.com/Necmttn/ax/commit/32f30923be37b891f4d3b401998799b34a06806b))
* **ingest:** git skip-unchanged (warm 8s vs 13s) ([5e96036](https://github.com/Necmttn/ax/commit/5e960361a7f18cf5aab10be121779140b906964e))
* **ingest:** PIPELINE_CONCURRENCY 2→4 (warm 22s vs 24s) ([9d61383](https://github.com/Necmttn/ax/commit/9d613830425998183824fb2a32200f3872be9111))
* **ingest:** pricing skip-unchanged via statement-fingerprint (warm 5s vs 6s) ([f627cef](https://github.com/Necmttn/ax/commit/f627cef05c4d74783a11880f29d6df61a72106f7))
* **ingest:** subagents skip-unchanged (warm 3s vs 5s) ([32f21dd](https://github.com/Necmttn/ax/commit/32f21ddaaedaecda05963a2b11a1c4068195264a))
* **ingest:** turn-analysis incremental (warm 24s vs 27s) ([61cd25c](https://github.com/Necmttn/ax/commit/61cd25cfc31d8a0e2f8ecb340aea1cac4b274678))
* **ingest:** turn-content-blocks incremental via content_hash (warm 27s vs 50s) ([a00e661](https://github.com/Necmttn/ax/commit/a00e661c3420e992aa1d4edf7a293962d01a17cc))

## [0.7.0](https://github.com/Necmttn/ax/compare/v0.6.2...v0.7.0) (2026-06-01)


### Features

* **ingest:** animated step progress for interactive ax ingest ([1180a15](https://github.com/Necmttn/ax/commit/1180a1569526eb4157bc6704eb0c8b3cc0da4850))

## [0.6.2](https://github.com/Necmttn/ax/compare/v0.6.1...v0.6.2) (2026-06-01)


### Bug Fixes

* **ingest:** self-heal reaction_event conflicts on incremental --since ([df4c1ad](https://github.com/Necmttn/ax/commit/df4c1ad18d04103f59fc182d7434b8d6770232c8))

## [0.6.1](https://github.com/Necmttn/ax/compare/v0.6.0...v0.6.1) (2026-06-01)


### Bug Fixes

* **db:** jitter the transaction-conflict retry to break concurrent-ingest lockstep ([d3aa6be](https://github.com/Necmttn/ax/commit/d3aa6be028581fc3af9419d89b4845f051377154))

## [0.6.0](https://github.com/Necmttn/ax/compare/v0.5.0...v0.6.0) (2026-06-01)


### Features

* **classifiers:** add boundary miss review gate ([74684f8](https://github.com/Necmttn/ax/commit/74684f8d8e58217cbb9454458c8ae0eb516183d6))
* **classifiers:** add boundary replay summary cli ([80a8cc0](https://github.com/Necmttn/ax/commit/80a8cc0732ab0055c0c6c563793916cb580071a8))
* **classifiers:** add coverage apply audit ids ([8bc8f43](https://github.com/Necmttn/ax/commit/8bc8f439af1df0dde9a4be876b095fd13a8c8fb5))
* **classifiers:** add coverage apply audit rows ([4d98a32](https://github.com/Necmttn/ax/commit/4d98a32aaa57de5218ae2558233b5fedc7eb54ba))
* **classifiers:** add coverage blocker details ([a511c8c](https://github.com/Necmttn/ax/commit/a511c8cf8b562e6b5b9578202fbf08444b90919f))
* **classifiers:** add coverage blocker remediations ([f324090](https://github.com/Necmttn/ax/commit/f3240902469b093c007f70615ec95945b1e34e45))
* **classifiers:** add coverage brief remediations ([d68e268](https://github.com/Necmttn/ax/commit/d68e2680116a371552a18cd1010dc9d85813a970))
* **classifiers:** add coverage recheck command ([f2011e7](https://github.com/Necmttn/ax/commit/f2011e78b29092dd64207a8e7f174e889b9259c1))
* **classifiers:** add coverage review briefs ([68e19dd](https://github.com/Necmttn/ax/commit/68e19dd930c0717d1653e0707ce05f0686db0b57))
* **classifiers:** add coverage review commands ([692ac34](https://github.com/Necmttn/ax/commit/692ac34cb95eb7f255fd3f9dfda66be08bb832b2))
* **classifiers:** add coverage review next actions ([7c3f847](https://github.com/Necmttn/ax/commit/7c3f847a4f83610ffa72a31f5dcd0743e351970b))
* **classifiers:** add helper fixture failure gate ([889c51b](https://github.com/Necmttn/ax/commit/889c51bd04a1779b59bc6e28344f5217ed3111fc))
* **classifiers:** add lifecycle routing items ([ad54950](https://github.com/Necmttn/ax/commit/ad54950f8dae642f0179824f2fc2180a8bb6d66c))
* **classifiers:** add lifecycle routing summary ([04a0974](https://github.com/Necmttn/ax/commit/04a09742cf11dcb3941332e52f513db772bf6d41))
* **classifiers:** add production next action ([81f0d5c](https://github.com/Necmttn/ax/commit/81f0d5c56be6df90aa753bae0013b41c0f7fb4f3))
* **classifiers:** add query suggestion routing service helper ([5b6a1e1](https://github.com/Necmttn/ax/commit/5b6a1e10cf8d4c177963fe52f4d1e108263d6388))
* **classifiers:** add review pipeline file verifier ([b4ac14a](https://github.com/Necmttn/ax/commit/b4ac14a605601130a7e6ab5ff9efd5e426f1ec3e))
* **classifiers:** add review pipeline lifecycle report ([189a813](https://github.com/Necmttn/ax/commit/189a813cd98c4a121569dda2678c2f1c34365f2e))
* **classifiers:** add review pipeline service helper ([c0cbf98](https://github.com/Necmttn/ax/commit/c0cbf981bae23e6c4de57422a35da0bb69d71f10))
* **classifiers:** add review provenance fields ([5c69e1a](https://github.com/Necmttn/ax/commit/5c69e1a737fd0de8fb6491c3d873e60676de4f0e))
* **classifiers:** add review repair status ([beca3b6](https://github.com/Necmttn/ax/commit/beca3b6298c6cb73da3c1104af863ec738aa6ab8))
* **classifiers:** append accepted fixture rows ([efbf179](https://github.com/Necmttn/ax/commit/efbf17981dad13ad598f605ba920682e4ed4787c))
* **classifiers:** attach batch review lifecycle ([12eec1f](https://github.com/Necmttn/ax/commit/12eec1f454e18d01f808c8c93845f3620dd59ca6))
* **classifiers:** attach helper fact explanations ([bca5938](https://github.com/Necmttn/ax/commit/bca59383612acff84fbffba984d92b869ecbe078))
* **classifiers:** attach persisted review context ([c9f59e4](https://github.com/Necmttn/ax/commit/c9f59e47e75789ecd4df1276118eb20cecee33ff))
* **classifiers:** batch guidance decisions by topic ([22ecde8](https://github.com/Necmttn/ax/commit/22ecde8e824cde4c5b0e5fe2e6850f0f04179f39))
* **classifiers:** bundle suggested graph query ([b8ae9b5](https://github.com/Necmttn/ax/commit/b8ae9b51ec0b9c6f71b71fb36f8bd68c30807146))
* **classifiers:** catch reviewed workflow corrections ([71549bb](https://github.com/Necmttn/ax/commit/71549bb63b62e84a7ec90c8783de38656d9be9d6))
* **classifiers:** classify review provenance ([96439f4](https://github.com/Necmttn/ax/commit/96439f49d9a06aad448d7b0379480b55dc6a4d9b))
* **classifiers:** complete review handoff command ([632a312](https://github.com/Necmttn/ax/commit/632a31234107928eb8d4cec68aaed296eb973a44))
* **classifiers:** complete route handoff inspection ([16da1f9](https://github.com/Necmttn/ax/commit/16da1f9ee2f0388969730f32997935b785815640))
* **classifiers:** consolidate review issue scope summaries ([dc5e7d2](https://github.com/Necmttn/ax/commit/dc5e7d244b5aaf7dddd65e85bae7dce9c911e35f))
* **classifiers:** count pending review progress ([9a9bdad](https://github.com/Necmttn/ax/commit/9a9bdad635541ecacf6e085d0d5ebf8312818ae1))
* **classifiers:** count pending review routes ([c0d7040](https://github.com/Necmttn/ax/commit/c0d7040ad0fa6f0ed52d8d72551b0b23cd008211))
* **classifiers:** count review issue candidates ([8634e1d](https://github.com/Necmttn/ax/commit/8634e1deea7287a8237655fecf5c9ba4dc6e84da))
* **classifiers:** count review issue fixtures ([582cd91](https://github.com/Necmttn/ax/commit/582cd91b32ec7fcb4d31db7971b0ef3a0758c2a5))
* **classifiers:** count review provenance gaps ([3505420](https://github.com/Necmttn/ax/commit/35054207b3fd47d287676165defb29ec6fcaed9b))
* **classifiers:** count scoped review issue workload ([fcf7619](https://github.com/Necmttn/ax/commit/fcf7619cd63f9124c56fe2e44f794a854161d0ea))
* **classifiers:** decide guidance after harness evidence ([842de7a](https://github.com/Necmttn/ax/commit/842de7a4702391e6023c41971b3093d449d26339))
* **classifiers:** dry-run harness proposals from review facts ([b23bcdd](https://github.com/Necmttn/ax/commit/b23bcdde7e2fc6487c7ea493e0ae1a54c39ff8cc))
* **classifiers:** emit batch review handoff ([100921e](https://github.com/Necmttn/ax/commit/100921ed86f30cc5c24c5e2928cb27a9fa1ac2eb))
* **classifiers:** emit batch review tasks ([cd690ae](https://github.com/Necmttn/ax/commit/cd690aea5be564ef9d8f6f9b65717f55a4d2d46f))
* **classifiers:** emit review coverage fixtures ([59adacf](https://github.com/Necmttn/ax/commit/59adacfedcccf15d4cc845333ce6453ce131ac4a))
* **classifiers:** emit review task commands ([82fe636](https://github.com/Necmttn/ax/commit/82fe636d058369255dfea3c715773031bc3e4b8d))
* **classifiers:** enrich coverage review briefs ([3f71886](https://github.com/Necmttn/ax/commit/3f718867d04ead5acd42adbf6e332c3a3e29c7cd))
* **classifiers:** execute lifecycle routes ([39d1189](https://github.com/Necmttn/ax/commit/39d11897d156a68b7b1d62f95d14e7b2ef595284))
* **classifiers:** explain helper graph facts ([2530699](https://github.com/Necmttn/ax/commit/2530699798ccead17c1c68e19629951b1915726e))
* **classifiers:** export accepted fixture followups ([462c57c](https://github.com/Necmttn/ax/commit/462c57cf42b488cc5a5ae6821929f17a6351d9f8))
* **classifiers:** expose actionable query suggestion flag ([eb29bf5](https://github.com/Necmttn/ax/commit/eb29bf5b9937efb2b13e8dbed458da6edf2d10db))
* **classifiers:** expose available lifecycle values ([8d921f6](https://github.com/Necmttn/ax/commit/8d921f63d299f98d9efa9d539b883dbe5c59fb36))
* **classifiers:** expose blocking routing floors ([041a070](https://github.com/Necmttn/ax/commit/041a07087030c7274f618630ce1c7da4f7d434b6))
* **classifiers:** expose boundary replay posture service ([997676f](https://github.com/Necmttn/ax/commit/997676fd2ebec54ac9676f2b1c984006b5f260c2))
* **classifiers:** expose coverage apply blockers ([a826ba2](https://github.com/Necmttn/ax/commit/a826ba2a13c66ca85cb1d98f684357d5bf4df736))
* **classifiers:** expose coverage can apply gate ([01d56c1](https://github.com/Necmttn/ax/commit/01d56c164ec1b6da134c52fe6b9f45ec25f12855))
* **classifiers:** expose coverage review next action ([63f872e](https://github.com/Necmttn/ax/commit/63f872e3ce6c90edf6802267c781496322d49101))
* **classifiers:** expose graph query match status ([b5f3b22](https://github.com/Necmttn/ax/commit/b5f3b223c1a0c7606d8ecbeb599a4c7e1dd5780a))
* **classifiers:** expose graph query result counts ([3f5b15d](https://github.com/Necmttn/ax/commit/3f5b15d62b2575450b23276bd6cca6b413492f65))
* **classifiers:** expose graph query result kinds ([15edcc1](https://github.com/Necmttn/ax/commit/15edcc1387eb5ea28049476f156fd0fae2b9b3aa))
* **classifiers:** expose graph query routing guidance ([011637d](https://github.com/Necmttn/ax/commit/011637dbd6bc910e2b1af3a91d69f8753cf1e805))
* **classifiers:** expose pending review artifact status ([f885a40](https://github.com/Necmttn/ax/commit/f885a40c25f8a1b2a2d598ed6674f3e887ddc11f))
* **classifiers:** expose pending review artifacts ([48dfa26](https://github.com/Necmttn/ax/commit/48dfa2664ae3541f7ab7046370bf7de280cd55a2))
* **classifiers:** expose pending review progress ([400869f](https://github.com/Necmttn/ax/commit/400869f04c42f891b134d074e1748b406265e3ac))
* **classifiers:** expose pending review progress status ([dbaaa6d](https://github.com/Necmttn/ax/commit/dbaaa6db8fedbceeac94b3b526508fdebf955575))
* **classifiers:** expose pending review queue status ([fc121e4](https://github.com/Necmttn/ax/commit/fc121e4d4212dac123fe1b278fb78153d8e76b7a))
* **classifiers:** expose pending review service helper ([1e7442d](https://github.com/Necmttn/ax/commit/1e7442d3aaf13fc0950cadc3567193e5787a2c2c))
* **classifiers:** expose pipeline command executable gate ([6887c15](https://github.com/Necmttn/ax/commit/6887c155a686adbc4d12ff10c29345a94124b2c5))
* **classifiers:** expose pipeline command next action ([64f9925](https://github.com/Necmttn/ax/commit/64f99254be904d69df76bd2d31c5695e7e9284ca))
* **classifiers:** expose pipeline output next action ([b22959e](https://github.com/Necmttn/ax/commit/b22959e217ba3e48a2f28dc088db05b37ae16f6f))
* **classifiers:** expose production apply argv ([db1fdba](https://github.com/Necmttn/ax/commit/db1fdbad8017d544715538540a60e3da621e3f66))
* **classifiers:** expose production apply command ([f2554c8](https://github.com/Necmttn/ax/commit/f2554c8cd9e9307c22662fdd3674717d9522d261))
* **classifiers:** expose provenance stamp argv ([aeacd1f](https://github.com/Necmttn/ax/commit/aeacd1f5b9aee9694922b26499cb6a0eff9fa8aa))
* **classifiers:** expose provenance stamp command ([04effe7](https://github.com/Necmttn/ax/commit/04effe79b7c473495178453addda076083ad8202))
* **classifiers:** expose query suggestion change counts ([ccf73aa](https://github.com/Necmttn/ax/commit/ccf73aa496219be54bc68e8a045de1728ce239e1))
* **classifiers:** expose query suggestion change status ([cd61372](https://github.com/Necmttn/ax/commit/cd61372e9fcb3743bd957e10615f0e13e943dfb6))
* **classifiers:** expose query suggestion filter changes ([d31ceaa](https://github.com/Necmttn/ax/commit/d31ceaa7412d20c34a7f5de71c2969b613f9cdc0))
* **classifiers:** expose query suggestion filter names ([b911fc5](https://github.com/Necmttn/ax/commit/b911fc558726a74820a5a886d4865fafd7db8e9b))
* **classifiers:** expose query suggestion provenance ([9fad810](https://github.com/Necmttn/ax/commit/9fad810599cff33eeb7a92a2b36ea990e6cc5fcd))
* **classifiers:** expose query suggestion relaxed filters ([2b8f270](https://github.com/Necmttn/ax/commit/2b8f27070d4f8685cbba583446ff2b849596cfa3))
* **classifiers:** expose query suggestion repair action ([68fe549](https://github.com/Necmttn/ax/commit/68fe549a022353df857ab78276fb6bb639051494))
* **classifiers:** expose query suggestion repair argv ([cf39797](https://github.com/Necmttn/ax/commit/cf397970fa82da43dbb804d1b7d340ab2cf730b9))
* **classifiers:** expose query suggestion repair blockers ([53cf74b](https://github.com/Necmttn/ax/commit/53cf74b01e41351d8920c9ce7a4388f4cbf1342b))
* **classifiers:** expose query suggestion repair command kind ([103cb84](https://github.com/Necmttn/ax/commit/103cb84d67832fa18fa0a286df51fa4e94e55bea))
* **classifiers:** expose query suggestion repair executable flag ([d149e2b](https://github.com/Necmttn/ax/commit/d149e2b1fb9566f618380e30c1c3f9ea2cfb1a81))
* **classifiers:** expose query suggestion repair execution status ([bce10c2](https://github.com/Necmttn/ax/commit/bce10c231739b4bd32dc45c65e93ec37b927aac9))
* **classifiers:** expose query suggestion repair input requirements ([dc59684](https://github.com/Necmttn/ax/commit/dc59684989cd5f69e191923a72bf0039269b88ed))
* **classifiers:** expose query suggestion repair query ([92feb63](https://github.com/Necmttn/ax/commit/92feb63c103aa0fe362ffb6707058838ea8bcec5))
* **classifiers:** expose query suggestion repair remediation ([aa7c758](https://github.com/Necmttn/ax/commit/aa7c758dc865bf1690cf00b858e4d17a812fbf66))
* **classifiers:** expose query suggestion repair status ([8bec6b1](https://github.com/Necmttn/ax/commit/8bec6b1d7c10d7188277bf691eccef5300d711e7))
* **classifiers:** expose query suggestion repair verifiability ([c414111](https://github.com/Necmttn/ax/commit/c414111102e937a180c603bb57437dce84ed1b32))
* **classifiers:** expose query suggestion repair verification action ([0b13b0c](https://github.com/Necmttn/ax/commit/0b13b0c0ec5289db6d23616d6df23fdead1be01f))
* **classifiers:** expose query suggestion repair verification argv ([95c53c1](https://github.com/Necmttn/ax/commit/95c53c14fc0545be234513b1987dca3b101024c8))
* **classifiers:** expose query suggestion repair verification blockers ([8bf271f](https://github.com/Necmttn/ax/commit/8bf271fce8a304dbc8ade259b410387895dfe578))
* **classifiers:** expose query suggestion repair verification command kind ([53d5ac3](https://github.com/Necmttn/ax/commit/53d5ac3531ab773f82b6ff543cdc26d991d6fc91))
* **classifiers:** expose query suggestion repair verification executability ([eca3331](https://github.com/Necmttn/ax/commit/eca33314dc0565fd528e82b1cc87c7ddf103a9ef))
* **classifiers:** expose query suggestion repair verification execution status ([59c1397](https://github.com/Necmttn/ax/commit/59c139767a7d32b51604b83c2dd1f7da890bb414))
* **classifiers:** expose query suggestion repair verification expectations ([ba90774](https://github.com/Necmttn/ax/commit/ba90774d0ce0f5449302df41d051be173eecb840))
* **classifiers:** expose query suggestion repair verification expectations ([9cb8b0b](https://github.com/Necmttn/ax/commit/9cb8b0bad07b631167d2aefcc6e2bba57de9c3e5))
* **classifiers:** expose query suggestion repair verification inputs ([9d992de](https://github.com/Necmttn/ax/commit/9d992def4fd9e10e3f1a2d61c6c78262e3449149))
* **classifiers:** expose query suggestion repair verification query ([9f3f78f](https://github.com/Necmttn/ax/commit/9f3f78fff7a95c791c600c24eeea1fc41d0eff15))
* **classifiers:** expose query suggestion repair verification remediation ([efe74e2](https://github.com/Necmttn/ax/commit/efe74e277430866af5fa0688b24580fcdde4ea84))
* **classifiers:** expose query suggestion repair verification status ([91ce08c](https://github.com/Necmttn/ax/commit/91ce08cbfd2d993437863ef39dcac5fcdba5f730))
* **classifiers:** expose query suggestion routing in graph cli ([aef696b](https://github.com/Necmttn/ax/commit/aef696bc4b4daf1d05283ebe56df579ee4a13c76))
* **classifiers:** expose recommended review commands ([d978380](https://github.com/Necmttn/ax/commit/d978380aa07ceb0a7af463897edd98f71aa25b95))
* **classifiers:** expose recommended routing argv ([3e14199](https://github.com/Necmttn/ax/commit/3e141992ad233276347e14adc73713fb4de29a4f))
* **classifiers:** expose recommended routing query ([11d42c5](https://github.com/Necmttn/ax/commit/11d42c5fb617624a77db4061d929b17f9976c87c))
* **classifiers:** expose review action bindings ([5c30a69](https://github.com/Necmttn/ax/commit/5c30a69e2a48662da2381459f5189e2500a054eb))
* **classifiers:** expose review action outputs ([36357d2](https://github.com/Necmttn/ax/commit/36357d294bd3750cfe7561855e57ca62d6da56ab))
* **classifiers:** expose review action safety ([04e704c](https://github.com/Necmttn/ax/commit/04e704c9628b8419cfac2a9fadde0e23e29c2547))
* **classifiers:** expose review issue repair command ([f7fcbee](https://github.com/Necmttn/ax/commit/f7fcbeeeaa8cb34b27f5af05227cf90917ed7251))
* **classifiers:** expose review issue rows ([ea42841](https://github.com/Necmttn/ax/commit/ea42841f84ebff20e3d84aad029e6ad9ff29c453))
* **classifiers:** expose review output checks ([90b59a6](https://github.com/Necmttn/ax/commit/90b59a6893c9b519c90dcc1505e7feb0d69bbbd0))
* **classifiers:** expose review pipeline argv ([1319edd](https://github.com/Necmttn/ax/commit/1319edd0ddf7bacc861d4407ad673c0427d7ac63))
* **classifiers:** expose review pipeline artifacts ([c7a30f1](https://github.com/Necmttn/ax/commit/c7a30f14194de89b030480f6923f3fcba7a74478))
* **classifiers:** expose review pipeline binding indexes ([a0519aa](https://github.com/Necmttn/ax/commit/a0519aa2b88a1b6624d05cdfba6a695c803383b8))
* **classifiers:** expose review pipeline bindings ([df30770](https://github.com/Necmttn/ax/commit/df30770d87f95d634d366606da8721e5c54a6675))
* **classifiers:** expose review pipeline blockers ([afaad16](https://github.com/Necmttn/ax/commit/afaad16f03d0668e7d49acd61fa865637c7b1fe5))
* **classifiers:** expose review pipeline command ([1cdcd93](https://github.com/Necmttn/ax/commit/1cdcd93ab091682cd332a52017b92cba9a8977ee))
* **classifiers:** expose review pipeline command kind ([e8a382c](https://github.com/Necmttn/ax/commit/e8a382ce54000afe81f16ae2efaf92858e3f00a7))
* **classifiers:** expose review pipeline command status ([4ada725](https://github.com/Necmttn/ax/commit/4ada72531041d426e4af7f5582a82a78d6dd2f1e))
* **classifiers:** expose review pipeline inputs ([b08f382](https://github.com/Necmttn/ax/commit/b08f382d2144db6f11e4931073cafa65ebc1431b))
* **classifiers:** expose review pipeline lifecycle cli ([f112df9](https://github.com/Necmttn/ax/commit/f112df914112d46b2b76960efde41d7faa8c8fe4))
* **classifiers:** expose review pipeline output checks ([d027fd9](https://github.com/Necmttn/ax/commit/d027fd9fa3b8a421426aba2bc3f62227920cfbfa))
* **classifiers:** expose review pipeline output indexes ([15f5a37](https://github.com/Necmttn/ax/commit/15f5a3748f2a147423b31ee9f14f20660a61f9b8))
* **classifiers:** expose review pipeline output status ([7f99f7c](https://github.com/Necmttn/ax/commit/7f99f7cdbaa44322ed92de5126284a3eaf4f3f68))
* **classifiers:** expose review pipeline outputs ([eb958c1](https://github.com/Necmttn/ax/commit/eb958c189feb036d4b6c5209ed83da7ef2b1658f))
* **classifiers:** expose review pipeline stage ([7b2aa7a](https://github.com/Necmttn/ax/commit/7b2aa7acc524e8f7ded579c7891c4fd6bd103655))
* **classifiers:** expose review pipeline value kinds ([a4bf3d8](https://github.com/Necmttn/ax/commit/a4bf3d8e9278069ebd43cdae5cf1cad877ec2c22))
* **classifiers:** expose review repair argv ([f8f6dd4](https://github.com/Necmttn/ax/commit/f8f6dd4f413dbe9611910aea612afd5cd2358b60))
* **classifiers:** expose route execution status ([6a53689](https://github.com/Necmttn/ax/commit/6a536897dad40deede222257bb0cf6ef3c747ccc))
* **classifiers:** expose routing policy floor gaps ([ae25d34](https://github.com/Necmttn/ax/commit/ae25d3490d683e5714f948d5a57634db3d850bd3))
* **classifiers:** expose routing repair outcome ([5cf5891](https://github.com/Necmttn/ax/commit/5cf589135d308d506139cee9e9974ff5ce8ddccd))
* **classifiers:** expose routing verification outcome ([9c580cb](https://github.com/Necmttn/ax/commit/9c580cb106cc3c34096963404d9c0dd9af016662))
* **classifiers:** expose strict review readiness ([32cc22b](https://github.com/Necmttn/ax/commit/32cc22b3c0add3bd6bf615aca8299ff5f8b698db))
* **classifiers:** expose suggested query next action ([5034871](https://github.com/Necmttn/ax/commit/5034871b2a4dc040e8a63f4f3d19e67f32f9df16))
* **classifiers:** expose suggested query remediation ([020dc85](https://github.com/Necmttn/ax/commit/020dc85e1cc0507c5fd0c5c333818d8cfa0d1370))
* **classifiers:** expose suggested query result count ([d5962ef](https://github.com/Necmttn/ax/commit/d5962ef8fd97cf22cd28f3c5b416c1cb7d6a71a7))
* **classifiers:** expose suggested query status ([48987f1](https://github.com/Necmttn/ax/commit/48987f11c733b0fc8395cccc4a47aaff04ff47e3))
* **classifiers:** expose task review progress ([3e85f6e](https://github.com/Necmttn/ax/commit/3e85f6e52864c532ba1ea2e0314a2bceb5ef17d4))
* **classifiers:** expose task review route ([94474c8](https://github.com/Necmttn/ax/commit/94474c8e5943d701185f7c1b8937789165fc70d8))
* **classifiers:** expose workflow quality status ([5b4d688](https://github.com/Necmttn/ax/commit/5b4d688eeaa3d3ceb7de9cb27d978de42bbdec7e))
* **classifiers:** filter graph facts by call reduction ([3140d03](https://github.com/Necmttn/ax/commit/3140d033598e4c41a835c33af839fa7298ce0009))
* **classifiers:** filter graph facts by exact value ([7321e54](https://github.com/Necmttn/ax/commit/7321e54cb58e235d9424978d2cc3dc2fe68af2b4))
* **classifiers:** filter graph facts by kind ([d2f3d98](https://github.com/Necmttn/ax/commit/d2f3d98ad7e0dcaaded5809004bf9e20bd87431a))
* **classifiers:** filter graph facts by nearest fixture ([cc73a65](https://github.com/Necmttn/ax/commit/cc73a653d2f22bb9c8ec78a5465f244012646607))
* **classifiers:** filter graph facts by proposed label ([a42f4c3](https://github.com/Necmttn/ax/commit/a42f4c3ce9548f4fc245286b3bdc14eae7756f08))
* **classifiers:** filter graph facts by recall ([4b4e2b4](https://github.com/Necmttn/ax/commit/4b4e2b44be767a45f94606d29f98ebb90b26e41d))
* **classifiers:** filter graph facts by seed count ([7c477ab](https://github.com/Necmttn/ax/commit/7c477abc962389a3c6a6b96552a901ebeeff2af2))
* **classifiers:** filter graph facts by similarity ([9e13f95](https://github.com/Necmttn/ax/commit/9e13f951b5762e3de3582a53213e61ebdd0deb97))
* **classifiers:** filter graph facts by source ([f3231cd](https://github.com/Necmttn/ax/commit/f3231cd2c36cb7989ec22fcb32df9a167852677c))
* **classifiers:** filter graph facts by source fixture ([228c4a9](https://github.com/Necmttn/ax/commit/228c4a9428379c0518630a2c8a297f345423716c))
* **classifiers:** filter graph facts by status ([2d6f897](https://github.com/Necmttn/ax/commit/2d6f897d2d52da4bcdfc8481819afb3d42fd720b))
* **classifiers:** filter graph facts by threshold ([c861a55](https://github.com/Necmttn/ax/commit/c861a5517af5b8e6844f11f7390601add68e8c0b))
* **classifiers:** filter graph facts by value ([d32714a](https://github.com/Necmttn/ax/commit/d32714afcd674a625d169d9f2c8adc81054d057b))
* **classifiers:** filter lifecycle graph predicates ([7a67d4e](https://github.com/Necmttn/ax/commit/7a67d4e9ab845935fa0159e3fc05675f08e5e2ea))
* **classifiers:** filter lifecycle graph subjects ([90e09b9](https://github.com/Necmttn/ax/commit/90e09b9e662bbaf12472144232115ae49ddcb01b))
* **classifiers:** filter pending review progress ([4d0c5ad](https://github.com/Necmttn/ax/commit/4d0c5ad4ea2c665634e4682e9ae1bb78ad18a787))
* **classifiers:** filter pending review routes ([9cd26d4](https://github.com/Necmttn/ax/commit/9cd26d40f650d547a8b02b0f8817e53364d219f6))
* **classifiers:** filter pending review tasks ([6e7ea69](https://github.com/Necmttn/ax/commit/6e7ea69763067df2babb45bc430b04030a9fff6c))
* **classifiers:** gate lifecycle route execution ([991ae81](https://github.com/Necmttn/ax/commit/991ae81903f8a2eb67817d62f1f7b795b04c69b5))
* **classifiers:** gate strict review provenance ([d8a37df](https://github.com/Necmttn/ax/commit/d8a37df29488232fd9bc24907cd3e21c72790490))
* **classifiers:** guard coverage review applies ([fc48156](https://github.com/Necmttn/ax/commit/fc481565970610c5ada1bf5d5d382bb079903226))
* **classifiers:** guard review task commands ([c4fb59e](https://github.com/Necmttn/ax/commit/c4fb59e85b0903f9091aa66f18e4c09a4d44a6c8))
* **classifiers:** include original query suggestion ([b19baab](https://github.com/Necmttn/ax/commit/b19baabe5487a316dd29b7d232fae40259a0de8c))
* **classifiers:** inspect lifecycle route outputs ([5ad74ac](https://github.com/Necmttn/ax/commit/5ad74ace80a541c6c2f1fc9257adcbe67795826d))
* **classifiers:** list pending review tasks ([80ef569](https://github.com/Necmttn/ax/commit/80ef5690a44f3fbfbbde2525b755e03c7a24fe41))
* **classifiers:** mark pending review tasks ([5d35f29](https://github.com/Necmttn/ax/commit/5d35f29fc9e133fb84078fc8b7321b53b2af4617))
* **classifiers:** measure helper graph usefulness ([5624063](https://github.com/Necmttn/ax/commit/562406317ff82c973cdf75de2048919a2fa68137))
* **classifiers:** measure helper usefulness coverage ([66e8cce](https://github.com/Necmttn/ax/commit/66e8cce0d3c87cbbea97e76d7dc891b2e3557542))
* **classifiers:** persist accepted harness checks ([0202a20](https://github.com/Necmttn/ax/commit/0202a2045a44da200b22f7e2586af83cc1c442e3))
* **classifiers:** persist graph suggestion outcomes ([a457d1e](https://github.com/Necmttn/ax/commit/a457d1eabd450fa8f36826c779f105f12306e4a7))
* **classifiers:** persist helper graph facts ([c1fc3cb](https://github.com/Necmttn/ax/commit/c1fc3cb5df8823f7145da4e32e2ae72cb49a8733))
* **classifiers:** persist query suggestion routing summaries ([ab88980](https://github.com/Necmttn/ax/commit/ab8898081de3947c17930cabd5ed973f2dd282fa))
* **classifiers:** persist topic review facts ([18a696a](https://github.com/Necmttn/ax/commit/18a696a2a896db50c01a0d381a41ec9ec655d870))
* **classifiers:** preflight recommended routing query ([6efd848](https://github.com/Necmttn/ax/commit/6efd84856914941e0bb81269403d19fe0b276d3f))
* **classifiers:** prepare review pipeline commands ([5a1a103](https://github.com/Necmttn/ax/commit/5a1a10338ef6f20020473d1a4817afdb6c41b2fe))
* **classifiers:** preserve fixture target provenance ([bde19e7](https://github.com/Necmttn/ax/commit/bde19e7c7607d29ca90c85d9a7ae3fecbe229c8d))
* **classifiers:** preserve review binding indexes ([37a988b](https://github.com/Necmttn/ax/commit/37a988b2bd0b51e126c8c054fdad4fe86c020c99))
* **classifiers:** preview bound lifecycle routes ([ce90aff](https://github.com/Necmttn/ax/commit/ce90aff1f0d68db6129dec2cd275725d84a64cf5))
* **classifiers:** preview handoff apply guard ([5c9c067](https://github.com/Necmttn/ax/commit/5c9c067f5d94f77f22b019f562f2ff56d6f6d07e))
* **classifiers:** preview production apply guard ([5eb2894](https://github.com/Necmttn/ax/commit/5eb2894c11a2868ae92e94f25d130ec677c7a8e8))
* **classifiers:** prioritize lifecycle routes ([1fe4c95](https://github.com/Necmttn/ax/commit/1fe4c9548bc11896deda9c70c8176b9d36448029))
* **classifiers:** project boundary replay facts ([370ea6d](https://github.com/Necmttn/ax/commit/370ea6d9ab30d1bdbe2e10ce5b94fcefc2080898))
* **classifiers:** project coverage fixture reviews ([83ebdb0](https://github.com/Necmttn/ax/commit/83ebdb011e290412f382bf048e632695e2e0d947))
* **classifiers:** project coverage review closure ([10529fb](https://github.com/Necmttn/ax/commit/10529fb4ec592a5a88541c8f6bcd918ced8274da))
* **classifiers:** project review action argv facts ([3a02960](https://github.com/Necmttn/ax/commit/3a0296042c56c0c65c07f9218a0f942c0eb19b6b))
* **classifiers:** project review pipeline command facts ([2965586](https://github.com/Necmttn/ax/commit/29655869804f6a1b092cf9ecd5f07b4311961926))
* **classifiers:** project review pipeline lifecycle facts ([69809e1](https://github.com/Necmttn/ax/commit/69809e10d2e994ec322148bd894f221ab27fa749))
* **classifiers:** project route apply lifecycle facts ([3e1af11](https://github.com/Necmttn/ax/commit/3e1af113f7ed851f2cb880deffaec1d3310c362d))
* **classifiers:** promote helper fixtures ([65fa1c4](https://github.com/Necmttn/ax/commit/65fa1c438cead6487a5d272395e22aa261cbfa39))
* **classifiers:** query boundary replay graph facts ([a94807d](https://github.com/Necmttn/ax/commit/a94807ddcb46e390ff9140357cff006683c58731))
* **classifiers:** recommend candidates from lifecycle facts ([6f0fe83](https://github.com/Necmttn/ax/commit/6f0fe836788b4e010c18e66718b8bfe2aa2f4e06))
* **classifiers:** recommend pending review task ([da6970f](https://github.com/Necmttn/ax/commit/da6970ff38b07303e5c476e7550957bbe20d1213))
* **classifiers:** recommend review pipeline action ([4aba574](https://github.com/Necmttn/ax/commit/4aba5741a80b5a5de995d07a28f44af313a9978f))
* **classifiers:** recommend routing floor adjustments ([03f6954](https://github.com/Necmttn/ax/commit/03f6954db2f8212020086ccf94e0c4fcc03b5e73))
* **classifiers:** record review brief paths ([93eeaab](https://github.com/Necmttn/ax/commit/93eeaab081e90c3b74425a1e099efb4f922000ff))
* **classifiers:** record review export paths ([32cfa10](https://github.com/Necmttn/ax/commit/32cfa106da83a22850f9a1ff0b827dd1c233a389))
* **classifiers:** rediscover applied harness proposals ([3789c07](https://github.com/Necmttn/ax/commit/3789c078df6b3db6e9929604ff8916031b761772))
* **classifiers:** render batch review commands ([3761d74](https://github.com/Necmttn/ax/commit/3761d7409520176d2e0219898e6f23fc0a8f7dbe))
* **classifiers:** render coverage audit rows ([acdec6a](https://github.com/Necmttn/ax/commit/acdec6a871246e7e7112fa4307e0d27b037cf096))
* **classifiers:** render graph suggestion outcomes ([fa3a00b](https://github.com/Necmttn/ax/commit/fa3a00b30c3d4f46d7367521a4569cc2033c64b5))
* **classifiers:** render provenance issues in briefs ([0e577eb](https://github.com/Necmttn/ax/commit/0e577eb8bec218e349b5913c09c0c4540e92fe8f))
* **classifiers:** render query suggestion routing text ([4fef088](https://github.com/Necmttn/ax/commit/4fef088c4b688368d722e4ac26f6c44420e0d382))
* **classifiers:** repair pending review context ([0ab26b5](https://github.com/Necmttn/ax/commit/0ab26b5ac87b87e6968b5872de3de6fc92fdeb3e))
* **classifiers:** replay deterministic boundary coverage ([91c3ce0](https://github.com/Necmttn/ax/commit/91c3ce009d1121a6410b51cd85a6d838ad7c2acb))
* **classifiers:** report classifier quality status ([236d8ec](https://github.com/Necmttn/ax/commit/236d8ec7bd75c1b046aa6cb57afdd6a940412299))
* **classifiers:** report coverage apply result ([7504924](https://github.com/Necmttn/ax/commit/75049249e122cad85a420c5f4c5e853e0878a8c1))
* **classifiers:** report coverage brief sync issues ([91edc29](https://github.com/Necmttn/ax/commit/91edc29f82beb4178c0ac6bc3e90a2c0d5142328))
* **classifiers:** report coverage review impact ([37a7ef8](https://github.com/Necmttn/ax/commit/37a7ef8909f89c225e0b28f449cd158ff6897417))
* **classifiers:** report coverage review readiness ([bce421d](https://github.com/Necmttn/ax/commit/bce421daffdc5ea8b6335dc4539fe62209e063e0))
* **classifiers:** report provenance issue rows ([9e84e94](https://github.com/Necmttn/ax/commit/9e84e943d6b079f74350942762f7c5723101535c))
* **classifiers:** report review handoff status ([ce4baba](https://github.com/Necmttn/ax/commit/ce4baba939e00b7a7c1dfb75ee05804b4db98513))
* **classifiers:** require review handoff ([825f248](https://github.com/Necmttn/ax/commit/825f24887e0acdbabfc62cb6b66552ef263a9192))
* **classifiers:** resolve pending review targets ([2af4704](https://github.com/Necmttn/ax/commit/2af4704835df105022c4463f873949a59e65d813))
* **classifiers:** review workflow boundary misses ([b50cf71](https://github.com/Necmttn/ax/commit/b50cf712cca91f2d73ae805a3f8140e5ee3497d4))
* **classifiers:** route accepted fixture followups ([68eca61](https://github.com/Necmttn/ax/commit/68eca61e501418795af22de539cd0782c30319ff))
* **classifiers:** route batch review handoffs ([ce76aa2](https://github.com/Necmttn/ax/commit/ce76aa219d487ef176ce23f45c6a3369fd25ffd5))
* **classifiers:** route graph suggestions in lifecycle ([ff053da](https://github.com/Necmttn/ax/commit/ff053daa557188155079253ae5cc857dfe1c522b))
* **classifiers:** route incomplete review context ([b84c178](https://github.com/Necmttn/ax/commit/b84c178a392868941561a774969688c8ce1a0259))
* **classifiers:** route pending review tasks ([6887aee](https://github.com/Necmttn/ax/commit/6887aeeb16b42ad0c13735df3af8725da36e24cb))
* **classifiers:** route recommended routing policy ([8a32ce3](https://github.com/Necmttn/ax/commit/8a32ce3fc8f7c43adc03d9490b0ba35923d3e12c))
* **classifiers:** route review pipeline actions ([f9a979f](https://github.com/Necmttn/ax/commit/f9a979f462613839543f562fe3c1783f272332a7))
* **classifiers:** route routing policy no matches ([08433f8](https://github.com/Necmttn/ax/commit/08433f8f1c6ffded9ee16a17ec1a828c61d71545))
* **classifiers:** scope review issue blockers ([4448a27](https://github.com/Necmttn/ax/commit/4448a27e02cd530cd1ea144b26a08f11b4d2a148))
* **classifiers:** select recommended routing policy ([74dbd67](https://github.com/Necmttn/ax/commit/74dbd672419b2fa6e355402b27afda79a4c55d84))
* **classifiers:** show audit provenance ([3401b54](https://github.com/Necmttn/ax/commit/3401b54a4ce9e0ae068df9313b8dd7b1f8827a99))
* **classifiers:** show best available routing policy ([5e085aa](https://github.com/Necmttn/ax/commit/5e085aac62bede9f60bcebe292947c64c06a72c4))
* **classifiers:** show handoff gate in briefs ([06ca8c2](https://github.com/Necmttn/ax/commit/06ca8c26e4d81af63bb96424df6a84dd4e975a73))
* **classifiers:** show production gate in briefs ([787ec8d](https://github.com/Necmttn/ax/commit/787ec8d24a4088a9683bc47b475421718f139255))
* **classifiers:** show provenance stamp command ([65c8540](https://github.com/Necmttn/ax/commit/65c8540618608e0932c918128138ef9e79d0a675))
* **classifiers:** show review issues in briefs ([35d773b](https://github.com/Necmttn/ax/commit/35d773b59c5f53eb3f5f731227d16d887d7cb112))
* **classifiers:** show review task decisions ([61c94c7](https://github.com/Necmttn/ax/commit/61c94c7fef8b25e2d0489d5d5672c7eb765f3927))
* **classifiers:** show review write plan command ([6216815](https://github.com/Necmttn/ax/commit/6216815388a70624f601b3f341632c8f1564e6bb))
* **classifiers:** split provenance review pipeline stage ([3ffc202](https://github.com/Necmttn/ax/commit/3ffc2021150b2ea2c3e3dca1a92fd6ca0d5f0b76))
* **classifiers:** stamp review provenance ([6ef5287](https://github.com/Necmttn/ax/commit/6ef5287c0c6da5e4b8ac82acdf230a6242195aab))
* **classifiers:** suggest graph query argv ([674e3cf](https://github.com/Necmttn/ax/commit/674e3cf2413d7e1d4ee5b51fcea7c12644ac8308))
* **classifiers:** suggest lifecycle query values ([04a4c80](https://github.com/Necmttn/ax/commit/04a4c804f6e3d9923f818b4608230fa7cc790d33))
* **classifiers:** suggest structured graph query ([fc4e15f](https://github.com/Necmttn/ax/commit/fc4e15f187859c67c84c6f10ca72d9a0075c1f92))
* **classifiers:** summarize boundary replay posture ([41ef07b](https://github.com/Necmttn/ax/commit/41ef07b1107218c097aade14a38ef85912196047))
* **classifiers:** summarize coverage rechecks ([996623a](https://github.com/Necmttn/ax/commit/996623ab92ade25649b0f60470f7ec3383a9295c))
* **classifiers:** summarize coverage review briefs ([95a908b](https://github.com/Necmttn/ax/commit/95a908bcebe55bee864f602038c025dbb3594bfc))
* **classifiers:** summarize coverage review guard ([ecb0404](https://github.com/Necmttn/ax/commit/ecb04048f1cfae42031db37545837193fb61ca41))
* **classifiers:** summarize coverage review verdicts ([3be078f](https://github.com/Necmttn/ax/commit/3be078fd2a1f4bf64b9116a8bc6b96747fe3dbd2))
* **classifiers:** summarize lifecycle fact values ([22b7974](https://github.com/Necmttn/ax/commit/22b7974782bac02efc26a0cad69b24fd4820f882))
* **classifiers:** summarize review action route ([c5a5ac7](https://github.com/Necmttn/ax/commit/c5a5ac71f6ff72c103b7b984d894c422d79a858d))
* **classifiers:** summarize review command readiness ([d5ed2e6](https://github.com/Necmttn/ax/commit/d5ed2e653095203ddfcca38068c867c7ea7d985a))
* **classifiers:** summarize review coverage ([451b524](https://github.com/Necmttn/ax/commit/451b524a1610ff79380413935c210d0cda95f100))
* **classifiers:** summarize review issue counts ([f3510e0](https://github.com/Necmttn/ax/commit/f3510e03feb295574ace55da0b74e991a8711b93))
* **classifiers:** summarize review issue scopes ([887e39e](https://github.com/Necmttn/ax/commit/887e39eae4ee8d4c09e30effff97547cedba3967))
* **classifiers:** summarize review pipeline lifecycle ([8d6cccc](https://github.com/Necmttn/ax/commit/8d6cccc2ec49d43c0f7bf47933eff1bd6f194842))
* **classifiers:** summarize review rationale coverage ([54df4ed](https://github.com/Necmttn/ax/commit/54df4ed8a67610cb490af1ae589aa03c8a107734))
* **classifiers:** summarize routing policy floors ([5624793](https://github.com/Necmttn/ax/commit/5624793875aab46eb68799ca4c636a111e772565))
* **classifiers:** summarize workflow quality conclusion ([3d56600](https://github.com/Necmttn/ax/commit/3d56600494ab6c4790592a6b6e67b51804704036))
* **classifiers:** surface helper review hints ([65bc09a](https://github.com/Necmttn/ax/commit/65bc09aa25def5c483a57216cfa2eb27cdf669c6))
* **classifiers:** surface lifecycle query repair ([7c554d0](https://github.com/Necmttn/ax/commit/7c554d0d4f7af3f7c8e5e7c968a56eeaa04fc473))
* **classifiers:** surface pending review in guidance batches ([7a1feb2](https://github.com/Necmttn/ax/commit/7a1feb25243e73c8f5d2177d1c0f96c099098944))
* **classifiers:** surface persisted topic reviews ([85b4df8](https://github.com/Necmttn/ax/commit/85b4df86224cc310ddaf54ae6c21b822f85d867a))
* **classifiers:** surface route input bindings ([37f5c39](https://github.com/Necmttn/ax/commit/37f5c397bf9789fac8b71a0160ac144e2d9e6a4c))
* **classifiers:** surface strict review brief path ([7d86e2b](https://github.com/Necmttn/ax/commit/7d86e2be1b9afde43638c93fffdcd22cb5173919))
* **classifiers:** surface target resolution ([361c214](https://github.com/Necmttn/ax/commit/361c2145fb954c0399a447baf2f517c9c9179553))
* **classifiers:** sync batch review handoffs ([4f3a506](https://github.com/Necmttn/ax/commit/4f3a506e7ba89822ff150f1478bb33cf9ae4adea))
* **classifiers:** sync helper topic reviews ([6631d2d](https://github.com/Necmttn/ax/commit/6631d2d4b5af7a98a61b29e69bb750e6dc2786e6))
* **classifiers:** validate review timestamps ([0e2989d](https://github.com/Necmttn/ax/commit/0e2989d65f98f5669ab19f5099af7a8ca30f04eb))
* **classifiers:** verify review pipeline outputs ([d794f95](https://github.com/Necmttn/ax/commit/d794f953b7b040b44dfb4bc0e5dce8d681c9624e))
* **classifiers:** version coverage readiness summary ([770546a](https://github.com/Necmttn/ax/commit/770546a34f283b58a2fc69ec8ad2687d03db45ef))
* **classifiers:** write pending review service reports ([7a589e8](https://github.com/Necmttn/ax/commit/7a589e8696750d6272976f83bd679fb037ff763b))
* **cli:** axctl uninstall --purge to wipe the data dir ([5a852db](https://github.com/Necmttn/ax/commit/5a852dbed57de9e21db955f0f285e1ab5c0b2750))
* **site:** add landing proof sequence ([23e5103](https://github.com/Necmttn/ax/commit/23e5103927f2023a34d7c86e78a3972f0e4fbdb1))
* **site:** minimal landing v2 + /features + install redirect ([38fe2ae](https://github.com/Necmttn/ax/commit/38fe2ae9c87fbd05fbbbbee0d27f2eeeefccea42))
* **site:** minimal landing v2 + /features deep-dive + archived old landing ([8e1325c](https://github.com/Necmttn/ax/commit/8e1325cdeade1bd9561c448c3717885458cfe712))
* **site:** open-source section redesign + AGPL-3.0 relicense ([aeff89d](https://github.com/Necmttn/ax/commit/aeff89d055241042f880224d5b4e17205ca12994))
* **site:** open-source section redesign + AGPL-3.0 relicense ([d768849](https://github.com/Necmttn/ax/commit/d768849cf19590dbc2eabc1991804f0c613e2a2e))
* **site:** prerender homepage to static HTML + prettier install script ([3f49b26](https://github.com/Necmttn/ax/commit/3f49b264c58b6c85427b88f4727cc4ea8fba7a1d))
* **studio:** add inspector legend and cost lens ([f503007](https://github.com/Necmttn/ax/commit/f503007cbd7b4c06176ed6a9f7e47697e4cab016))
* **studio:** add scrolling cost rail ([108bc13](https://github.com/Necmttn/ax/commit/108bc1346358605e027139f947c389ac85908001))
* **studio:** local session inspector — cost lens, token rail, tooltips ([b843fdb](https://github.com/Necmttn/ax/commit/b843fdb14367680777e6b4ec03976a8f89836879))
* **studio:** show per-turn token costs ([d2a7e14](https://github.com/Necmttn/ax/commit/d2a7e145a0c8dd19f9b96ab35bc5cb5a97e2897d))
* **studio:** unify local session inspector ([3d1221d](https://github.com/Necmttn/ax/commit/3d1221d913083fb9780e1b12977dbb78ce2a681e))


### Bug Fixes

* **ingest:** stable reaction_event id keyed by user_turn (fixes --since crash) ([f704a00](https://github.com/Necmttn/ax/commit/f704a0044e43b2cd3f981d5c2b64b42c5b551fdc))
* **nix:** postinstall guards on bun.lock existence ([71a268c](https://github.com/Necmttn/ax/commit/71a268c3e69ef4d6d2078cfe0b84307bd22620bc))
* **nix:** postinstall guards on bun.lock existence ([fb4bf7a](https://github.com/Necmttn/ax/commit/fb4bf7a6c8f851b32c0c6781dfd2f57fa04abb1a))
* **site:** add @vitejs/plugin-react for client hydration ([49bf739](https://github.com/Necmttn/ax/commit/49bf739711e8e68e8c0b541dec5d0e8b7c29300d))
* **site:** break CF Pages SPA redirect loop (index.html shell) ([c39f247](https://github.com/Necmttn/ax/commit/c39f247cae3745c590e5c850d7d1d11991b387dd))
* **site:** commit /install file directly (Cloudflare wasn't shipping the prebuild-generated mirror) ([a9dd7b7](https://github.com/Necmttn/ax/commit/a9dd7b7d0002253ece21e2a3f8dbdfcff9b1c42a))
* **site:** commit site/public/install directly so Cloudflare ships it ([e3d7742](https://github.com/Necmttn/ax/commit/e3d7742ec16303f594187ab098a684a0e84a7e65))
* **site:** keep share URLs canonical ([960ce41](https://github.com/Necmttn/ax/commit/960ce41c31f7d04ae02f36efb37ecede747f564a))
* **site:** restore SPA client router alongside static prerender ([39972f5](https://github.com/Necmttn/ax/commit/39972f5c79526d344acfb676c331b119e28ef83f))
* **site:** serve /install as static file (auto-copied from repo root install.sh) ([4604dc1](https://github.com/Necmttn/ax/commit/4604dc1f2c3f63f3ae7f6f8ddd44ae423ef8d576))
* **site:** serve /install as static file (Cloudflare didn't honor redirect) ([0e1bece](https://github.com/Necmttn/ax/commit/0e1bece982f675f1adb06dbd7572512894b64781))
* **site:** static-prerender every route + repair content-collections paths ([ef058b7](https://github.com/Necmttn/ax/commit/ef058b73917bd56a4767f0b177bab9a31db97243))
* **site:** update Pi landing link ([b646ff6](https://github.com/Necmttn/ax/commit/b646ff676ca0470e7111b763e22d4616b7f2e93d))
* **site:** use TanStack &lt;Link&gt; for internal nav (client routing + prefetch) ([48834df](https://github.com/Necmttn/ax/commit/48834dfe669e6e05f5421618d5bca88b43332446))
* **studio:** move metric help into tooltips ([56f69c4](https://github.com/Necmttn/ax/commit/56f69c4147fceb3740ac29e5910f2e216174c780))
* **studio:** offset inspector jump targets ([109e6d3](https://github.com/Necmttn/ax/commit/109e6d3fdd2e08a37eac712745e55661105115b9))
* **studio:** reduce selected block highlighting ([803a164](https://github.com/Necmttn/ax/commit/803a164144dde3507e963abd416eca4ece66d147))
* **studio:** route deep links to app shell ([4328e1d](https://github.com/Necmttn/ax/commit/4328e1d042c6e45b67695c8162186f9a739fd4d0))
* **studio:** serve app shell for deep links ([0724c33](https://github.com/Necmttn/ax/commit/0724c33cb8c53b6db111bee43c800a6fd308768e))
* **studio:** soften content block annotations ([1bd4976](https://github.com/Necmttn/ax/commit/1bd4976dd315ff01953d62813a5fbed0b81b7ab9))

## [0.5.0](https://github.com/Necmttn/ax/compare/v0.4.0...v0.5.0) (2026-05-31)


### Features

* **classifiers:** add embedding helper export preview op ([a622841](https://github.com/Necmttn/ax/commit/a6228410bb53c8148f27fc087071fe207dbc3e62))
* **classifiers:** add embedding helper progress op ([e1dcfc1](https://github.com/Necmttn/ax/commit/e1dcfc17c7db537d22594cbdb6d2441c1d04c36a))
* **classifiers:** add embedding helper review batch ([eeb517c](https://github.com/Necmttn/ax/commit/eeb517c759337ede61bd0f845015a5152a440061))
* **classifiers:** dry-run embedding helper batch sync ([9a6811e](https://github.com/Necmttn/ax/commit/9a6811e9c8ca5c2748716b53524318e566ab047b))
* **classifiers:** preview embedding helper exports ([16e6c4e](https://github.com/Necmttn/ax/commit/16e6c4ebf64ab60e1069005a2d3bd253ae6ccf42))
* **classifiers:** report embedding helper review progress ([31a1b16](https://github.com/Necmttn/ax/commit/31a1b16fdf8750099382b23dd3796abc604dbfde))
* **classifiers:** sync embedding helper review copy ([e41562c](https://github.com/Necmttn/ax/commit/e41562ce93580ae0d6a39ed587e764245694ccd0))
* **share:** include turn content blocks ([3cb2f17](https://github.com/Necmttn/ax/commit/3cb2f1751a37cc05f6bb94296ec7f9916c027381))


### Bug Fixes

* **studio:** load shared sessions from raw gist ([b3ed711](https://github.com/Necmttn/ax/commit/b3ed7118b8afa51ddfb38ea32ab116bbb2dfd293))

## [0.4.0](https://github.com/Necmttn/ax/compare/v0.3.0...v0.4.0) (2026-05-31)


### Features

* add gist-backed session sharing ([c7a36a4](https://github.com/Necmttn/ax/commit/c7a36a4d436f6ad80c5961d4da2eacb1badee947))
* add typed JSON boundary helpers ([#101](https://github.com/Necmttn/ax/issues/101)) ([ed95a0e](https://github.com/Necmttn/ax/commit/ed95a0ea7a65ff036ecbd2e26cc5e85a03550a09))
* **classifiers:** add embedding helper export ([4c602d9](https://github.com/Necmttn/ax/commit/4c602d943137ba34e9c87ef81382145bf5cecce6))
* **classifiers:** add embedding helper graph mode ([74c39c7](https://github.com/Necmttn/ax/commit/74c39c7dee35524f8a6592eedccfff3449a2ad57))
* **classifiers:** add embedding helper review ([7dcd25b](https://github.com/Necmttn/ax/commit/7dcd25b4ede2f01ce32918ab3b14f22095f7a1f0))
* **classifiers:** add embedding svm helper eval ([e008bbb](https://github.com/Necmttn/ax/commit/e008bbb176e2997fc88633ee98dff62fae45c27f))
* **classifiers:** add graph classifier harness ([7be279b](https://github.com/Necmttn/ax/commit/7be279b1b54bad9205619cd6c3aab35a3375311d))
* **classifiers:** add lifecycle graph view ([a4d06c3](https://github.com/Necmttn/ax/commit/a4d06c356ba4c783875d5d342a301c85373aab98))
* **classifiers:** add proposal review checklist ([037e6c8](https://github.com/Necmttn/ax/commit/037e6c88f032ebd7ad5956b3e1194391c71c1e5e))
* **classifiers:** add workflow proposal gates ([adef453](https://github.com/Necmttn/ax/commit/adef4537e0da43060c1a64a8b50b9dc2724f8297))
* **classifiers:** gate embedding helper review ([bffba8f](https://github.com/Necmttn/ax/commit/bffba8f74a75cc22adb566e6cc1926764f25f0d5))
* **classifiers:** gate proposal draft promotion ([13146b3](https://github.com/Necmttn/ax/commit/13146b3d6e253755aa1e6ffe29a6a5a1e30c73cf))
* **classifiers:** project embedding helper graph ([08a0648](https://github.com/Necmttn/ax/commit/08a06483562ff2fa38e8f2bb52114a6f0ce77e51))
* **classifiers:** project proposal lifecycle facts ([dc8724f](https://github.com/Necmttn/ax/commit/dc8724f0a5df5e5744b0c100584b0358b1872b6c))
* **classifiers:** surface proposal lifecycle ([75c006c](https://github.com/Necmttn/ax/commit/75c006cc8bea83a0ab66a6ea2ba2a622f5fee567))
* **cli:** expand insights and session surfaces ([5fb4a81](https://github.com/Necmttn/ax/commit/5fb4a8162eb615dd7b0ea073558819ffb22fbf61))
* **ingest:** normalize provider sessions and costs ([0f3f31d](https://github.com/Necmttn/ax/commit/0f3f31d7e079dc2d4e0f59a78737c31bb65f1083))
* **ingest:** parse transcript content blocks ([797991d](https://github.com/Necmttn/ax/commit/797991d30473b9de89a2c5610bea6aeb5f7aaaef))
* **schema:** add storage for content and classifiers ([478273e](https://github.com/Necmttn/ax/commit/478273ed7abd12705d694157c11c73fcf2bb0737))
* **site:** add release changelog page ([#104](https://github.com/Necmttn/ax/issues/104)) ([5919ce0](https://github.com/Necmttn/ax/commit/5919ce0d01f387b1b5d416c5732cca6b01112a7c))
* **site:** add release detail pages ([#105](https://github.com/Necmttn/ax/issues/105)) ([da245e7](https://github.com/Necmttn/ax/commit/da245e74b6dcfea144686e6f89ec85bf075283e9))
* **site:** densify release pages ([#106](https://github.com/Necmttn/ax/issues/106)) ([6e76970](https://github.com/Necmttn/ax/commit/6e7697063e1f79d607058a8ae16c68ab900caefa))


### Bug Fixes

* **ingest:** clean up exact optional handling ([5b7863f](https://github.com/Necmttn/ax/commit/5b7863f543f3c1d97965901541aa8d072527b3cd))
* surface subagent lifecycle in inspector ([9fdadf8](https://github.com/Necmttn/ax/commit/9fdadf84ee6d51ed3393924b8c5e3181d1c8b973))

## [0.3.0](https://github.com/Necmttn/ax/compare/v0.2.0...v0.3.0) (2026-05-30)


### Features

* add provider event graph writers ([328b7ac](https://github.com/Necmttn/ax/commit/328b7ac7968a0e8925b8949bf83983d84a782f56))
* **checkpoints:** session-based verdict windows (closes [#83](https://github.com/Necmttn/ax/issues/83)) ([5b120f5](https://github.com/Necmttn/ax/commit/5b120f50238b95668652405c883fa9eff115bbaf))
* **checkpoints:** session-based verdict windows (closes [#83](https://github.com/Necmttn/ax/issues/83)) ([21af2c1](https://github.com/Necmttn/ax/commit/21af2c124b4267175fb9cb3ce1b5e4ddad71e93a))
* **cli:** accept -v and --version aliases for version ([b825fff](https://github.com/Necmttn/ax/commit/b825fff05c42a51b798054e848a369b9f6f1cc49))
* **cli:** add ax ingest here for pwd-scoped ingest ([ba8ae56](https://github.com/Necmttn/ax/commit/ba8ae566be867b256e7934eca35a92369a6d8166))
* **cli:** add ax session show with collapsed subagents (P2.2) ([e515314](https://github.com/Necmttn/ax/commit/e515314b1a5e5198b197387d996720b91aca5b46))
* **cli:** add ax sessions here|around|near (F2, F3) ([cac3f5e](https://github.com/Necmttn/ax/commit/cac3f5eafac0aa9cac1ccfc953fa6fc000b93b23))
* **cli:** reject removed --*-only ingest flags with actionable error ([b98514e](https://github.com/Necmttn/ax/commit/b98514eda23935c1b9313c4422c9c645c768465f))
* dual-write claude and codex provider events ([9113f80](https://github.com/Necmttn/ax/commit/9113f80c31fde0d60e2548967dc66090de907573))
* extract cursor tool calls ([#96](https://github.com/Necmttn/ax/issues/96)) ([5bd6df6](https://github.com/Necmttn/ax/commit/5bd6df699b34798a94b5a6ddb53382542e44cea3))
* **improve:** grounded agent files v0 ([fd09c99](https://github.com/Necmttn/ax/commit/fd09c9995ae962b6c45359d9f5a24964c0b71e3c))
* ingest local cursor chat history ([01c8048](https://github.com/Necmttn/ax/commit/01c8048b62b4874c8e819885529fa04287c41a94))
* ingest local opencode sessions ([58070a7](https://github.com/Necmttn/ax/commit/58070a74b44fafde34f4833045a86e2cc2ccfce6))
* ingest local pi sessions ([fd11ed6](https://github.com/Necmttn/ax/commit/fd11ed6d88b0a7cc79551584205db1f2d4d4c906))
* **ingest:** claude stage co-located StageDef ([70a5d00](https://github.com/Necmttn/ax/commit/70a5d0060fc1c1911ca191c8d031fb34e9438af3))
* **ingest:** closure stage co-located StageDef ([6b4af16](https://github.com/Necmttn/ax/commit/6b4af1629d85f734e3cdf1caaebb572a84ab922e))
* **ingest:** codex stage co-located StageDef ([e832c9d](https://github.com/Necmttn/ax/commit/e832c9d8d108f43b28c974101a426380fb4ff64c))
* **ingest:** commands stage co-located StageDef ([383baa2](https://github.com/Necmttn/ax/commit/383baa258e3dfd9738e1c4a55c88c3b9924e83c6))
* **ingest:** git stage co-located StageDef ([83d728f](https://github.com/Necmttn/ax/commit/83d728f67b4938c937827d05f13ada6b5e33e421))
* **ingest:** harness stage co-located StageDef ([7147ea9](https://github.com/Necmttn/ax/commit/7147ea95a7412eb7ba6e0931b80f9fb366e7d909))
* **ingest:** inherit + backfill subagent repository link (F7) ([b979c7b](https://github.com/Necmttn/ax/commit/b979c7b6e34c21f4eee542153a721701ec43355e))
* **ingest:** opportunities stage co-located StageDef ([ae06e3a](https://github.com/Necmttn/ax/commit/ae06e3a61de94b6cf3771511b548183b6f97dc71))
* **ingest:** outcomes stage co-located StageDef ([984c25e](https://github.com/Necmttn/ax/commit/984c25e619843d66eb2eb308bbdb63517f985d23))
* **ingest:** proposals stage co-located StageDef ([7a9049f](https://github.com/Necmttn/ax/commit/7a9049f7b4c76a5513c200c9a55a2265038086bb))
* **ingest:** read frontmatter role + emit plays_role edges (P3.2) ([85e7a27](https://github.com/Necmttn/ax/commit/85e7a275fd1f6e56da0bc16de36e0f33c882af0a))
* **ingest:** retro-proposals stage co-located StageDef ([2beadb5](https://github.com/Necmttn/ax/commit/2beadb52d125e9cd7ed0540b1a7e6343da1a1dd2))
* **ingest:** runPipeline over StageDef[] with LiveTrace.step wrap ([d1a95b5](https://github.com/Necmttn/ax/commit/d1a95b5cf349696ba260eb59df76de2a035d691e))
* **ingest:** Schema types for StageDef foundation (ADR-0006) ([14e778a](https://github.com/Necmttn/ax/commit/14e778aee9656a7d2506942f5407fb4f80ccc538))
* **ingest:** selectByKeys + selectByTag over registry ([8550d73](https://github.com/Necmttn/ax/commit/8550d73f5c6f91e6cfb1372f29647339c29f279c))
* **ingest:** session-health stage co-located StageDef ([89353c8](https://github.com/Necmttn/ax/commit/89353c82f7bd9020ebd83ef318f4620da580362b))
* **ingest:** signals stage co-located StageDef ([f22169f](https://github.com/Necmttn/ax/commit/f22169fa8b1386fb9db3e86e0f00ce246206d2f3))
* **ingest:** skills stage co-located StageDef (canonical pattern) ([0aff468](https://github.com/Necmttn/ax/commit/0aff4686212a2ba949ad67892fea1cdc18e29d10))
* **ingest:** spawned stage co-located StageDef ([84ddea6](https://github.com/Necmttn/ax/commit/84ddea6820639f112392080fb0b9f67ce9b8b9ae))
* **ingest:** StageRegistry service + IngestStageKey union skeleton ([7354793](https://github.com/Necmttn/ax/commit/73547939eb7a4bb8c2c2db757cc2446c468052c5))
* **ingest:** subagents stage co-located StageDef ([541c93b](https://github.com/Necmttn/ax/commit/541c93b53b74513c9dac2e2d5ab24b7a087a2916))
* **layers:** wire LiveTrace + StageRegistry into AppLayer (ADR-0007) ([5c6dba1](https://github.com/Necmttn/ax/commit/5c6dba1feddb679aa0092aa0f215bd35d5ce4edb))
* **lib:** add pwd repository resolver ([adaca40](https://github.com/Necmttn/ax/commit/adaca401cda22af14c476e2b6e3e9857fc1643a9))
* **live-traces:** vendor tracer decorator + sink from quera (ADR-0008) ([98d9498](https://github.com/Necmttn/ax/commit/98d949895de848a0d2c989ac39082caf88690c8a))
* **recall:** add --sources and --scope (F4 + F2) ([c18c9da](https://github.com/Necmttn/ax/commit/c18c9da3c188a783a308c2fb707c893967ede7f5))
* register local agent provider stages ([57640fc](https://github.com/Necmttn/ax/commit/57640fc6f61ccd95b00f0f5cabf65b42d786ce5c))
* **retro:** pull-based session retros via reviewed graph edge ([6cbc61b](https://github.com/Necmttn/ax/commit/6cbc61b1bc3d5b969bc221f53bc91477f82fc941))
* **roles:** add by-role + roles + sessions show --by-role (P3.7) ([7b8559b](https://github.com/Necmttn/ax/commit/7b8559b5451550a9c8fb10b49972b0dba3b777c0))
* **schema:** add role + plays_role + invoked position fields (P3.1) ([a8b809c](https://github.com/Necmttn/ax/commit/a8b809cf09d79bafd828bff908777952dcdb5ef6))
* **schema:** full-text search on commit messages (F4) ([cbed141](https://github.com/Necmttn/ax/commit/cbed141e29735c741a5c993bd6e1fbcc8682f975))
* **sessions:** auto-delta ingest on stale transcripts (P1.4) ([1de8135](https://github.com/Necmttn/ax/commit/1de8135f787bcc69d721d37c6b5372e0dc6c8d43))
* **site:** bind ADR + markdown page routes ([8eefb56](https://github.com/Necmttn/ax/commit/8eefb5650743d3cb7abb6a583da9c5babe3a4c16))
* **site:** cloudflare pages deploy config ([76bfc98](https://github.com/Necmttn/ax/commit/76bfc98c93b771f114fd06ce28ae3cdf21c9f0ab))
* **site:** four showcase routes — hook backtest, recall, token economy, verdict timeline ([77cdd1a](https://github.com/Necmttn/ax/commit/77cdd1a8c97f4eadc160c88237370f7aa8785306))
* **site:** four showcase routes (hook backtest, recall, token economy, verdict timeline) ([6d67ea6](https://github.com/Necmttn/ax/commit/6d67ea64c951993df50155f92b22d76f0da67fc8))
* **site:** how ax sees your work narrative page ([6b6b0e3](https://github.com/Necmttn/ax/commit/6b6b0e389eff651811625a4fd37c6d31f16de76e))
* **site:** port landing from docs/index.html ([8a10863](https://github.com/Necmttn/ax/commit/8a10863660ce13edb5a2338c1b4103bb87960e14))
* **site:** port origin story from docs/origin.html ([2b8fcf7](https://github.com/Necmttn/ax/commit/2b8fcf7432c53854e12332e123748cbf74aee18c))
* **site:** scaffold tanstack-start docs app ([5d8403e](https://github.com/Necmttn/ax/commit/5d8403ebef1299fd66ee0d5738b9f767c21295b1))
* **site:** stage rationale annotation + extractor ([5646a29](https://github.com/Necmttn/ax/commit/5646a2905dfe47f93b3f35ba828703d365ab500e))
* **site:** wire content-collections to docs/ markdown ([c17d942](https://github.com/Necmttn/ax/commit/c17d94221264adff7323a562afdf582df0b080de))
* **skill:** add ax-extract-workflow orchestration skill (P4.1) ([69404ee](https://github.com/Necmttn/ax/commit/69404eee7341d004eec845e1070c27051ce3be43))
* **skills:** add lint command to apply classify briefs (P3.5) ([94a9cee](https://github.com/Necmttn/ax/commit/94a9cee6e75fe2498132ec1fff6f2c26000ed533))
* **skills:** add tag command for manual role overrides (P3.4) ([c71ec86](https://github.com/Necmttn/ax/commit/c71ec8632fe652e5046273849e724c6c2e8f1971))
* **skills:** classify command emits briefs for unclassified skills (P3.3) ([e448ad9](https://github.com/Necmttn/ax/commit/e448ad922cfb966c2265f8069ad5128d92cb9bd6))
* **skills:** weighted ranking with role traversal + doctor mode (P3.6) ([0d44ff4](https://github.com/Necmttn/ax/commit/0d44ff42c6b42c45e61fcc4c4799f9c841ef2df1))


### Bug Fixes

* add provider event graph health reader ([30e98f9](https://github.com/Necmttn/ax/commit/30e98f9d6afa0c80f5f9d33f683d8661dcc2acfc))
* align provider event schema with plan ([143320d](https://github.com/Necmttn/ax/commit/143320d17ed2f40e45799ac5b90bc041e905cc9c))
* **backfill:** recompute is_first across full session group (R4) ([ac3880d](https://github.com/Necmttn/ax/commit/ac3880d955ab41ae776dc0410e0220d9c4988919))
* **ci:** bump AX_VERSION to 0.2.0 + install ripgrep on Linux runners ([9ffee22](https://github.com/Necmttn/ax/commit/9ffee226889c0e5fa5767babb216f6fb717ad0d3))
* **ci:** install ripgrep on macOS runner too ([2646bb0](https://github.com/Necmttn/ax/commit/2646bb047693adf0e5617bd86d97d2190c993be8))
* **ci:** unblock typecheck — hoist try/catch out of Effect.gen + ignore warnings in tsc exit ([02e5c75](https://github.com/Necmttn/ax/commit/02e5c75c6acf5d47b14295e78eaff74cab723887))
* **cli:** --with-agent calls runAgentAccept directly post-autoScaffold ([72c35d2](https://github.com/Necmttn/ax/commit/72c35d247135457b010ce90ac27308127aa2791e))
* **cli:** scope ingest here error handling + drop dead --derive-only ([a1b464c](https://github.com/Necmttn/ax/commit/a1b464c1009f3393a1312b06a4df23fc49a536c1))
* complete local provider integration ([c06c2b1](https://github.com/Necmttn/ax/commit/c06c2b123c3f08375e829ff54ba000733b8c6b10))
* harden pi ingest parsing ([436ccca](https://github.com/Necmttn/ax/commit/436cccadf24ab483d79ea36a9ec8d7047833a0f9))
* harden provider event graph writes ([032ae9c](https://github.com/Necmttn/ax/commit/032ae9c956039a1288c334cdf854eb773902e933))
* **improve:** acceptProposal — validate dedupe_sig + dedupe experiment keys ([80d983c](https://github.com/Necmttn/ax/commit/80d983c7f018b194b83d231ad168b5191bba5114))
* **improve:** acceptProposal writes task atomically via tmp+rename ([f46e9f1](https://github.com/Necmttn/ax/commit/f46e9f1fa38722d71f44e86fc737304f8303cd37))
* **improve:** lint reconciles DB before deleting task files ([3f06378](https://github.com/Necmttn/ax/commit/3f063782198e668ab29826e1ebaaf5440c3c9d4d))
* **improve:** lint reconciles frontmatter ax_experiment exactly; flags ambiguous dups ([582db82](https://github.com/Necmttn/ax/commit/582db826751769e9034c977081103d489ca0c13e))
* **improve:** markers — balanced nesting for same-id close tags in body ([3234eef](https://github.com/Necmttn/ax/commit/3234eef34d67764327a6fcaae8b7b48562f5fd13))
* **improve:** markers — local regex instance, no shared lastIndex ([f52bb4d](https://github.com/Necmttn/ax/commit/f52bb4d3bcc5775a60dfc29061c1594656524f26))
* **improve:** preserve full dedupe_sig in task markers + dashboard types ([0e60fd1](https://github.com/Necmttn/ax/commit/0e60fd1afe0366662d4ecaef6c3a25938d41f181))
* **improve:** recommend scoring — finite guard + log1p preserves freq=0 conf signal ([fd652e3](https://github.com/Necmttn/ax/commit/fd652e331088dac9cf5115818c95795069f3d4ef))
* **improve:** task template — fence label + lint command shape ([478dc20](https://github.com/Necmttn/ax/commit/478dc20c13b9adcdb719ddeb83e51e5bd4d26240))
* ingest cursor disk kv composer sessions ([4236f5f](https://github.com/Necmttn/ax/commit/4236f5fe33ee6621070e1bb55bc1790aec49ab34))
* **ingest:** clamp sinceDays helper avoids 56-year scan on epoch-zero ctx.since ([0f7a07f](https://github.com/Necmttn/ax/commit/0f7a07f2fe13ad0e0e897cfcad84371ea2e813cf))
* **ingest:** guard subagent backfill record id + assert bindings in tests ([1c5b898](https://github.com/Necmttn/ax/commit/1c5b8985fa10d77c9e80a879cd7611945545397c))
* keep provider event sequences unique ([151091c](https://github.com/Necmttn/ax/commit/151091c960cb673d4ebfdeefb06367d50b2196d0))
* **layers:** move StageRegistryDefault out of AppLayer to dodge ESM load races ([995f1b8](https://github.com/Necmttn/ax/commit/995f1b8dc0138797c24ce0afb9f4e37be6676f8a))
* **live-traces, ingest:** tsc cleanup — port Schema.ts/Logger.ts; drop unused imports ([4df5178](https://github.com/Necmttn/ax/commit/4df5178e0d7b3e827fdea9f4dbc5c5883f11bb89))
* **live-traces:** emit child SpanStart/SpanEnd for step inside withTrace ([de12276](https://github.com/Necmttn/ax/commit/de122763c1d4f56b5b296b56fb18cead59bf95fd))
* **live-traces:** snapshot WrappedSpan startTime at construction ([4bce06a](https://github.com/Necmttn/ax/commit/4bce06a476b4f150ce888963c82a564bd9a76393))
* **live-traces:** use TestClock in Sink test; drop duplicate ConsoleTransport ([6727f2c](https://github.com/Necmttn/ax/commit/6727f2ca1f8fce32ec8b9bed51d5e21ca8b872e2))
* **live-traces:** write console transport to stderr, opt-in via --debug ([4568dd0](https://github.com/Necmttn/ax/commit/4568dd0ae9b3029b04dfe2a3d7231be4f14a32e8))
* make pi provider events idempotent ([d1e2c3a](https://github.com/Necmttn/ax/commit/d1e2c3a64c83d3b0b39c61a3af8e6eb91d5123ec))
* namespace cursor local sessions ([0995321](https://github.com/Necmttn/ax/commit/099532103aa4035d76dc53af75c1535b44b9ca6a))
* narrow cursor event ids in tests ([0d8f3d2](https://github.com/Necmttn/ax/commit/0d8f3d2929ee4aa88e5fe50addb0392da9a231d8))
* **nix:** pin surrealdb to 3.1.0 via upstream tarball ([7c152a1](https://github.com/Necmttn/ax/commit/7c152a1f0fc0ffa8711b8ca3cf7e38fbaae12c73))
* preserve provider event and token continuity ([06e9067](https://github.com/Necmttn/ax/commit/06e9067340df61495fdd7b50d4b00c80662639c5))
* **recall:** bind scope param + narrow catch + cleanup ([05619be](https://github.com/Necmttn/ax/commit/05619be35a5c59a78b87870975d0449918b2470c))
* **recall:** total_count sums across all requested sources (R5) ([55db148](https://github.com/Necmttn/ax/commit/55db148ec839457570a54bf558f09f3445515116))
* **scope:** use record literal for repository filter (R1) ([8656805](https://github.com/Necmttn/ax/commit/8656805f8efb621fdd044c1a58d07fd7e4a81a17))
* **session-show:** catch DbError + drop misleading timestamp ([07529e0](https://github.com/Necmttn/ax/commit/07529e060921bd6a440812b60bf800d412a75024))
* **sessions-query:** bind repository param consistently ([e7bf082](https://github.com/Necmttn/ax/commit/e7bf082d4b362be19527361bda32e9c78fd32fbe))
* **sessions:** batch turn_count + first_user_message instead of correlated subselect (R11) ([40f6a38](https://github.com/Necmttn/ax/commit/40f6a38d408d830f80442688de10d0a449b55489))
* **site:** capitalize ADR title + comment content vs body distinction ([97eff97](https://github.com/Necmttn/ax/commit/97eff97e0bf8d669e695c7f1145632cee9769d92))
* **site:** code review cleanups for how-it-works page ([94dfaf9](https://github.com/Necmttn/ax/commit/94dfaf9c432f0ba3156aebddce7d51b569453842))
* **site:** code review cleanups for landing port ([e885a14](https://github.com/Necmttn/ax/commit/e885a14f341a5669657f54669b9f4b855686c4ca))
* **site:** code review cleanups for origin port ([d064312](https://github.com/Necmttn/ax/commit/d06431214414b2b77dafb2b326ca0c23e3be9e8f))
* **site:** document cloudflare config + add deploy:check dry-run ([97e262a](https://github.com/Necmttn/ax/commit/97e262abb1e81bfd9e48c497df7fffff4c6c222c))
* **site:** drop CSS capitalize + style markdown tables/hr ([a57c6b8](https://github.com/Necmttn/ax/commit/a57c6b8b4be15e96fafeec819f3e791ba31b880a))
* **site:** drop redundant async wrapper + forward-ref include ([3887c46](https://github.com/Necmttn/ax/commit/3887c4608a221c12ba7ba730d154ac64d0b66180))
* **site:** extractor parser + contract docs for stage rationale ([59626bb](https://github.com/Necmttn/ax/commit/59626bba6f63c4e13c8268602777fb7902d6c55a))
* **site:** restore em-dashes in TerminalFigure copy ([ef69507](https://github.com/Necmttn/ax/commit/ef6950797e2bb365999c5c112be45258582b8025))
* **site:** restore unicode em-dashes + smart quotes in origin port ([53e4064](https://github.com/Necmttn/ax/commit/53e4064d8f1a2fe397aab57bf6be6207647f88a9))
* **site:** wire dynamic stage rationale into how-it-works ([3ff7ac6](https://github.com/Necmttn/ax/commit/3ff7ac68e6a06b68f9bcba5ab7bc0a50c3cbda12))
* **skill-role:** use literal record ids + sweep stale edges + parse list-role fallback ([f277171](https://github.com/Necmttn/ax/commit/f277171effa9595976213ea09087aacf71dd0838))
* **skill:** replace ax commits search with ax recall --sources=commit (R2) ([22ded59](https://github.com/Necmttn/ax/commit/22ded593333617ebc40b17bf7a39fd061ba4b38c))
* **skills-classify:** drop unclassified filter in explicit mode ([1d68df0](https://github.com/Necmttn/ax/commit/1d68df07c6959b1c8d1c33945a044ecfe992147b))
* **skills:** validate role + skill names before record-literal embed (R3) ([aadbe50](https://github.com/Necmttn/ax/commit/aadbe50f9130036896badf590b0e894266ac4e59))
* support observed opencode schema ([1daabce](https://github.com/Necmttn/ax/commit/1daabce74c8f5be31352dfa80270384b6154bcd0))
* **test:** close brace placement in agent-accept.test.ts ([1489a7a](https://github.com/Necmttn/ax/commit/1489a7ad135cee650746744a826ca8729eb85f0b))
* tighten provider event payloads ([fd07b54](https://github.com/Necmttn/ax/commit/fd07b543639f9aa85413115b2b8f3915e1068df5))
* tolerate opencode message schema drift ([1c26717](https://github.com/Necmttn/ax/commit/1c2671706ec50217f05f85df23ad546ba9fdb825))
* update config fixtures for provider paths ([cfb17f8](https://github.com/Necmttn/ax/commit/cfb17f8a0297460ea0dc62ca25cf3199ad970b92))
* wire ingest here scoped command ([ca5711b](https://github.com/Necmttn/ax/commit/ca5711b5fe73e6718fe9e72e07dbd20114589ad1))


### Performance

* **improve:** lint stale-task scan pushes date filter into SurrealQL ([db72f28](https://github.com/Necmttn/ax/commit/db72f28e8a034cbb9c66d8dcee329c454b07b44b))

## [0.2.0](https://github.com/Necmttn/ax/compare/v0.1.1...v0.2.0) (2026-05-27)


### Features

* add checkout git insight views ([8c9f7ad](https://github.com/Necmttn/ax/commit/8c9f7add09934548bf9f83b72d1839bcfc84fb1d))
* add cli version and update commands ([79403cc](https://github.com/Necmttn/ax/commit/79403cc6dbacc6afcd97effbba6ffb627b9ffdf8))
* add dashboard query workbench ([dcc4c21](https://github.com/Necmttn/ax/commit/dcc4c2151c4845192216ff9e1053b234bc43eb2f))
* add dashboard serve command ([a631784](https://github.com/Necmttn/ax/commit/a63178453b531e3bc6001eeb8255173c4c2dec22))
* add dashboard web shell ([93ed957](https://github.com/Necmttn/ax/commit/93ed957a2f53cdcb9f3964c2f081444cbe102afb))
* add delivery telemetry schema ([3a811e1](https://github.com/Necmttn/ax/commit/3a811e1112fdd4000a34dcf8cfed4ca49ccd6635))
* add dogfood agent presets ([fa316db](https://github.com/Necmttn/ax/commit/fa316dbf16a79b7bebbaea296a15911292014120))
* add dogfood success criteria ([27aa023](https://github.com/Necmttn/ax/commit/27aa023a0e3b4211c9b1071f868d93824cac9b73))
* add evidence dashboard ([f2214ff](https://github.com/Necmttn/ax/commit/f2214ff6f6a4e7fef54defb82cfc0a2cd6cdc262))
* add evidence graph insights queries ([4c5f95c](https://github.com/Necmttn/ax/commit/4c5f95cd413c58f27835b55ae92f1fdc694f99df))
* add evidence graph writers ([f75ac27](https://github.com/Necmttn/ax/commit/f75ac27163cf5ed3d6313bbf5655310f10609d52))
* add graph explorer api ([387d60f](https://github.com/Necmttn/ax/commit/387d60f172b2169c1b0d18bbba3cbd98b5c7a050))
* add graph explorer dashboard ([02fa561](https://github.com/Necmttn/ax/commit/02fa5614278c3225817fe8f8882f23b8d2ec4a21))
* add graph health insight queries ([a644e81](https://github.com/Necmttn/ax/commit/a644e81dbe151c6b2dac4be64504752efa533204))
* add graph record key helpers ([f920076](https://github.com/Necmttn/ax/commit/f920076d89bb8c062d15ac709ef64185480cc4fb))
* add graph session story cards ([eb5b3fc](https://github.com/Necmttn/ax/commit/eb5b3fc072cea24e8737d72eec7dc364caf72f65))
* add harness doctor foundation ([5330ee8](https://github.com/Necmttn/ax/commit/5330ee88bbdbb4de52af89720023b710ba4285eb))
* add ingest pipeline progress ([ac652fd](https://github.com/Necmttn/ax/commit/ac652fd9b6422e396e09b111cc40b165d556d10b))
* add ingest telemetry records ([6dc373d](https://github.com/Necmttn/ax/commit/6dc373d490a9f39c19a0e0a0088694c7660ee444))
* add install onboarding guidance ([7c1a77e](https://github.com/Necmttn/ax/commit/7c1a77e996781127f8a8a3426bec099e7930787a))
* add interactive wterm dogfood mode ([d6341ce](https://github.com/Necmttn/ax/commit/d6341cecb3e4a36b4b8870fbfd0b2d5734af235e))
* add learning registry and onboarding loop ([6227baf](https://github.com/Necmttn/ax/commit/6227baf20a2c18c325517087c8de1973f7af2c7b))
* Add nix packaging ([#79](https://github.com/Necmttn/ax/issues/79)) ([ccdcf2f](https://github.com/Necmttn/ax/commit/ccdcf2f74b9900792f0f18013a182ae5200d8167))
* add pty transport for wterm dogfood ([4b9c820](https://github.com/Necmttn/ax/commit/4b9c820605b439a14b20049d054b6e12be7c8276))
* add self-improve json commands ([d67aa56](https://github.com/Necmttn/ax/commit/d67aa5608f5fc6e0d0586cc9854798ef2fec1b21))
* add tool call normalization helpers ([c39ff8a](https://github.com/Necmttn/ax/commit/c39ff8ac9ab3ed73dcb8c603951fefc95978be80))
* add wterm dogfood setup harness ([9cd5ee5](https://github.com/Necmttn/ax/commit/9cd5ee5e63fd67f65a08014402021d7160029ce9))
* agentctl v0 — skills, claude + codex transcript ingest, CLI ([5d4a81f](https://github.com/Necmttn/ax/commit/5d4a81f81a53a90c195c533b2e5547f70588cf55))
* body column on skill ([#2](https://github.com/Necmttn/ax/issues/2)) ([#10](https://github.com/Necmttn/ax/issues/10)) ([5e932c2](https://github.com/Necmttn/ax/commit/5e932c2f97620dc3ca3e1483dedf2719bd6d0a66))
* centralize graph record ids ([43e59a5](https://github.com/Necmttn/ax/commit/43e59a58152a815e7f6f70f3bc776fc3b509230f))
* **ci:** table-coverage gate — every writer requires a reader (Phase D) ([4027070](https://github.com/Necmttn/ax/commit/4027070ce8dad93ab66f11f15465748b48e20bd8))
* classify ask and feedback signals ([1ecaaf1](https://github.com/Necmttn/ax/commit/1ecaaf18b0b037cd0405a0b0958700364f9c5e4d))
* **cli:** ax improve reset --yes (UAT teardown helper) ([96dcf95](https://github.com/Necmttn/ax/commit/96dcf957c2f198b30b8a854fa1e75fcef5b8f3ab))
* **cli:** axctl improve accept (scaffolds SKILL.md) + reject (Phase C3+C4) ([f96d181](https://github.com/Necmttn/ax/commit/f96d181a8c1fc22c2cdd6a0f731a8a8c859fee85))
* **cli:** axctl improve list/show (Phase C2) ([aae9bc9](https://github.com/Necmttn/ax/commit/aae9bc9b759b48d620b075e53ad21d17014ef983))
* composite taste score ([#18](https://github.com/Necmttn/ax/issues/18)) ([#28](https://github.com/Necmttn/ax/issues/28)) ([2e4dba5](https://github.com/Necmttn/ax/commit/2e4dba553427ab6f57fe3e0ce565365a22681a66))
* **context:** file-context pack query layer ([5334a68](https://github.com/Necmttn/ax/commit/5334a681ab6f5f82a8a2390b69505a3ac2c52517))
* **daemon:** chain derive-signals after watcher ingest + daily ETL plist ([8e0a7f6](https://github.com/Necmttn/ax/commit/8e0a7f6f8d65b15fa8e58957071b38374a5a5352))
* **dashboard:** /api/improve endpoint for experiment loop (Phase C10) ([dce0188](https://github.com/Necmttn/ax/commit/dce018898bd7be35c9ccc417088aec3790517dc8))
* **dashboard:** /improve React route + accept/reject/verdict POST endpoints (Phase C10 full) ([ca0e456](https://github.com/Necmttn/ax/commit/ca0e45673c2fce7766b05924b2b3b3691025df8a))
* **dashboard:** group subagents under hydrated parent stubs ([2ed2a12](https://github.com/Necmttn/ax/commit/2ed2a12d16b5c100592ed07d67e008579499d84c))
* **dashboard:** hydrate out-of-window parent stubs in /api/sessions ([04fa327](https://github.com/Necmttn/ax/commit/04fa327b6730958505863ab5e34069c7b5361715))
* **dashboard:** inline filter + jump bar on session inspector ([09cf8d4](https://github.com/Necmttn/ax/commit/09cf8d48ce415ee4675a98de5baff481085b4f2e))
* **dashboard:** inspect Codex transcripts ([3198fea](https://github.com/Necmttn/ax/commit/3198fea7bc0a1f8d5e347b3a1e2330f5760a2d64))
* **dashboard:** inspect surfaces children spawned from this session ([a1741d1](https://github.com/Necmttn/ax/commit/a1741d1b27d8a6022920c8d35200e4b787ba7d30))
* **dashboard:** mount session inspector with deep-link to turns ([0b9225f](https://github.com/Necmttn/ax/commit/0b9225f8262221b9424dc03ecc2ee4d44045ba7e))
* **dashboard:** prefetch on intent + expandable full brief ([37040fe](https://github.com/Necmttn/ax/commit/37040fe5f668e90f234409be4aaf5100a5c04760))
* **dashboard:** sessions index with link to inspector ([5cbe5eb](https://github.com/Necmttn/ax/commit/5cbe5ebc993b7dcdd563c8bacf358e68ff0e7c06))
* **dashboard:** SPA lazy-loads subagent children on row expand ([362d0c0](https://github.com/Necmttn/ax/commit/362d0c07aec6d0e5c1717705f1a2abd37723cc9e))
* **dashboard:** spawn marker shows agent_type / effort / fork / brief ([4c417c0](https://github.com/Necmttn/ax/commit/4c417c0b6c2c58d314c5d1fe55508613d0eda053))
* **dashboard:** splice hook_fire decisions into inspector turn stream ([2dd947f](https://github.com/Necmttn/ax/commit/2dd947f9ee1e0a41e10b7a65b0b95b647a8f9522))
* **dashboard:** subagent accordion + fix broken session links ([39607f1](https://github.com/Necmttn/ax/commit/39607f1f663d12a84a1bf252aab52bf0a516d6a3))
* **dashboard:** subagent_task kind + parent link in inspector ([cac143f](https://github.com/Necmttn/ax/commit/cac143f6dff79bba6cbd3e39de40a6659865d1cd))
* **dashboard:** tree-shaped /api/sessions with lazy children endpoint ([1e6aeb8](https://github.com/Necmttn/ax/commit/1e6aeb8c20e5bcbd3409a21eec54632a4aebf1d9))
* **dashboard:** whole-row click toggles skill evidence ([92417ac](https://github.com/Necmttn/ax/commit/92417acaeaa7afcee3f7b61cc89f4b02373aa5f8))
* **db:** extract chunked statement executor seam ([59e2070](https://github.com/Necmttn/ax/commit/59e2070aa8ada8d94d64967e266ff4deab9d05b8))
* derive closure quality and skill candidates ([83ecb39](https://github.com/Necmttn/ax/commit/83ecb39fb5a227fc8b60b3dc5073251c7e425cf9))
* derive command outcomes and user language ([cfe97a4](https://github.com/Necmttn/ax/commit/cfe97a41177439688a268aca274dda2f8cc74305))
* derive correction + proposed signals ([#5](https://github.com/Necmttn/ax/issues/5)) ([#12](https://github.com/Necmttn/ax/issues/12)) ([a5233e0](https://github.com/Necmttn/ax/commit/a5233e025d0fcd69ae837b6edf6af1f989ee6a94))
* derive delivery outcome scores ([284e808](https://github.com/Necmttn/ax/commit/284e808496ae2ebe569ac8a7597bd8b51e33720f))
* derive self-improve signals ([1df0d13](https://github.com/Necmttn/ax/commit/1df0d138f0eccd4237c46cfa4b932646e385ab08))
* derive session phase timing ([14ed9af](https://github.com/Necmttn/ax/commit/14ed9af90f249362b676b7b5d0872028ce56c3c5))
* derive session token and workflow health ([aa1c9c0](https://github.com/Necmttn/ax/commit/aa1c9c03227d77b9f71cc7a3b3b0db99ea5c5970))
* derive weekly guidance ([a55134e](https://github.com/Necmttn/ax/commit/a55134ec1866e4276f4e9b046b5d94766593d35e))
* detect git mainline promotion ([1d8d10c](https://github.com/Necmttn/ax/commit/1d8d10c9b8927e5117f2cbd394ab6256307e046d))
* **dissect:** tag Codex developer-preamble blocks as system_context ([1323ebc](https://github.com/Necmttn/ax/commit/1323ebc755e62f1885071125f2adf7b0d903d3e4))
* **dogfood:** dogfood_run table + axctl dogfood runs (Phase C12) ([cfbc596](https://github.com/Necmttn/ax/commit/cfbc596991992fb428350afd56f1acefa7bfa202))
* Effect v4 refactor (foundation) ([#8](https://github.com/Necmttn/ax/issues/8)) ([ae8b4b2](https://github.com/Necmttn/ax/commit/ae8b4b2b427d6d6b522e03885abc4a9b45142b23)), closes [#1](https://github.com/Necmttn/ax/issues/1)
* enrich git graph relations ([981c8a4](https://github.com/Necmttn/ax/commit/981c8a4fa085375d81b0b1f8dc6f2d906f35c900))
* extend graph schema for agent evidence ([7948f1c](https://github.com/Necmttn/ax/commit/7948f1ca795da74c274a93df207b7f91b26338ce))
* git ingest — commits + file touches per repo ([#17](https://github.com/Necmttn/ax/issues/17)) ([#24](https://github.com/Necmttn/ax/issues/24)) ([76197db](https://github.com/Necmttn/ax/commit/76197db08fd61f57cbb3af7437a6a13cb562dba8))
* **graph-query:** introduce shared resolver helpers for SurrealDB reads ([3510c57](https://github.com/Necmttn/ax/commit/3510c57dea7f53219da9d978be478c23de28b34c))
* harden cli install and daemon ops ([3be1c28](https://github.com/Necmttn/ax/commit/3be1c28c67da3c8da91451d16c5cfed55f3b1d6d))
* **hooks:** file-memory v2 + session inspector + intent classifier ([5632e67](https://github.com/Necmttn/ax/commit/5632e6789b2a56e0bc6e5b4bcd62bb5eed370616))
* **hooks:** ingest native harness evidence ([e91f03a](https://github.com/Necmttn/ax/commit/e91f03a0fedbfcdb8f3b18a8910570f79a46ce66))
* import legacy self-improve artifacts ([512032f](https://github.com/Necmttn/ax/commit/512032f065950ea7965548316d0c6cb69bb62965))
* improve codex ingest progress ([4f6bd43](https://github.com/Necmttn/ax/commit/4f6bd4308314a5eb23b6046d0f01fea4b6eeb185))
* **improve:** ax retro reflect + accept --with-agent ([d7009c3](https://github.com/Necmttn/ax/commit/d7009c3348d167ccc40b25767bfcbdbcd9938c32))
* **improve:** C5a was_addressed detector + CI gate self-test ([7bb187b](https://github.com/Necmttn/ax/commit/7bb187b032f46c44b2c084d80322f4655acfab34))
* **improve:** checkpoint + verdict loop (Phase C6+C7+C8) ([785c395](https://github.com/Necmttn/ax/commit/785c39589cc606843a7605807f0b70994f881169))
* **improve:** harness report -&gt; guidance proposals (Phase C11) ([93a2a64](https://github.com/Necmttn/ax/commit/93a2a648f6223be6ddc00b27830ab3370635c647))
* **ingest:** --stages= and --derive-only for partial ingest runs ([eb9a72b](https://github.com/Necmttn/ax/commit/eb9a72b9983083c26caeec8c6ad6097fe80b192e))
* **ingest:** canonical derive-keys shared module ([50dd0cf](https://github.com/Necmttn/ax/commit/50dd0cf3e3930c1fe9221804c03932b1e4b47425))
* **ingest:** canonical stage dependency registry ([a78c9d0](https://github.com/Necmttn/ax/commit/a78c9d028d85047e7d16cd66b879f0c1333de1b3))
* **ingest:** classify turn intent and extract file/symbol/error references ([d057934](https://github.com/Necmttn/ax/commit/d057934a569ac5e5d26aa7bb467966baa571296a))
* **ingest:** classify turn message_kind and store full text ([1d62ad2](https://github.com/Necmttn/ax/commit/1d62ad28675a99e6492723b8357247068bbf8405))
* **ingest:** dependency-graph pipeline scheduler ([a512ee8](https://github.com/Necmttn/ax/commit/a512ee8ce1019e098bab92cfd99dea7c25a336bc))
* **ingest:** derive task_label + turn counts in session-health stage ([5e66c03](https://github.com/Necmttn/ax/commit/5e66c038f4fe761f88c202fb21aa33bbe3566de0))
* **ingest:** derive-opportunities stage (Phase C5) ([c44cca9](https://github.com/Necmttn/ax/commit/c44cca937048f0db53bb585f4e80c62544a22d14))
* **ingest:** derive-proposals stage (skill form) (Phase C1) ([0eebefc](https://github.com/Necmttn/ax/commit/0eebefcb61868577ccbdab2afeada83483b8ceb0))
* **ingest:** git stage reports per-repo progress ([ac08ba9](https://github.com/Necmttn/ax/commit/ac08ba94e39dcf2e3908fac4c7f3debc8d4068bc))
* **ingest:** record file evidence on tool calls (read/search) ([36c7eab](https://github.com/Necmttn/ax/commit/36c7eabb7532a9b95e76a6eef759f59b3b514424))
* **ingest:** stage subgraph selection tolerant of external deps ([957361b](https://github.com/Necmttn/ax/commit/957361b3cd77904af0e3585f8c696c9fb028d12e))
* inject file session lens into context ([58ea62e](https://github.com/Necmttn/ax/commit/58ea62e7c586de8b59ee96fc24a7a852c8e6c3fe))
* **install:** seamless auto-install of pinned SurrealDB ([36b2008](https://github.com/Necmttn/ax/commit/36b200897a7af50efc0580daea0eddfd954d7fb1))
* launchd WatchPaths plist for incremental ingest ([#6](https://github.com/Necmttn/ax/issues/6)) ([#9](https://github.com/Necmttn/ax/issues/9)) ([ae55929](https://github.com/Necmttn/ax/commit/ae55929331dda776f7e3b9ca0ab9f1d14eb54533))
* link git ingest to repositories and checkouts ([6954ed5](https://github.com/Necmttn/ax/commit/6954ed5d8a135943fb4c5afef9327a867a74ceb6))
* live TUI updates via SurrealDB live queries ([#22](https://github.com/Necmttn/ax/issues/22)) ([#27](https://github.com/Necmttn/ax/issues/27)) ([7b89211](https://github.com/Necmttn/ax/commit/7b8921193dddfd91a0cca69d92aff07b85346a4c))
* **nix:** switch flake to bun2nix for cross-platform deps ([#80](https://github.com/Necmttn/ax/issues/80)) ([a16c2c8](https://github.com/Necmttn/ax/commit/a16c2c891e98c9d42d264b8f37d6a4ffd42c8560))
* normalize agent plan snapshots ([db25bd5](https://github.com/Necmttn/ax/commit/db25bd554de0b357bb306f82b821b133e73bcc16))
* normalize pull request review signals ([395ba4b](https://github.com/Necmttn/ax/commit/395ba4bc4361e31a746f8264d2ba924d26671fb3))
* OpenTUI dashboard ([#4](https://github.com/Necmttn/ax/issues/4)) ([#14](https://github.com/Necmttn/ax/issues/14)) ([fe99f66](https://github.com/Necmttn/ax/commit/fe99f66e2e5dbb6bd968ed41e59bc647f397244b))
* **opportunities:** form-aware was_addressed detection ([5061524](https://github.com/Necmttn/ax/commit/5061524f78781000418e6f2d7df36ac005ba3fa0))
* **ops:** weekly launchd agent for experiment-loop checkpoint (Phase C9) ([a984e15](https://github.com/Necmttn/ax/commit/a984e15b02625bd1b124386300e9f3d18c55cd54))
* persist harness doctor evidence ([95dac43](https://github.com/Necmttn/ax/commit/95dac43b0b8ab93372f9c1c15c813130b47c9bec))
* persist self-improve guidance ([d96a76f](https://github.com/Necmttn/ax/commit/d96a76fea1ea7eb24f119ba9ce2479b2354ca212))
* **project:** add context and verify commands ([7e6dcfb](https://github.com/Necmttn/ax/commit/7e6dcfbcd32cf3801ad39ac6a89188c814139181))
* **project:** add diagnostics adapter ([f450e29](https://github.com/Necmttn/ax/commit/f450e29bce6ee94f4bed8cc8f6180458f7dc5886))
* **project:** add grounding types ([6d5caa9](https://github.com/Necmttn/ax/commit/6d5caa923e17b524a3b708dbd5cb50f0a0f6000e))
* **project:** build grounding payloads ([e3c88d3](https://github.com/Necmttn/ax/commit/e3c88d3b65dbf5fa98d9a6d5ebe38297293cb87d))
* **project:** collect git state ([ff771fb](https://github.com/Necmttn/ax/commit/ff771fb31b54b8f9d4c9aadbafe8bd4315d3ff68))
* **project:** derive verification checks ([ba38fdd](https://github.com/Necmttn/ax/commit/ba38fdd0f49e3be46305bba676763de144fee2e4))
* **project:** detect stack and instructions ([775a6ec](https://github.com/Necmttn/ax/commit/775a6ec4bfda700ed9f7cd63919019fd46339b50))
* **queries:** runQuery executors over the typed Query seam ([024e211](https://github.com/Necmttn/ax/commit/024e211db1d1ec5b60788ab88ef1e0aaea4716b5))
* **queries:** typed Query+mapper pairing ([b6d2ac1](https://github.com/Necmttn/ax/commit/b6d2ac1c30e6ef662f964310723b8e2ccb20718d))
* rebrand agentctl to ax ([6657562](https://github.com/Necmttn/ax/commit/6657562bfbbd2a530863f13f50156c87b2bc20d2))
* **retro:** cluster correction pressure + friction kinds ([7362057](https://github.com/Necmttn/ax/commit/736205777e01baea1d854a801b6d1c378078e1b0))
* **retro:** experiment_status + checkpoint schema fix ([96e55d3](https://github.com/Necmttn/ax/commit/96e55d334bce4d5757b2d42d5133e85a0ed46db5))
* **retro:** meta investigation substrate for external AI agents ([691b6da](https://github.com/Necmttn/ax/commit/691b6dab7ab3092c67c33c8077e5003486d5ad21))
* **retro:** retro table + ax retro emit/list + Stop hook recipe (Path B foundation) ([ee17fd1](https://github.com/Necmttn/ax/commit/ee17fd1e3698e1ead7064ffde50d6c81c831cd34))
* **schema:** drop 15 orphan tables, add experiment-loop schema (Phase B) ([1f8fec6](https://github.com/Necmttn/ax/commit/1f8fec698d1ad3b43a1edd4328a7d35e8072b01e))
* search FTS via SurrealDB BM25 analyzer ([#21](https://github.com/Necmttn/ax/issues/21)) ([#26](https://github.com/Necmttn/ax/issues/26)) ([22d20cb](https://github.com/Necmttn/ax/commit/22d20cb89ddd03fd212ddc0d998ed9611c4de4ca))
* self-improve weekly ingest + deprecate hook ([#7](https://github.com/Necmttn/ax/issues/7)) ([#11](https://github.com/Necmttn/ax/issues/11)) ([21b277f](https://github.com/Necmttn/ax/commit/21b277fb69c5f6df84fa6f85158bc6cda5860fd9))
* **shared:** shared typed row-field extractors ([77c7226](https://github.com/Necmttn/ax/commit/77c7226bdcb94dc7964383b76fc10454ae6d6f74))
* show codex ingest file sizes ([85acd8a](https://github.com/Necmttn/ax/commit/85acd8abf8d4170c1085f64df9bea40a8224cd0c))
* show early ingest progress ([8204f06](https://github.com/Necmttn/ax/commit/8204f06499f973640d524aa9fceae31f2e3b0013))
* show self-improve guidance in dashboard ([c9730d2](https://github.com/Necmttn/ax/commit/c9730d2333f39e1b26d7edfb4239a679b8c015ff))
* single-binary install — `agentctl install/uninstall` + bun --compile ([10aa98d](https://github.com/Necmttn/ax/commit/10aa98d5f131c998fd1921f7ed33e8dfd38f9dcf))
* skill_pairs + skill_after_error signals ([#19](https://github.com/Necmttn/ax/issues/19), [#20](https://github.com/Necmttn/ax/issues/20)) ([#25](https://github.com/Necmttn/ax/issues/25)) ([65ef824](https://github.com/Necmttn/ax/commit/65ef8247c59f7f9a042db94381e24c89796ae7c6))
* **skill:** ax-retro — user-facing experiment-loop retrospective ([f949412](https://github.com/Necmttn/ax/commit/f949412ebc5e661e4da9f8ddc299d6241637da4a))
* **skills:** add ax retro workflow ([114ec1b](https://github.com/Necmttn/ax/commit/114ec1b51d197ef058fde7efae798fe12410d67a))
* slim CLI + /api/version + version-aware studio + ASCII serve banner ([95ea5ad](https://github.com/Necmttn/ax/commit/95ea5adbfbcee4c573f2ed9577ea356524192f52))
* stream codex ingest batches ([3ed9a60](https://github.com/Necmttn/ax/commit/3ed9a604390e908abb8852b79072c03367046c0f))
* stream dashboard events ([593a7d9](https://github.com/Necmttn/ax/commit/593a7d9066384658cd98d1a54161e786c1615d25))
* stream ingest progress counts ([85f6f33](https://github.com/Necmttn/ax/commit/85f6f33dc1c545e3160ad9ca3674b0f422d75142))
* surface duplicate relation health ([4ca8ee3](https://github.com/Necmttn/ax/commit/4ca8ee371a44acb5279b905b5efb316848cfc636))
* **surql:** promote literal toolkit + universal value encoder ([1b5492f](https://github.com/Necmttn/ax/commit/1b5492f2c83ad9b6bf6aba249c3d0b2bbb8ed194))
* SurrealDB file buckets for transcript snapshots + codex artifacts ([#13](https://github.com/Necmttn/ax/issues/13)) ([3f31d9d](https://github.com/Necmttn/ax/commit/3f31d9dffb275245a6ddd7bfd25bbf3f75b59961)), closes [#3](https://github.com/Necmttn/ax/issues/3)
* tidy CLI, skill source view, and catalog name resolver ([5fb0edd](https://github.com/Necmttn/ax/commit/5fb0edd831a34a80928ead18cb1f0a5be0afba1e))
* unify transcript graph ids ([2acf068](https://github.com/Necmttn/ax/commit/2acf0683be9cdd9c9187a6c117cd5bcfd0baddc7))
* use collision-safe skill ids ([3f54ea7](https://github.com/Necmttn/ax/commit/3f54ea79ff9027e8ea48ff5ee004cb7c628f708a))
* **wrapped:** add dashboard route ([c8d1d11](https://github.com/Necmttn/ax/commit/c8d1d11e043cabb553c76da2d4267b8d6d6788fb))
* **wrapped:** add profile queries ([db8b495](https://github.com/Necmttn/ax/commit/db8b49539bfcb67e6d39c2c5fcbc9ff269884e57))
* **wrapped:** add shared profile types ([f581db4](https://github.com/Necmttn/ax/commit/f581db430905491df16c4965aa84ef88c1af30e3))
* **wrapped:** expose dashboard api ([0fbd8cc](https://github.com/Necmttn/ax/commit/0fbd8cc09f41f5bba55afe487e502b86576bf161))
* **wrapped:** expose sharper interesting facts ([b922679](https://github.com/Necmttn/ax/commit/b922679f8f3812242ad5b450e75c00e3e90518f0))
* **wrapped:** score local agent profile ([ebfbeac](https://github.com/Necmttn/ax/commit/ebfbeac18610a4c378dbd315f256c0f0976bf79c))
* write Claude transcript evidence graph ([a24d293](https://github.com/Necmttn/ax/commit/a24d293f67c6f3ad29023c1990aed87a6b3d5f67))
* write Codex evidence graph records ([77a7bce](https://github.com/Necmttn/ax/commit/77a7bce2dc3417fcb142953ce5779ff00969d852))


### Bug Fixes

* accept release checksum asset paths ([02dc659](https://github.com/Necmttn/ax/commit/02dc659820e11cb3b615a47daa8e65d84432ca58))
* avoid anonymous claude tool call collisions ([bf9b7cc](https://github.com/Necmttn/ax/commit/bf9b7cc48e4db2e3e6c4a0d03c991e1fa7c4be93))
* batch codex skill relations ([91deca0](https://github.com/Necmttn/ax/commit/91deca0de09765093a4fb074b11be11b8b2de5f8))
* **bin:** resolve symlinks so ln -s install works ([0aca6a4](https://github.com/Necmttn/ax/commit/0aca6a42ef805ba841f60dfaaecc4451de830261))
* bound codex raw snapshots ([383e6cb](https://github.com/Necmttn/ax/commit/383e6cbc078c6e6a1523bc0fed4fb52b32649f3a))
* classify codex builtin tools ([57ec16a](https://github.com/Necmttn/ax/commit/57ec16a6f8965d2e8e60e0c3fb060d2381a79cdb))
* clean legacy plan item conflicts ([89e6ff6](https://github.com/Necmttn/ax/commit/89e6ff6c832e3ce5fbfff1a413439b4b60ef500e))
* **cli:** hardening - input validation, error UX, output bugs ([#55](https://github.com/Necmttn/ax/issues/55)) ([4027587](https://github.com/Necmttn/ax/commit/40275878d6a866906afbd38086f3e9035780f893))
* **cli:** reject --insights-only combined with other -only flags or --since ([7507414](https://github.com/Necmttn/ax/commit/7507414c7a98e0ad1911efcb1447891a9eae4445))
* **cli:** unknown commands skip db connect; clearer recovery hint ([0c90d46](https://github.com/Necmttn/ax/commit/0c90d46c0ca64fb6be17ace4c52fdab87178850b))
* **cli:** update stale error messages for renamed skill commands ([1b3775a](https://github.com/Necmttn/ax/commit/1b3775aa4824c7cb5069dc5f63dbfad9a9d49f74))
* count streamed codex records in progress ([2e8bac5](https://github.com/Necmttn/ax/commit/2e8bac574c9ac81effaff518f1b730d6b3d3198e))
* cover codex tool call normalization gaps ([f55aea8](https://github.com/Necmttn/ax/commit/f55aea8a8fedd82f360a382dc5db4e885c66c8cd))
* **daemon:** raise SurrealDB FD soft cap to 8192 in launchd plist ([b4d9823](https://github.com/Necmttn/ax/commit/b4d98237b3eb5e91385c0e1495132c45caa11665))
* **dashboard/recall:** preserve window semantic, harden total_count fallback, add clamp max boundary tests ([c2347ec](https://github.com/Necmttn/ax/commit/c2347ec983abfe81bcd3f9dbaceb4b8bf60135d8))
* **dashboard:** resolve subagent transcript via raw_file on session row ([b06b7da](https://github.com/Necmttn/ax/commit/b06b7da510020335902f1615979d612b76a9b7b8))
* **dashboard:** serve built assets from compiled cli ([feece0e](https://github.com/Necmttn/ax/commit/feece0ef33200236e5fa1f367289ed755f6b46d3))
* **db:** connect timeout + transaction conflict retry ([#35](https://github.com/Necmttn/ax/issues/35), [#39](https://github.com/Necmttn/ax/issues/39)) ([#54](https://github.com/Necmttn/ax/issues/54)) ([3e53a6a](https://github.com/Necmttn/ax/commit/3e53a6a76af4d044f8a63ea951816a5f8afef40e))
* **ingest:** cwd null coalesce + ingest .claude/commands as scope='command' skills ([#56](https://github.com/Necmttn/ax/issues/56)) ([ef76143](https://github.com/Necmttn/ax/commit/ef761432cddd7578a2f1351dc40a984b8e81b6d7))
* **ingest:** drop noise proposal — risky_session_count was every session ([c056275](https://github.com/Necmttn/ax/commit/c05627579d2810e1b85186edb2bdbcabc6d30cfe))
* **ingest:** honest row types — drop phantom null from DB-row interfaces ([#78](https://github.com/Necmttn/ax/issues/78)) ([dc34b86](https://github.com/Necmttn/ax/commit/dc34b86062b1f95de86c804b5961090773acf877))
* **ingest:** shared surql seam strips lone surrogates that crash SurrealDB parser ([dcfb4b8](https://github.com/Necmttn/ax/commit/dcfb4b869f7c41db7c6bc021239577139f20a7d1))
* **install:** uninstall accuracy + ANSI strip + cold-vs-warm feedback ([#53](https://github.com/Necmttn/ax/issues/53)) ([22eebd9](https://github.com/Necmttn/ax/commit/22eebd9a36f94cb3bf1d0be49c6710c0a81bd8d4))
* keep checkout context on git evidence edges ([8a72e45](https://github.com/Necmttn/ax/commit/8a72e456381caf9ce9a37d708dfd662572f55310))
* keep plan item identity sequence-scoped ([781c4c8](https://github.com/Necmttn/ax/commit/781c4c8a67ff66ddbd4570049068d3c1e5f9d1b3))
* make intervention show query usable ([fa524a9](https://github.com/Necmttn/ax/commit/fa524a960ad730f6617e1332a9bf451906bba8ec))
* make new CLI queries surrealdb compatible ([db99576](https://github.com/Necmttn/ax/commit/db995768a800a50e188ab6161e08f87a6c634e63))
* make transcript graph edges idempotent ([9899b29](https://github.com/Necmttn/ax/commit/9899b29e811afe74d46a4c84321f7bfa9e7d65d3))
* mark staged graph modes explicitly ([d000715](https://github.com/Necmttn/ax/commit/d00071542126ea919f63b54a3142e78cbdde11f9))
* **nix:** refresh bun-deps hash + auto-refresh on release PRs ([10266c7](https://github.com/Necmttn/ax/commit/10266c781c254c573ac749e6ce094e4874c10a30))
* parse transcript plan payloads ([ee4f3c5](https://github.com/Necmttn/ax/commit/ee4f3c58113b750272778b860fc4105e226fc987))
* preserve skill metadata in evidence writers ([019d96f](https://github.com/Necmttn/ax/commit/019d96f04fb6d83fd85a198ea85779bd60a93c74))
* **project:** harden diagnostics config parsing ([4d86b79](https://github.com/Necmttn/ax/commit/4d86b79bcbc782e0bf3d9115e7cd2854e2a154c6))
* **project:** harden git state parsing ([bf42706](https://github.com/Necmttn/ax/commit/bf4270633fc2f72f57861aa023dff470bd7ff634))
* **project:** harden stack detection ([615d723](https://github.com/Necmttn/ax/commit/615d72357dc0ea2f7aa32f70bfbcb44e44b4e561))
* **project:** parse git status as nul records ([49d12af](https://github.com/Necmttn/ax/commit/49d12af6572db932c1ddc3a65caf3c9c96c60ab8))
* **project:** respect package manager in checks ([5a25296](https://github.com/Necmttn/ax/commit/5a25296335f3d3e14c83c07d445b5bec0825907f))
* promote git nodes to stable repo identity ([43ca086](https://github.com/Necmttn/ax/commit/43ca0863cb9d4de535c2819e568215c15ed094cf))
* prune duplicate git graph edges ([e1f80e5](https://github.com/Necmttn/ax/commit/e1f80e502a47f3398bbc3d09b4946b217edc95bd))
* reduce graph label noise ([c29b970](https://github.com/Necmttn/ax/commit/c29b970e205d9a480fd966733e3abadf7e990a59))
* report claude ingest record throughput ([bb39117](https://github.com/Necmttn/ax/commit/bb391176a72ad229aae248938c82517a00fd9582))
* report codex final record throughput ([361cb1d](https://github.com/Necmttn/ax/commit/361cb1d2da19458345b5a69403ddd2e6c8f51f8c))
* **retro:** plan --leave-open + verdict disambiguates ignored vs no_longer_needed ([f6d3423](https://github.com/Necmttn/ax/commit/f6d342385ba35aacb539acfedf4469272d2971f5))
* **review:** address impl review findings (Phase D follow-up) ([ce8ce77](https://github.com/Necmttn/ax/commit/ce8ce774ff761095d4df5fb742d1495bd52a6f57))
* route ingest logs through effect ([5f2e64c](https://github.com/Necmttn/ax/commit/5f2e64cfd57bf084c08f406c18193a40506e08f8))
* scope git evidence links by repository ([dd5bf1a](https://github.com/Necmttn/ax/commit/dd5bf1aac5e4bd14d761620e5a1cc70e25c1af0a))
* show session intent in graph ([59412a7](https://github.com/Necmttn/ax/commit/59412a79d10cffa43f7ed036afb25e5fcd8ebca4))
* skip all-time skill pairs in since derivation ([1af1d2c](https://github.com/Necmttn/ax/commit/1af1d2c777aa4880d83228d0d7dfda631fa87391))
* speed up dashboard skills load ([5a0da94](https://github.com/Necmttn/ax/commit/5a0da9429d8d47f752cd11042df6a6d0ab069b99))
* stabilize graph edge ids ([ba62b25](https://github.com/Necmttn/ax/commit/ba62b2584911a32dff7fcc1661fed70f53cf6841))
* stabilize pipeline progress rendering ([fd2b3b9](https://github.com/Necmttn/ax/commit/fd2b3b95a82bbabc93534e8dfacb5945771164b3))
* **surql:** coerce nullish input + catch undefined excerpts in recovered_by ([e0982c6](https://github.com/Necmttn/ax/commit/e0982c6d2fd2e26d6bebf8efc772e78bcf6d71e9))
* **tui:** add JSX namespace reference for typecheck on main ([2b3507a](https://github.com/Necmttn/ax/commit/2b3507acf99ef86dec11541ef5a07c14aeca9865))
* **tui:** perf regression + error copy + col widths ([#33](https://github.com/Necmttn/ax/issues/33), [#49](https://github.com/Necmttn/ax/issues/49), [#52](https://github.com/Necmttn/ax/issues/52)) ([#57](https://github.com/Necmttn/ax/issues/57)) ([ca15cd2](https://github.com/Necmttn/ax/commit/ca15cd26425cf3ed6af23a00c2a4bf399c1da42f))
* **types:** clear tsc errors under exactOptionalPropertyTypes ([6678cb6](https://github.com/Necmttn/ax/commit/6678cb6c5abfc97f5a014a5b539a59f1ab166aa2))
* upsert existing skill names ([e345843](https://github.com/Necmttn/ax/commit/e345843c6171c2fba340cbc1951ea439c0ab24ce))
* use local identity for transcript edit files ([6529db1](https://github.com/Necmttn/ax/commit/6529db1d78fe04f481474527561f694c027ef000))
* **watcher:** add ~/.bun/bin to launchd PATH ([f83897a](https://github.com/Necmttn/ax/commit/f83897a6199945c4c64963c4b33ec324e050eb39))
* wire ingest telemetry and provenance ([6d38212](https://github.com/Necmttn/ax/commit/6d38212b6c29fcbff1e3a68ebe57c34ed2e3e5ca))
* **wrapped:** polish dashboard accessibility ([6f35a98](https://github.com/Necmttn/ax/commit/6f35a98b2cd2e0e93388a8492ed5164a803174e7))
* **wrapped:** repair profile query aggregation ([9d357a2](https://github.com/Necmttn/ax/commit/9d357a2e2bc0fa1d40a99a0123fdabbf938079f2))


### Performance

* add indexes on relation tables ([#29](https://github.com/Necmttn/ax/issues/29)) ([#30](https://github.com/Necmttn/ax/issues/30)) ([fb7e9e6](https://github.com/Necmttn/ax/commit/fb7e9e6a232355c1fa68750eb93dc5ff82eb620e))
* cmdTaste/Search/Unused single-pass aggregate ([#31](https://github.com/Necmttn/ax/issues/31)) ([#32](https://github.com/Necmttn/ax/issues/32)) ([eed3457](https://github.com/Necmttn/ax/commit/eed3457c0ff670c32ffcf6ca228bc53e8d00b7cb))
* coalesce codex batch writes ([374bf47](https://github.com/Necmttn/ax/commit/374bf47a3a002deddf79d1442fc07319f622c847))
* **dashboard:** graph-explorer reads precomputed metrics instead of per-row turn scans ([307d2e2](https://github.com/Necmttn/ax/commit/307d2e2cf9b77c31d34352df5b36b0e33322e854))
* **dashboard:** paginate inspect server-side (3.9 MB → 0.4 MB initial) ([947b65d](https://github.com/Necmttn/ax/commit/947b65d72963d7e2d1c25ec79466ad11d99d7263))
* **dashboard:** paginate inspector turn list ([b403106](https://github.com/Necmttn/ax/commit/b4031067a44e55a2dbf40ab8e096ae385dea2cab))
* **dashboard:** paginate recall server-side (50 hard cap → offset/limit) ([3a42563](https://github.com/Necmttn/ax/commit/3a42563aa8fc61bab773cce96595231ef3e1b881))
* **dashboard:** paginate sessions roots server-side + lazy infinite scroll ([4efc52d](https://github.com/Necmttn/ax/commit/4efc52d1c6839285f9e1db679a981331ae68edbe))
* parallelize claude transcript ingest ([7843f4c](https://github.com/Necmttn/ax/commit/7843f4c121e78c4beb6e3b8410d11e108aaddf7f))
* parallelize transcript ingest ([51ded57](https://github.com/Necmttn/ax/commit/51ded5787f8a3f356d082a66328a95fe319fcd52))
* **schema:** add precomputed session attention metrics ([054d5f9](https://github.com/Necmttn/ax/commit/054d5f9e45dc3892595737f75f5bb4571535cbd0))
* **schema:** add standalone session.started_at index ([9f0f1c1](https://github.com/Necmttn/ax/commit/9f0f1c1dc80f50b7ed08510f8677e609b5fe00f6))
* speed up codex relation ingest ([c4b5a29](https://github.com/Necmttn/ax/commit/c4b5a299d26e818801818f284f8939fc93ccbbcb))

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
