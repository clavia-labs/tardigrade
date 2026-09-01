# Changelog

## [0.18.0](https://github.com/clavia-labs/tardigrade/compare/v0.17.0...v0.18.0) (2026-09-01)


### Features

* **agent:** select compaction model ([#312](https://github.com/clavia-labs/tardigrade/issues/312)) ([68f2e0e](https://github.com/clavia-labs/tardigrade/commit/68f2e0efe2dccc8be11ba7c39c2a2f1a20f26b1a))
* **server:** stream actor threads ([#317](https://github.com/clavia-labs/tardigrade/issues/317)) ([6eee447](https://github.com/clavia-labs/tardigrade/commit/6eee4479655d540a1a91c23644efe92c063ce501))


### Bug Fixes

* **cli:** default actor name ([#318](https://github.com/clavia-labs/tardigrade/issues/318)) ([4a007f9](https://github.com/clavia-labs/tardigrade/commit/4a007f943c244b9700eb54c58977ceffcd677ec9))

## [0.17.0](https://github.com/clavia-labs/tardigrade/compare/v0.16.0...v0.17.0) (2026-08-30)


### Features

* **core:** cancel method invocations ([#309](https://github.com/clavia-labs/tardigrade/issues/309)) ([6525116](https://github.com/clavia-labs/tardigrade/commit/65251161906cddbb4cb284ba21e9f0281e022dd1))


### Bug Fixes

* **ci:** ignore web releases ([#308](https://github.com/clavia-labs/tardigrade/issues/308)) ([f3f5d97](https://github.com/clavia-labs/tardigrade/commit/f3f5d97803a0db0a6119495c4287c16b0b3cadfc))
* **model:** retry connection errors ([#310](https://github.com/clavia-labs/tardigrade/issues/310)) ([4f068a7](https://github.com/clavia-labs/tardigrade/commit/4f068a78d7a3d2cc370ca6e997ead95cbbdf3fd7))

## [0.16.0](https://github.com/clavia-labs/tardigrade/compare/v0.15.0...v0.16.0) (2026-08-29)


### Features

* push committed event tails ([#301](https://github.com/clavia-labs/tardigrade/issues/301)) ([0786eaf](https://github.com/clavia-labs/tardigrade/commit/0786eaf2cad1fa867c716d473e35bbacf1239607))


### Bug Fixes

* **models:** isolate catalog storage ([#303](https://github.com/clavia-labs/tardigrade/issues/303)) ([3f349f0](https://github.com/clavia-labs/tardigrade/commit/3f349f0eda6524950ce9e187ae9bbf53c68ea6e7))
* **web:** clarify example prompt ([#294](https://github.com/clavia-labs/tardigrade/issues/294)) ([31da8b0](https://github.com/clavia-labs/tardigrade/commit/31da8b0c174463e262fdd778a1da3bb2897dc9d0))

## [0.15.0](https://github.com/clavia-labs/tardigrade/compare/v0.14.0...v0.15.0) (2026-08-29)


### Features

* isolate actor threads ([#298](https://github.com/clavia-labs/tardigrade/issues/298)) ([59ce425](https://github.com/clavia-labs/tardigrade/commit/59ce4258f2d440870b2822633534e33ade215838))

## [0.14.0](https://github.com/clavia-labs/tardigrade/compare/v0.13.0...v0.14.0) (2026-08-28)


### Features

* **cloudflare:** isolate actor threads ([#292](https://github.com/clavia-labs/tardigrade/issues/292)) ([f5f3156](https://github.com/clavia-labs/tardigrade/commit/f5f3156029a87e1007f516862cdb4d93eed7c029))

## [0.13.0](https://github.com/clavia-labs/tardigrade/compare/v0.12.0...v0.13.0) (2026-08-28)


### Features

* **models:** observe inference deltas ([#290](https://github.com/clavia-labs/tardigrade/issues/290)) ([353f5ef](https://github.com/clavia-labs/tardigrade/commit/353f5ef2299c8179192dc704f31e921ded9c7797))

## [0.12.0](https://github.com/clavia-labs/tardigrade/compare/v0.11.0...v0.12.0) (2026-08-27)


### Features

* **cloudflare:** expose application layers ([#285](https://github.com/clavia-labs/tardigrade/issues/285)) ([040564f](https://github.com/clavia-labs/tardigrade/commit/040564f7f9be0e2333a2c01f2680189068cdf906))

## [0.11.0](https://github.com/clavia-labs/tardigrade/compare/v0.10.1...v0.11.0) (2026-08-27)


### Features

* add durable method alarms ([#274](https://github.com/clavia-labs/tardigrade/issues/274)) ([de49c5f](https://github.com/clavia-labs/tardigrade/commit/de49c5f4cd9b332ddbf902fac8570d49305087a2))
* **models:** add catalog policy ([#283](https://github.com/clavia-labs/tardigrade/issues/283)) ([e0a47bb](https://github.com/clavia-labs/tardigrade/commit/e0a47bbf49736d1c7a33836266cfb633ef85ab80))
* **web:** add landing page ([#275](https://github.com/clavia-labs/tardigrade/issues/275)) ([6c8445d](https://github.com/clavia-labs/tardigrade/commit/6c8445dd5d11479dcc61353871f97690b5e25c39))
* **web:** add mobile navigation ([#281](https://github.com/clavia-labs/tardigrade/issues/281)) ([dc2468c](https://github.com/clavia-labs/tardigrade/commit/dc2468c325219f7fa2bea19eb8c0b926848d73ae))
* **web:** add site favicon ([#284](https://github.com/clavia-labs/tardigrade/issues/284)) ([fbee8fd](https://github.com/clavia-labs/tardigrade/commit/fbee8fd048eaa14eb4d4d1cc16eda9089c2791ca))


### Bug Fixes

* **bun:** isolate model code ([#271](https://github.com/clavia-labs/tardigrade/issues/271)) ([805aa17](https://github.com/clavia-labs/tardigrade/commit/805aa179639d218646d70d9021196b2656f33809))
* **code:** bound package calls ([#273](https://github.com/clavia-labs/tardigrade/issues/273)) ([91f875e](https://github.com/clavia-labs/tardigrade/commit/91f875ea05a775c04dd990f9d8ca60602e519dcc))
* **web:** stop mobile autoplay ([#282](https://github.com/clavia-labs/tardigrade/issues/282)) ([8244533](https://github.com/clavia-labs/tardigrade/commit/8244533725eaef8fa3738be2ba2c97fd60e3aab8))

## [0.10.1](https://github.com/clavia-labs/tardigrade/compare/v0.10.0...v0.10.1) (2026-08-26)


### Bug Fixes

* **publish:** export actor methods ([dbd15db](https://github.com/clavia-labs/tardigrade/commit/dbd15dba708fb4b9398df14577f046fd5e97f18d))

## [0.10.0](https://github.com/clavia-labs/tardigrade/compare/v0.9.0...v0.10.0) (2026-08-26)


### Features

* release callable actors ([bcb4fae](https://github.com/clavia-labs/tardigrade/commit/bcb4fae767233e18a52dd7d81141585d834dab1f))

## [0.9.0](https://github.com/clavia-labs/tardigrade/compare/v0.8.0...v0.9.0) (2026-08-25)


### Features

* **agent:** summarize code execution ([#259](https://github.com/clavia-labs/tardigrade/issues/259)) ([6764d29](https://github.com/clavia-labs/tardigrade/commit/6764d2969cdf544854e21e26d94f90bd721d7b3d))


### Bug Fixes

* **cloudflare:** dispose loaded workers ([#261](https://github.com/clavia-labs/tardigrade/issues/261)) ([3ff0e68](https://github.com/clavia-labs/tardigrade/commit/3ff0e68bac05a071e10ab5fb29212a0fe8113c3e))
* **code:** compare replay arguments structurally ([#260](https://github.com/clavia-labs/tardigrade/issues/260)) ([8b85922](https://github.com/clavia-labs/tardigrade/commit/8b85922b6dfab3bf15bdcc4a8d30531a4fb7b066))
* **core:** reconcile component transitions ([#257](https://github.com/clavia-labs/tardigrade/issues/257)) ([524ffeb](https://github.com/clavia-labs/tardigrade/commit/524ffebf282e236773af1434b008f03a209a9146))

## [0.8.0](https://github.com/clavia-labs/tardigrade/compare/v0.7.1...v0.8.0) (2026-08-25)


### Features

* **cli:** streamline actor onboarding ([#254](https://github.com/clavia-labs/tardigrade/issues/254)) ([cdb77fd](https://github.com/clavia-labs/tardigrade/commit/cdb77fd2e66df9864ce93a58faba74e0cafb9853))

## [0.7.1](https://github.com/clavia-labs/tardigrade/compare/v0.7.0...v0.7.1) (2026-08-24)


### Bug Fixes

* **ci:** refresh release candidates ([#246](https://github.com/clavia-labs/tardigrade/issues/246)) ([caf35c6](https://github.com/clavia-labs/tardigrade/commit/caf35c6f8b5d60e8a77e5863228410ef5c581016))
* **cli:** complete published deploys ([#248](https://github.com/clavia-labs/tardigrade/issues/248)) ([39ef10a](https://github.com/clavia-labs/tardigrade/commit/39ef10a7acf3fde4371f7c28a584150fb016eed3))

## [0.7.0](https://github.com/clavia-labs/tardigrade/compare/v0.6.0...v0.7.0) (2026-08-24)


### Features

* **agent:** select model references ([#236](https://github.com/clavia-labs/tardigrade/issues/236)) ([d3baba5](https://github.com/clavia-labs/tardigrade/commit/d3baba557a953717e50c4856e09499bd70c2be5d))
* **celld:** replay package calls ([#243](https://github.com/clavia-labs/tardigrade/issues/243)) ([7563067](https://github.com/clavia-labs/tardigrade/commit/7563067ce908c223f825e265c33c837226fb64b7))
* **cli:** configure model providers ([#238](https://github.com/clavia-labs/tardigrade/issues/238)) ([2b0de55](https://github.com/clavia-labs/tardigrade/commit/2b0de557d6dc973ba31835fa25ac7b318980f79d))
* **cli:** scaffold actor project ([#241](https://github.com/clavia-labs/tardigrade/issues/241)) ([e410551](https://github.com/clavia-labs/tardigrade/commit/e41055131eeb0312e9c26da2b45c5a1c7b11ec58))
* **cli:** scaffold Celld deployment ([#242](https://github.com/clavia-labs/tardigrade/issues/242)) ([8085de7](https://github.com/clavia-labs/tardigrade/commit/8085de74b68aaaf3df31fa45c5833a6356f6747d))
* **cloudflare:** mount actor methods ([#239](https://github.com/clavia-labs/tardigrade/issues/239)) ([527e8e6](https://github.com/clavia-labs/tardigrade/commit/527e8e602e15dfa3fd0b1a1d852a6f0682cd73ef))
* **models:** serve provider directory ([#237](https://github.com/clavia-labs/tardigrade/issues/237)) ([b318beb](https://github.com/clavia-labs/tardigrade/commit/b318beb3ee1bf367c7ef522ca8dcfeb1f8695691))


### Bug Fixes

* **ci:** find stable baseline ([#232](https://github.com/clavia-labs/tardigrade/issues/232)) ([0bbc6e9](https://github.com/clavia-labs/tardigrade/commit/0bbc6e9bd4c8ad97e36abe71646115604de1db91))

## [0.6.0](https://github.com/clavia-labs/tardigrade/compare/v0.5.0...v0.6.0) (2026-08-24)


### Features

* **agent:** declare actor methods ([#228](https://github.com/clavia-labs/tardigrade/issues/228)) ([6937d77](https://github.com/clavia-labs/tardigrade/commit/6937d777b04368ca2da5ab124f465c753bd7deec))
* **agent:** preserve usage evidence ([#221](https://github.com/clavia-labs/tardigrade/issues/221)) ([6f55b1f](https://github.com/clavia-labs/tardigrade/commit/6f55b1fd5e68c236a4d6d87a85064d07f60385b1))
* **api:** serve actor methods ([#231](https://github.com/clavia-labs/tardigrade/issues/231)) ([467518e](https://github.com/clavia-labs/tardigrade/commit/467518e5220c769606328e9898d291d5d2bdc8ff))
* **brand:** add community logos ([#230](https://github.com/clavia-labs/tardigrade/issues/230)) ([783c0b5](https://github.com/clavia-labs/tardigrade/commit/783c0b52424fde9fc2904f0816bd1e0ab02d3934))
* **cloudflare:** add durable actor host ([#224](https://github.com/clavia-labs/tardigrade/issues/224)) ([6a2f89f](https://github.com/clavia-labs/tardigrade/commit/6a2f89fb0b0bc3d9e786d7a439d65d8d91fb8921))
* **cloudflare:** run durable agents ([#226](https://github.com/clavia-labs/tardigrade/issues/226)) ([328d9c3](https://github.com/clavia-labs/tardigrade/commit/328d9c312e8f9cd973f83db7b7b2880950333d38))
* expose agent call contracts ([#219](https://github.com/clavia-labs/tardigrade/issues/219)) ([33f877e](https://github.com/clavia-labs/tardigrade/commit/33f877e96ef26b74b33b75b8260436b9dddf4a62))
* **host:** settle threads concurrently ([#220](https://github.com/clavia-labs/tardigrade/issues/220)) ([74f183c](https://github.com/clavia-labs/tardigrade/commit/74f183c0e891814f20b1f710969ba4fb598c339d))
* **registry:** add platform bindings ([#225](https://github.com/clavia-labs/tardigrade/issues/225)) ([2988fe4](https://github.com/clavia-labs/tardigrade/commit/2988fe45b62682251ed5923b88503673ef6a8db2))
* unify actor communication ([#217](https://github.com/clavia-labs/tardigrade/issues/217)) ([f8a597b](https://github.com/clavia-labs/tardigrade/commit/f8a597bd9b0c0e2af26e73f8629b02eb7fbaf0fa))


### Bug Fixes

* **ci:** close release race ([#210](https://github.com/clavia-labs/tardigrade/issues/210)) ([768377c](https://github.com/clavia-labs/tardigrade/commit/768377cc98f6532a6ff26b21c96f42af11fd8d78))
* **ci:** report release checks ([#212](https://github.com/clavia-labs/tardigrade/issues/212)) ([c91f7fa](https://github.com/clavia-labs/tardigrade/commit/c91f7fa22331951931818267d6196063b94c0f61))
* **ci:** scope release discovery ([#211](https://github.com/clavia-labs/tardigrade/issues/211)) ([53c3a8a](https://github.com/clavia-labs/tardigrade/commit/53c3a8a736e279e34f6a22f4300635cb1bbc3213))
* **ci:** verify candidate tree ([#207](https://github.com/clavia-labs/tardigrade/issues/207)) ([f500555](https://github.com/clavia-labs/tardigrade/commit/f5005556ce9da93476badd549ddf6ff17de314d8))
* **code:** stabilize agent execution ([#222](https://github.com/clavia-labs/tardigrade/issues/222)) ([df426ea](https://github.com/clavia-labs/tardigrade/commit/df426ead167dcfd061b3d565396502c24aefbbdd))
* validate runtime policy inputs ([#218](https://github.com/clavia-labs/tardigrade/issues/218)) ([00f6f7f](https://github.com/clavia-labs/tardigrade/commit/00f6f7fcab1fe0b49c951a53bad9914013434dc3))

## [0.5.0](https://github.com/clavia-labs/tardigrade/compare/v0.5.0-rc...v0.5.0) (2026-08-22)


### Features

* promote release trunk ([c41ee98](https://github.com/clavia-labs/tardigrade/commit/c41ee98b77a7b20b5986adae5aa42733f77873c2))


### Bug Fixes

* **agent:** expose report settlement ([#204](https://github.com/clavia-labs/tardigrade/issues/204)) ([fb9b43c](https://github.com/clavia-labs/tardigrade/commit/fb9b43c1d95f29f68c0c192f8da44f07fce0652a))
* **agent:** stop reply chains ([#199](https://github.com/clavia-labs/tardigrade/issues/199)) ([c89cb71](https://github.com/clavia-labs/tardigrade/commit/c89cb71f5a0e446cdecbaf161ebbaf9a93eaa03e))
* **ci:** build candidate tree ([#203](https://github.com/clavia-labs/tardigrade/issues/203)) ([b0ab214](https://github.com/clavia-labs/tardigrade/commit/b0ab214f96b2508ce204f7a34f6cee939c7d9880))
* **ci:** pin release candidate ([#202](https://github.com/clavia-labs/tardigrade/issues/202)) ([96cc008](https://github.com/clavia-labs/tardigrade/commit/96cc00840d962c02b4af16dab126a69c4db31c12))

## [0.5.0-rc](https://github.com/clavia-labs/tardigrade/compare/v0.4.0...v0.5.0-rc) (2026-08-21)


### Features

* add linked channels ([#191](https://github.com/clavia-labs/tardigrade/issues/191)) ([304ee54](https://github.com/clavia-labs/tardigrade/commit/304ee54dd8cf35fe880bfb4e338845541e6c8eae))
* name component output view ([#189](https://github.com/clavia-labs/tardigrade/issues/189)) ([a74da0b](https://github.com/clavia-labs/tardigrade/commit/a74da0b708b984dbafa3d19051e0ae87ed79b40a))
* prefer native output ([#192](https://github.com/clavia-labs/tardigrade/issues/192)) ([784caf9](https://github.com/clavia-labs/tardigrade/commit/784caf94cbb5cfb5950d20efa87d67ac3f3a2fd0))

## [0.4.0](https://github.com/clavia-labs/tardigrade/compare/v0.4.0-rc...v0.4.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139))
* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13))

### Features

* **actors:** build and push ([#149](https://github.com/clavia-labs/tardigrade/issues/149)) ([a48321b](https://github.com/clavia-labs/tardigrade/commit/a48321bff18dce045dbfd47c5e4674d0198852f7))
* add code-first agent harness framework ([#1](https://github.com/clavia-labs/tardigrade/issues/1)) ([024cfba](https://github.com/clavia-labs/tardigrade/commit/024cfbabccec5c802666de2665e1e5425fd064d1))
* adopt Effect v4 primitives for schemas, retries, and secrets ([#11](https://github.com/clavia-labs/tardigrade/issues/11)) ([daefba0](https://github.com/clavia-labs/tardigrade/commit/daefba024b9fc02edc9b8c2eb6a5919f957a4c23))
* **agent:** capability assembly ([#72](https://github.com/clavia-labs/tardigrade/issues/72)) ([1c708d2](https://github.com/clavia-labs/tardigrade/commit/1c708d2ad634dc479673f8140a6f8b10c54ddd50))
* **agent:** export the actor ([#34](https://github.com/clavia-labs/tardigrade/issues/34)) ([7a585fa](https://github.com/clavia-labs/tardigrade/commit/7a585fa8507fc739f21d7125ac5582f8c6b77bbb))
* **agent:** harden inference recovery ([#108](https://github.com/clavia-labs/tardigrade/issues/108)) ([8378aea](https://github.com/clavia-labs/tardigrade/commit/8378aead901c49055dfb77eca4be3b81c55cc028))
* **agent:** name it createRlmAgent ([#30](https://github.com/clavia-labs/tardigrade/issues/30)) ([b114023](https://github.com/clavia-labs/tardigrade/commit/b114023a1da2e88f87e016054e5efbac6a407f4b))
* **agent:** pluggable tool surface ([#50](https://github.com/clavia-labs/tardigrade/issues/50)) ([b3127c4](https://github.com/clavia-labs/tardigrade/commit/b3127c4ef39be4efe7313d550be85d38cd8910fb))
* **agent:** record cost provenance ([#61](https://github.com/clavia-labs/tardigrade/issues/61)) ([f18483b](https://github.com/clavia-labs/tardigrade/commit/f18483b0fb1f6e70cbd5702d9a57de70e9a3b63b))
* **agent:** root export for rlm ([#33](https://github.com/clavia-labs/tardigrade/issues/33)) ([115edb6](https://github.com/clavia-labs/tardigrade/commit/115edb6b8c4c3794e2b5df512c7ca8de4948d88e))
* **agent:** system as projection ([#85](https://github.com/clavia-labs/tardigrade/issues/85)) ([7917b0d](https://github.com/clavia-labs/tardigrade/commit/7917b0dd2f4239cdafbfbc03c9dc117a6eba5cba))
* **agent:** workspace package ([#94](https://github.com/clavia-labs/tardigrade/issues/94)) ([2003834](https://github.com/clavia-labs/tardigrade/commit/2003834146ea62c3e5e11c8b235bef53d0616775))
* **bun:** durable workspace binding ([#93](https://github.com/clavia-labs/tardigrade/issues/93)) ([f635446](https://github.com/clavia-labs/tardigrade/commit/f635446cf2a4f89a46f452761f3aa9a1fa895b6b))
* **bun:** file telemetry layer ([#63](https://github.com/clavia-labs/tardigrade/issues/63)) ([2b73016](https://github.com/clavia-labs/tardigrade/commit/2b730163ce7e237543a0ec7367e6bd37ac9fd22d))
* **bun:** otlp convenience layer ([#58](https://github.com/clavia-labs/tardigrade/issues/58)) ([5ce827d](https://github.com/clavia-labs/tardigrade/commit/5ce827dc5f31f54b996f97df069ebd772f27cf94))
* **bun:** workspace sql binding ([#97](https://github.com/clavia-labs/tardigrade/issues/97)) ([ef1cf7b](https://github.com/clavia-labs/tardigrade/commit/ef1cf7b8f870650e51ffc837128127cded5ed6cf))
* **cli:** dev asks for a model ([#143](https://github.com/clavia-labs/tardigrade/issues/143)) ([3102f61](https://github.com/clavia-labs/tardigrade/commit/3102f61add932a1b746f7eecfa590aae0adfb0f9))
* **client:** derive the sdk from the api ([#135](https://github.com/clavia-labs/tardigrade/issues/135)) ([193c839](https://github.com/clavia-labs/tardigrade/commit/193c839398861af04d3036ee569027b1c29c95b7))
* **cli:** finish local quickstart ([#148](https://github.com/clavia-labs/tardigrade/issues/148)) ([f8d3c4b](https://github.com/clavia-labs/tardigrade/commit/f8d3c4b34521979e04acaa80bbff533968074382))
* **cli:** list available actors ([#150](https://github.com/clavia-labs/tardigrade/issues/150)) ([93dc099](https://github.com/clavia-labs/tardigrade/commit/93dc0991a8ab8c9d12cd9017fdc53f2204516253))
* **cli:** setup and a reaching actor ([#142](https://github.com/clavia-labs/tardigrade/issues/142)) ([5a660f2](https://github.com/clavia-labs/tardigrade/commit/5a660f21d7a775abf6466083b40bc7bb903dda88))
* **cli:** tdg command ([#136](https://github.com/clavia-labs/tardigrade/issues/136)) ([1e3e8c1](https://github.com/clavia-labs/tardigrade/commit/1e3e8c1ee4f3717ca090a2150d6d6cc20650a2ff))
* close the type holes the audit found and reject any ([#10](https://github.com/clavia-labs/tardigrade/issues/10)) ([a3d887e](https://github.com/clavia-labs/tardigrade/commit/a3d887ec0c94d3c4b170477c34f16a73e2a3d875))
* **code:** default seam services ([#64](https://github.com/clavia-labs/tardigrade/issues/64)) ([0d48c70](https://github.com/clavia-labs/tardigrade/commit/0d48c70c8498013d5478ec6dd4001ac6f565a28a))
* **codemode:** optional code mode package and a prose gate ([#6](https://github.com/clavia-labs/tardigrade/issues/6)) ([190be2c](https://github.com/clavia-labs/tardigrade/commit/190be2cb1bf2b849e441971e802416b18e0d40ab))
* **code:** packages flow as values ([#119](https://github.com/clavia-labs/tardigrade/issues/119)) ([eaf07be](https://github.com/clavia-labs/tardigrade/commit/eaf07becb6002cbd531521c7fab98a257ea1ed27))
* **code:** sql runner doc ([#98](https://github.com/clavia-labs/tardigrade/issues/98)) ([17044e5](https://github.com/clavia-labs/tardigrade/commit/17044e57944a36fa7284ed899cc101cbbf721ec3))
* **code:** type package requirements ([#117](https://github.com/clavia-labs/tardigrade/issues/117)) ([1386b55](https://github.com/clavia-labs/tardigrade/commit/1386b553ef9216d45197e8ecb7f12997b7e27f9e))
* **core:** check machine state names at both tiers ([#8](https://github.com/clavia-labs/tardigrade/issues/8)) ([d397467](https://github.com/clavia-labs/tardigrade/commit/d397467445c8f3d5747c114edcb5babfa88d30cc))
* **core:** driver give-up guard spec ([#122](https://github.com/clavia-labs/tardigrade/issues/122)) ([7a354f0](https://github.com/clavia-labs/tardigrade/commit/7a354f0656ea40400d4074a8f7aef8cb3bd3a7e5))
* **core:** facets observe service ([#121](https://github.com/clavia-labs/tardigrade/issues/121)) ([ab1ac93](https://github.com/clavia-labs/tardigrade/commit/ab1ac9317437d133e3894dbe1e55d8f21d9718d6))
* **evolve:** add GEPA harness orchestrator ([#2](https://github.com/clavia-labs/tardigrade/issues/2)) ([609f0fa](https://github.com/clavia-labs/tardigrade/commit/609f0fac361b5ffa5aee2adb2f3d299ed07b2b17))
* **evolve:** make GEPA mutate by model reflection ([#12](https://github.com/clavia-labs/tardigrade/issues/12)) ([0c2b6f0](https://github.com/clavia-labs/tardigrade/commit/0c2b6f0d87157205b37bcedb3f79a72c432b9107))
* **evolve:** track optimization cost ([#4](https://github.com/clavia-labs/tardigrade/issues/4)) ([8f9a11a](https://github.com/clavia-labs/tardigrade/commit/8f9a11ac19532666bafecb4b18296b3e689816de))
* **harness:** let a caller state the model's output ceiling ([#15](https://github.com/clavia-labs/tardigrade/issues/15)) ([55b0404](https://github.com/clavia-labs/tardigrade/commit/55b0404a57ba63fa7fb1c1bce915e2126ea0c5aa))
* **harness:** subagent delegation with session host and derived cost trees ([#5](https://github.com/clavia-labs/tardigrade/issues/5)) ([db97218](https://github.com/clavia-labs/tardigrade/commit/db97218f1b1c1c0573f606a0c70b2a8e05e29e08))
* journal model backoff so a restart can wait out a queue ([#19](https://github.com/clavia-labs/tardigrade/issues/19)) ([868f107](https://github.com/clavia-labs/tardigrade/commit/868f1072c593dd8bb77c6f5697704b759a812143))
* **model:** declared output limits ([#41](https://github.com/clavia-labs/tardigrade/issues/41)) ([4a22ab3](https://github.com/clavia-labs/tardigrade/commit/4a22ab3a7448d093a0e22ef0bde17b8cbe1d0f72))
* **model:** honor retry-after ([#38](https://github.com/clavia-labs/tardigrade/issues/38)) ([0c3ef9f](https://github.com/clavia-labs/tardigrade/commit/0c3ef9f5599b5075a150522d58057b500607c365))
* **model:** tunable stream bounds ([#54](https://github.com/clavia-labs/tardigrade/issues/54)) ([b3ef1e0](https://github.com/clavia-labs/tardigrade/commit/b3ef1e0d62c93f465063f4489f432ef03e7ee133))
* **model:** wire-reported cost provenance ([#67](https://github.com/clavia-labs/tardigrade/issues/67)) ([8d86873](https://github.com/clavia-labs/tardigrade/commit/8d86873f73141549e6ad3877de7b997f5e357a51))
* publish as tardie ([#147](https://github.com/clavia-labs/tardigrade/issues/147)) ([b020b2c](https://github.com/clavia-labs/tardigrade/commit/b020b2c8a3e1100606836a4eac89731211ed08f3))
* publish to npm ([#80](https://github.com/clavia-labs/tardigrade/issues/80)) ([73386a8](https://github.com/clavia-labs/tardigrade/commit/73386a862ef7f69135b977f08c7e8fc1ed0689e7))
* reserve model spend and project per-request options ([#21](https://github.com/clavia-labs/tardigrade/issues/21)) ([60dd9e6](https://github.com/clavia-labs/tardigrade/commit/60dd9e6d111c04797077c92627650b8d5abe1b92))
* **server:** self host api ([#129](https://github.com/clavia-labs/tardigrade/issues/129)) ([c8189ca](https://github.com/clavia-labs/tardigrade/commit/c8189ca48b4c695bb470fa071cc97ee12ada5edd))
* span pass and tracer seam ([#52](https://github.com/clavia-labs/tardigrade/issues/52)) ([b99334d](https://github.com/clavia-labs/tardigrade/commit/b99334db4cfb071dd6206003f394483867cc7121))
* unify npm package ([#100](https://github.com/clavia-labs/tardigrade/issues/100)) ([e0bfa37](https://github.com/clavia-labs/tardigrade/commit/e0bfa37d4415a2fe6e83e0d46291995e4d5becc3))
* **voyager:** refine actor navigation ([#151](https://github.com/clavia-labs/tardigrade/issues/151)) ([81302f3](https://github.com/clavia-labs/tardigrade/commit/81302f387e886c7147901ca9481895a7dc230f13))
* **voyager:** render native API ([#153](https://github.com/clavia-labs/tardigrade/issues/153)) ([a92cd3b](https://github.com/clavia-labs/tardigrade/commit/a92cd3b4c7b1d112c9095ad8a718845da47a600b))
* **voyager:** trajectory explorer ui ([#133](https://github.com/clavia-labs/tardigrade/issues/133)) ([226514a](https://github.com/clavia-labs/tardigrade/commit/226514aa5f9760f49953929e4868fbbaecbaf38b))
* **voyager:** window brush and chrome ([#134](https://github.com/clavia-labs/tardigrade/issues/134)) ([657c112](https://github.com/clavia-labs/tardigrade/commit/657c112497eccc402e1f7a63ff50583c795a664a))


### Bug Fixes

* **agent:** compact inside a turn ([#49](https://github.com/clavia-labs/tardigrade/issues/49)) ([34e5fb6](https://github.com/clavia-labs/tardigrade/commit/34e5fb6babf34f5fc9395d2b1c997d7269649487))
* carry provider reasoning state across turns ([#17](https://github.com/clavia-labs/tardigrade/issues/17)) ([cf9c7b6](https://github.com/clavia-labs/tardigrade/commit/cf9c7b6e28df0304c76f93a4cb871e639517b5f3))
* **cli:** prepare npm release ([#155](https://github.com/clavia-labs/tardigrade/issues/155)) ([4f54bbd](https://github.com/clavia-labs/tardigrade/commit/4f54bbd8cda722ecb0c3d447ac06a33039e5d119))
* continue truncated answers and compact before a request that will not fit ([#23](https://github.com/clavia-labs/tardigrade/issues/23)) ([e72f947](https://github.com/clavia-labs/tardigrade/commit/e72f9476841389747abc62b87cb13fe9aa55f0fe))
* **examples:** codeModeFor options form ([#130](https://github.com/clavia-labs/tardigrade/issues/130)) ([277ec40](https://github.com/clavia-labs/tardigrade/commit/277ec40ab0be0c5c5cbf901fdba65d88944d8c87))
* handle published dry runs ([#104](https://github.com/clavia-labs/tardigrade/issues/104)) ([2da1dae](https://github.com/clavia-labs/tardigrade/commit/2da1dae40afd4ba16dd25c4d237367cf85de4a99))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14)) ([73197ba](https://github.com/clavia-labs/tardigrade/commit/73197ba9c17a5368c72a779fdea9ed4a2f2702e2))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13)) ([b5d3c11](https://github.com/clavia-labs/tardigrade/commit/b5d3c11e6b5f4747a05b356791d81ac2916196f4))
* honour routes on the OpenAI-compatible gateway path ([#20](https://github.com/clavia-labs/tardigrade/issues/20)) ([678bba4](https://github.com/clavia-labs/tardigrade/commit/678bba4f01cee14ba67a2b913a6ca32075784cb0))
* **host:** type thread layers ([#57](https://github.com/clavia-labs/tardigrade/issues/57)) ([f615244](https://github.com/clavia-labs/tardigrade/commit/f61524401218f878786744a65ba7666c026fbbab))
* install stable package ([#157](https://github.com/clavia-labs/tardigrade/issues/157)) ([ad13106](https://github.com/clavia-labs/tardigrade/commit/ad1310604dafca7de6e9bd3cd4503fca2eb85029))
* **model:** key per ceiling rung ([#42](https://github.com/clavia-labs/tardigrade/issues/42)) ([5567ef7](https://github.com/clavia-labs/tardigrade/commit/5567ef7e5fa4dbd0d3df39d3b3e9bc48940e0b87))
* **model:** truncation fails loudly ([#39](https://github.com/clavia-labs/tardigrade/issues/39)) ([6d664c5](https://github.com/clavia-labs/tardigrade/commit/6d664c5bb78d7ea54a7bd9d3a25029c21dfc9cbf))
* read limits from the model, and fail where a guess would have been quiet ([#18](https://github.com/clavia-labs/tardigrade/issues/18)) ([8bb0941](https://github.com/clavia-labs/tardigrade/commit/8bb09416dafb1b72830749630d9ef7ba863ab9fd))
* track unified release scope ([#105](https://github.com/clavia-labs/tardigrade/issues/105)) ([b6fbdc3](https://github.com/clavia-labs/tardigrade/commit/b6fbdc343ad2aeb9cc17419915540e92bec6a04d))
* **voyager:** refine actor navigation ([#152](https://github.com/clavia-labs/tardigrade/issues/152)) ([ebb1e4d](https://github.com/clavia-labs/tardigrade/commit/ebb1e4d6975baebbf2ea4a1001cdcf8e5d993d27))
* **voyager:** refine API presentation ([#154](https://github.com/clavia-labs/tardigrade/issues/154)) ([0dcd42e](https://github.com/clavia-labs/tardigrade/commit/0dcd42ea7165b82b66167985c2d4bc93bb0e38cd))


### Code Refactoring

* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127)) ([210c170](https://github.com/clavia-labs/tardigrade/commit/210c17019d9543d3037a3f7b92d10122e56ef3e0))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125)) ([7d1dd73](https://github.com/clavia-labs/tardigrade/commit/7d1dd7319c9f2dc057252245b6fe14ca85072fb6))
* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141)) ([caccf62](https://github.com/clavia-labs/tardigrade/commit/caccf6278349731efa9ecc42d3f6c02676b11ab2))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139)) ([1964226](https://github.com/clavia-labs/tardigrade/commit/196422653959b51fdc6a9ade264beb90959175ed))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22)) ([c83e552](https://github.com/clavia-labs/tardigrade/commit/c83e5522ae0cd11f3edc9ece8d95e54cfef4d9a6))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24)) ([0c0f9d6](https://github.com/clavia-labs/tardigrade/commit/0c0f9d6b7992f5b53dffed7940539f40fb8aa8c2))

## [0.4.0-rc](https://github.com/clavia-labs/tardigrade/compare/v0.3.0...v0.4.0-rc) (2026-08-21)


### Features

* compose actors from components ([#185](https://github.com/clavia-labs/tardigrade/issues/185)) ([221ad35](https://github.com/clavia-labs/tardigrade/commit/221ad353038a5e476ec501a9391e6f2a00fb3832))

## [0.3.0](https://github.com/clavia-labs/tardigrade/compare/v0.3.0-rc...v0.3.0) (2026-08-21)


### ⚠ BREAKING CHANGES

* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139))
* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13))

### Features

* **actors:** build and push ([#149](https://github.com/clavia-labs/tardigrade/issues/149)) ([a48321b](https://github.com/clavia-labs/tardigrade/commit/a48321bff18dce045dbfd47c5e4674d0198852f7))
* add code-first agent harness framework ([#1](https://github.com/clavia-labs/tardigrade/issues/1)) ([024cfba](https://github.com/clavia-labs/tardigrade/commit/024cfbabccec5c802666de2665e1e5425fd064d1))
* adopt Effect v4 primitives for schemas, retries, and secrets ([#11](https://github.com/clavia-labs/tardigrade/issues/11)) ([daefba0](https://github.com/clavia-labs/tardigrade/commit/daefba024b9fc02edc9b8c2eb6a5919f957a4c23))
* **agent:** capability assembly ([#72](https://github.com/clavia-labs/tardigrade/issues/72)) ([1c708d2](https://github.com/clavia-labs/tardigrade/commit/1c708d2ad634dc479673f8140a6f8b10c54ddd50))
* **agent:** export the actor ([#34](https://github.com/clavia-labs/tardigrade/issues/34)) ([7a585fa](https://github.com/clavia-labs/tardigrade/commit/7a585fa8507fc739f21d7125ac5582f8c6b77bbb))
* **agent:** harden inference recovery ([#108](https://github.com/clavia-labs/tardigrade/issues/108)) ([8378aea](https://github.com/clavia-labs/tardigrade/commit/8378aead901c49055dfb77eca4be3b81c55cc028))
* **agent:** name it createRlmAgent ([#30](https://github.com/clavia-labs/tardigrade/issues/30)) ([b114023](https://github.com/clavia-labs/tardigrade/commit/b114023a1da2e88f87e016054e5efbac6a407f4b))
* **agent:** pluggable tool surface ([#50](https://github.com/clavia-labs/tardigrade/issues/50)) ([b3127c4](https://github.com/clavia-labs/tardigrade/commit/b3127c4ef39be4efe7313d550be85d38cd8910fb))
* **agent:** record cost provenance ([#61](https://github.com/clavia-labs/tardigrade/issues/61)) ([f18483b](https://github.com/clavia-labs/tardigrade/commit/f18483b0fb1f6e70cbd5702d9a57de70e9a3b63b))
* **agent:** root export for rlm ([#33](https://github.com/clavia-labs/tardigrade/issues/33)) ([115edb6](https://github.com/clavia-labs/tardigrade/commit/115edb6b8c4c3794e2b5df512c7ca8de4948d88e))
* **agent:** system as projection ([#85](https://github.com/clavia-labs/tardigrade/issues/85)) ([7917b0d](https://github.com/clavia-labs/tardigrade/commit/7917b0dd2f4239cdafbfbc03c9dc117a6eba5cba))
* **agent:** workspace package ([#94](https://github.com/clavia-labs/tardigrade/issues/94)) ([2003834](https://github.com/clavia-labs/tardigrade/commit/2003834146ea62c3e5e11c8b235bef53d0616775))
* **bun:** durable workspace binding ([#93](https://github.com/clavia-labs/tardigrade/issues/93)) ([f635446](https://github.com/clavia-labs/tardigrade/commit/f635446cf2a4f89a46f452761f3aa9a1fa895b6b))
* **bun:** file telemetry layer ([#63](https://github.com/clavia-labs/tardigrade/issues/63)) ([2b73016](https://github.com/clavia-labs/tardigrade/commit/2b730163ce7e237543a0ec7367e6bd37ac9fd22d))
* **bun:** otlp convenience layer ([#58](https://github.com/clavia-labs/tardigrade/issues/58)) ([5ce827d](https://github.com/clavia-labs/tardigrade/commit/5ce827dc5f31f54b996f97df069ebd772f27cf94))
* **bun:** workspace sql binding ([#97](https://github.com/clavia-labs/tardigrade/issues/97)) ([ef1cf7b](https://github.com/clavia-labs/tardigrade/commit/ef1cf7b8f870650e51ffc837128127cded5ed6cf))
* **cli:** dev asks for a model ([#143](https://github.com/clavia-labs/tardigrade/issues/143)) ([3102f61](https://github.com/clavia-labs/tardigrade/commit/3102f61add932a1b746f7eecfa590aae0adfb0f9))
* **client:** derive the sdk from the api ([#135](https://github.com/clavia-labs/tardigrade/issues/135)) ([193c839](https://github.com/clavia-labs/tardigrade/commit/193c839398861af04d3036ee569027b1c29c95b7))
* **cli:** finish local quickstart ([#148](https://github.com/clavia-labs/tardigrade/issues/148)) ([f8d3c4b](https://github.com/clavia-labs/tardigrade/commit/f8d3c4b34521979e04acaa80bbff533968074382))
* **cli:** list available actors ([#150](https://github.com/clavia-labs/tardigrade/issues/150)) ([93dc099](https://github.com/clavia-labs/tardigrade/commit/93dc0991a8ab8c9d12cd9017fdc53f2204516253))
* **cli:** setup and a reaching actor ([#142](https://github.com/clavia-labs/tardigrade/issues/142)) ([5a660f2](https://github.com/clavia-labs/tardigrade/commit/5a660f21d7a775abf6466083b40bc7bb903dda88))
* **cli:** tdg command ([#136](https://github.com/clavia-labs/tardigrade/issues/136)) ([1e3e8c1](https://github.com/clavia-labs/tardigrade/commit/1e3e8c1ee4f3717ca090a2150d6d6cc20650a2ff))
* close the type holes the audit found and reject any ([#10](https://github.com/clavia-labs/tardigrade/issues/10)) ([a3d887e](https://github.com/clavia-labs/tardigrade/commit/a3d887ec0c94d3c4b170477c34f16a73e2a3d875))
* **code:** default seam services ([#64](https://github.com/clavia-labs/tardigrade/issues/64)) ([0d48c70](https://github.com/clavia-labs/tardigrade/commit/0d48c70c8498013d5478ec6dd4001ac6f565a28a))
* **codemode:** optional code mode package and a prose gate ([#6](https://github.com/clavia-labs/tardigrade/issues/6)) ([190be2c](https://github.com/clavia-labs/tardigrade/commit/190be2cb1bf2b849e441971e802416b18e0d40ab))
* **code:** packages flow as values ([#119](https://github.com/clavia-labs/tardigrade/issues/119)) ([eaf07be](https://github.com/clavia-labs/tardigrade/commit/eaf07becb6002cbd531521c7fab98a257ea1ed27))
* **code:** sql runner doc ([#98](https://github.com/clavia-labs/tardigrade/issues/98)) ([17044e5](https://github.com/clavia-labs/tardigrade/commit/17044e57944a36fa7284ed899cc101cbbf721ec3))
* **code:** type package requirements ([#117](https://github.com/clavia-labs/tardigrade/issues/117)) ([1386b55](https://github.com/clavia-labs/tardigrade/commit/1386b553ef9216d45197e8ecb7f12997b7e27f9e))
* **core:** check machine state names at both tiers ([#8](https://github.com/clavia-labs/tardigrade/issues/8)) ([d397467](https://github.com/clavia-labs/tardigrade/commit/d397467445c8f3d5747c114edcb5babfa88d30cc))
* **core:** driver give-up guard spec ([#122](https://github.com/clavia-labs/tardigrade/issues/122)) ([7a354f0](https://github.com/clavia-labs/tardigrade/commit/7a354f0656ea40400d4074a8f7aef8cb3bd3a7e5))
* **core:** facets observe service ([#121](https://github.com/clavia-labs/tardigrade/issues/121)) ([ab1ac93](https://github.com/clavia-labs/tardigrade/commit/ab1ac9317437d133e3894dbe1e55d8f21d9718d6))
* **evolve:** add GEPA harness orchestrator ([#2](https://github.com/clavia-labs/tardigrade/issues/2)) ([609f0fa](https://github.com/clavia-labs/tardigrade/commit/609f0fac361b5ffa5aee2adb2f3d299ed07b2b17))
* **evolve:** make GEPA mutate by model reflection ([#12](https://github.com/clavia-labs/tardigrade/issues/12)) ([0c2b6f0](https://github.com/clavia-labs/tardigrade/commit/0c2b6f0d87157205b37bcedb3f79a72c432b9107))
* **evolve:** track optimization cost ([#4](https://github.com/clavia-labs/tardigrade/issues/4)) ([8f9a11a](https://github.com/clavia-labs/tardigrade/commit/8f9a11ac19532666bafecb4b18296b3e689816de))
* **harness:** let a caller state the model's output ceiling ([#15](https://github.com/clavia-labs/tardigrade/issues/15)) ([55b0404](https://github.com/clavia-labs/tardigrade/commit/55b0404a57ba63fa7fb1c1bce915e2126ea0c5aa))
* **harness:** subagent delegation with session host and derived cost trees ([#5](https://github.com/clavia-labs/tardigrade/issues/5)) ([db97218](https://github.com/clavia-labs/tardigrade/commit/db97218f1b1c1c0573f606a0c70b2a8e05e29e08))
* journal model backoff so a restart can wait out a queue ([#19](https://github.com/clavia-labs/tardigrade/issues/19)) ([868f107](https://github.com/clavia-labs/tardigrade/commit/868f1072c593dd8bb77c6f5697704b759a812143))
* **model:** declared output limits ([#41](https://github.com/clavia-labs/tardigrade/issues/41)) ([4a22ab3](https://github.com/clavia-labs/tardigrade/commit/4a22ab3a7448d093a0e22ef0bde17b8cbe1d0f72))
* **model:** honor retry-after ([#38](https://github.com/clavia-labs/tardigrade/issues/38)) ([0c3ef9f](https://github.com/clavia-labs/tardigrade/commit/0c3ef9f5599b5075a150522d58057b500607c365))
* **model:** tunable stream bounds ([#54](https://github.com/clavia-labs/tardigrade/issues/54)) ([b3ef1e0](https://github.com/clavia-labs/tardigrade/commit/b3ef1e0d62c93f465063f4489f432ef03e7ee133))
* **model:** wire-reported cost provenance ([#67](https://github.com/clavia-labs/tardigrade/issues/67)) ([8d86873](https://github.com/clavia-labs/tardigrade/commit/8d86873f73141549e6ad3877de7b997f5e357a51))
* publish as tardie ([#147](https://github.com/clavia-labs/tardigrade/issues/147)) ([b020b2c](https://github.com/clavia-labs/tardigrade/commit/b020b2c8a3e1100606836a4eac89731211ed08f3))
* publish to npm ([#80](https://github.com/clavia-labs/tardigrade/issues/80)) ([73386a8](https://github.com/clavia-labs/tardigrade/commit/73386a862ef7f69135b977f08c7e8fc1ed0689e7))
* reserve model spend and project per-request options ([#21](https://github.com/clavia-labs/tardigrade/issues/21)) ([60dd9e6](https://github.com/clavia-labs/tardigrade/commit/60dd9e6d111c04797077c92627650b8d5abe1b92))
* **server:** self host api ([#129](https://github.com/clavia-labs/tardigrade/issues/129)) ([c8189ca](https://github.com/clavia-labs/tardigrade/commit/c8189ca48b4c695bb470fa071cc97ee12ada5edd))
* span pass and tracer seam ([#52](https://github.com/clavia-labs/tardigrade/issues/52)) ([b99334d](https://github.com/clavia-labs/tardigrade/commit/b99334db4cfb071dd6206003f394483867cc7121))
* unify npm package ([#100](https://github.com/clavia-labs/tardigrade/issues/100)) ([e0bfa37](https://github.com/clavia-labs/tardigrade/commit/e0bfa37d4415a2fe6e83e0d46291995e4d5becc3))
* **voyager:** refine actor navigation ([#151](https://github.com/clavia-labs/tardigrade/issues/151)) ([81302f3](https://github.com/clavia-labs/tardigrade/commit/81302f387e886c7147901ca9481895a7dc230f13))
* **voyager:** render native API ([#153](https://github.com/clavia-labs/tardigrade/issues/153)) ([a92cd3b](https://github.com/clavia-labs/tardigrade/commit/a92cd3b4c7b1d112c9095ad8a718845da47a600b))
* **voyager:** trajectory explorer ui ([#133](https://github.com/clavia-labs/tardigrade/issues/133)) ([226514a](https://github.com/clavia-labs/tardigrade/commit/226514aa5f9760f49953929e4868fbbaecbaf38b))
* **voyager:** window brush and chrome ([#134](https://github.com/clavia-labs/tardigrade/issues/134)) ([657c112](https://github.com/clavia-labs/tardigrade/commit/657c112497eccc402e1f7a63ff50583c795a664a))


### Bug Fixes

* **agent:** compact inside a turn ([#49](https://github.com/clavia-labs/tardigrade/issues/49)) ([34e5fb6](https://github.com/clavia-labs/tardigrade/commit/34e5fb6babf34f5fc9395d2b1c997d7269649487))
* carry provider reasoning state across turns ([#17](https://github.com/clavia-labs/tardigrade/issues/17)) ([cf9c7b6](https://github.com/clavia-labs/tardigrade/commit/cf9c7b6e28df0304c76f93a4cb871e639517b5f3))
* **cli:** prepare npm release ([#155](https://github.com/clavia-labs/tardigrade/issues/155)) ([4f54bbd](https://github.com/clavia-labs/tardigrade/commit/4f54bbd8cda722ecb0c3d447ac06a33039e5d119))
* continue truncated answers and compact before a request that will not fit ([#23](https://github.com/clavia-labs/tardigrade/issues/23)) ([e72f947](https://github.com/clavia-labs/tardigrade/commit/e72f9476841389747abc62b87cb13fe9aa55f0fe))
* **examples:** codeModeFor options form ([#130](https://github.com/clavia-labs/tardigrade/issues/130)) ([277ec40](https://github.com/clavia-labs/tardigrade/commit/277ec40ab0be0c5c5cbf901fdba65d88944d8c87))
* handle published dry runs ([#104](https://github.com/clavia-labs/tardigrade/issues/104)) ([2da1dae](https://github.com/clavia-labs/tardigrade/commit/2da1dae40afd4ba16dd25c4d237367cf85de4a99))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14)) ([73197ba](https://github.com/clavia-labs/tardigrade/commit/73197ba9c17a5368c72a779fdea9ed4a2f2702e2))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13)) ([b5d3c11](https://github.com/clavia-labs/tardigrade/commit/b5d3c11e6b5f4747a05b356791d81ac2916196f4))
* honour routes on the OpenAI-compatible gateway path ([#20](https://github.com/clavia-labs/tardigrade/issues/20)) ([678bba4](https://github.com/clavia-labs/tardigrade/commit/678bba4f01cee14ba67a2b913a6ca32075784cb0))
* **host:** type thread layers ([#57](https://github.com/clavia-labs/tardigrade/issues/57)) ([f615244](https://github.com/clavia-labs/tardigrade/commit/f61524401218f878786744a65ba7666c026fbbab))
* install stable package ([#157](https://github.com/clavia-labs/tardigrade/issues/157)) ([ad13106](https://github.com/clavia-labs/tardigrade/commit/ad1310604dafca7de6e9bd3cd4503fca2eb85029))
* **model:** key per ceiling rung ([#42](https://github.com/clavia-labs/tardigrade/issues/42)) ([5567ef7](https://github.com/clavia-labs/tardigrade/commit/5567ef7e5fa4dbd0d3df39d3b3e9bc48940e0b87))
* **model:** truncation fails loudly ([#39](https://github.com/clavia-labs/tardigrade/issues/39)) ([6d664c5](https://github.com/clavia-labs/tardigrade/commit/6d664c5bb78d7ea54a7bd9d3a25029c21dfc9cbf))
* read limits from the model, and fail where a guess would have been quiet ([#18](https://github.com/clavia-labs/tardigrade/issues/18)) ([8bb0941](https://github.com/clavia-labs/tardigrade/commit/8bb09416dafb1b72830749630d9ef7ba863ab9fd))
* track unified release scope ([#105](https://github.com/clavia-labs/tardigrade/issues/105)) ([b6fbdc3](https://github.com/clavia-labs/tardigrade/commit/b6fbdc343ad2aeb9cc17419915540e92bec6a04d))
* **voyager:** refine actor navigation ([#152](https://github.com/clavia-labs/tardigrade/issues/152)) ([ebb1e4d](https://github.com/clavia-labs/tardigrade/commit/ebb1e4d6975baebbf2ea4a1001cdcf8e5d993d27))
* **voyager:** refine API presentation ([#154](https://github.com/clavia-labs/tardigrade/issues/154)) ([0dcd42e](https://github.com/clavia-labs/tardigrade/commit/0dcd42ea7165b82b66167985c2d4bc93bb0e38cd))


### Code Refactoring

* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127)) ([210c170](https://github.com/clavia-labs/tardigrade/commit/210c17019d9543d3037a3f7b92d10122e56ef3e0))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125)) ([7d1dd73](https://github.com/clavia-labs/tardigrade/commit/7d1dd7319c9f2dc057252245b6fe14ca85072fb6))
* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141)) ([caccf62](https://github.com/clavia-labs/tardigrade/commit/caccf6278349731efa9ecc42d3f6c02676b11ab2))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139)) ([1964226](https://github.com/clavia-labs/tardigrade/commit/196422653959b51fdc6a9ade264beb90959175ed))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22)) ([c83e552](https://github.com/clavia-labs/tardigrade/commit/c83e5522ae0cd11f3edc9ece8d95e54cfef4d9a6))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24)) ([0c0f9d6](https://github.com/clavia-labs/tardigrade/commit/0c0f9d6b7992f5b53dffed7940539f40fb8aa8c2))

## [0.3.0-rc](https://github.com/clavia-labs/tardigrade/compare/v0.2.1...v0.3.0-rc) (2026-08-21)


### Features

* **voyager:** show agent prompt ([#181](https://github.com/clavia-labs/tardigrade/issues/181)) ([5ab813b](https://github.com/clavia-labs/tardigrade/commit/5ab813bcdfa268e9ddbc70544c50e64b239bf1b7))

## [0.2.1](https://github.com/clavia-labs/tardigrade/compare/v0.2.0...v0.2.1) (2026-08-21)


### ⚠ BREAKING CHANGES

* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139))
* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13))

### Features

* **actors:** build and push ([#149](https://github.com/clavia-labs/tardigrade/issues/149)) ([a48321b](https://github.com/clavia-labs/tardigrade/commit/a48321bff18dce045dbfd47c5e4674d0198852f7))
* add code-first agent harness framework ([#1](https://github.com/clavia-labs/tardigrade/issues/1)) ([024cfba](https://github.com/clavia-labs/tardigrade/commit/024cfbabccec5c802666de2665e1e5425fd064d1))
* adopt Effect v4 primitives for schemas, retries, and secrets ([#11](https://github.com/clavia-labs/tardigrade/issues/11)) ([daefba0](https://github.com/clavia-labs/tardigrade/commit/daefba024b9fc02edc9b8c2eb6a5919f957a4c23))
* **agent:** capability assembly ([#72](https://github.com/clavia-labs/tardigrade/issues/72)) ([1c708d2](https://github.com/clavia-labs/tardigrade/commit/1c708d2ad634dc479673f8140a6f8b10c54ddd50))
* **agent:** export the actor ([#34](https://github.com/clavia-labs/tardigrade/issues/34)) ([7a585fa](https://github.com/clavia-labs/tardigrade/commit/7a585fa8507fc739f21d7125ac5582f8c6b77bbb))
* **agent:** harden inference recovery ([#108](https://github.com/clavia-labs/tardigrade/issues/108)) ([8378aea](https://github.com/clavia-labs/tardigrade/commit/8378aead901c49055dfb77eca4be3b81c55cc028))
* **agent:** name it createRlmAgent ([#30](https://github.com/clavia-labs/tardigrade/issues/30)) ([b114023](https://github.com/clavia-labs/tardigrade/commit/b114023a1da2e88f87e016054e5efbac6a407f4b))
* **agent:** pluggable tool surface ([#50](https://github.com/clavia-labs/tardigrade/issues/50)) ([b3127c4](https://github.com/clavia-labs/tardigrade/commit/b3127c4ef39be4efe7313d550be85d38cd8910fb))
* **agent:** record cost provenance ([#61](https://github.com/clavia-labs/tardigrade/issues/61)) ([f18483b](https://github.com/clavia-labs/tardigrade/commit/f18483b0fb1f6e70cbd5702d9a57de70e9a3b63b))
* **agent:** root export for rlm ([#33](https://github.com/clavia-labs/tardigrade/issues/33)) ([115edb6](https://github.com/clavia-labs/tardigrade/commit/115edb6b8c4c3794e2b5df512c7ca8de4948d88e))
* **agent:** system as projection ([#85](https://github.com/clavia-labs/tardigrade/issues/85)) ([7917b0d](https://github.com/clavia-labs/tardigrade/commit/7917b0dd2f4239cdafbfbc03c9dc117a6eba5cba))
* **agent:** workspace package ([#94](https://github.com/clavia-labs/tardigrade/issues/94)) ([2003834](https://github.com/clavia-labs/tardigrade/commit/2003834146ea62c3e5e11c8b235bef53d0616775))
* **bun:** durable workspace binding ([#93](https://github.com/clavia-labs/tardigrade/issues/93)) ([f635446](https://github.com/clavia-labs/tardigrade/commit/f635446cf2a4f89a46f452761f3aa9a1fa895b6b))
* **bun:** file telemetry layer ([#63](https://github.com/clavia-labs/tardigrade/issues/63)) ([2b73016](https://github.com/clavia-labs/tardigrade/commit/2b730163ce7e237543a0ec7367e6bd37ac9fd22d))
* **bun:** otlp convenience layer ([#58](https://github.com/clavia-labs/tardigrade/issues/58)) ([5ce827d](https://github.com/clavia-labs/tardigrade/commit/5ce827dc5f31f54b996f97df069ebd772f27cf94))
* **bun:** workspace sql binding ([#97](https://github.com/clavia-labs/tardigrade/issues/97)) ([ef1cf7b](https://github.com/clavia-labs/tardigrade/commit/ef1cf7b8f870650e51ffc837128127cded5ed6cf))
* **cli:** dev asks for a model ([#143](https://github.com/clavia-labs/tardigrade/issues/143)) ([3102f61](https://github.com/clavia-labs/tardigrade/commit/3102f61add932a1b746f7eecfa590aae0adfb0f9))
* **client:** derive the sdk from the api ([#135](https://github.com/clavia-labs/tardigrade/issues/135)) ([193c839](https://github.com/clavia-labs/tardigrade/commit/193c839398861af04d3036ee569027b1c29c95b7))
* **cli:** finish local quickstart ([#148](https://github.com/clavia-labs/tardigrade/issues/148)) ([f8d3c4b](https://github.com/clavia-labs/tardigrade/commit/f8d3c4b34521979e04acaa80bbff533968074382))
* **cli:** list available actors ([#150](https://github.com/clavia-labs/tardigrade/issues/150)) ([93dc099](https://github.com/clavia-labs/tardigrade/commit/93dc0991a8ab8c9d12cd9017fdc53f2204516253))
* **cli:** setup and a reaching actor ([#142](https://github.com/clavia-labs/tardigrade/issues/142)) ([5a660f2](https://github.com/clavia-labs/tardigrade/commit/5a660f21d7a775abf6466083b40bc7bb903dda88))
* **cli:** tdg command ([#136](https://github.com/clavia-labs/tardigrade/issues/136)) ([1e3e8c1](https://github.com/clavia-labs/tardigrade/commit/1e3e8c1ee4f3717ca090a2150d6d6cc20650a2ff))
* close the type holes the audit found and reject any ([#10](https://github.com/clavia-labs/tardigrade/issues/10)) ([a3d887e](https://github.com/clavia-labs/tardigrade/commit/a3d887ec0c94d3c4b170477c34f16a73e2a3d875))
* **code:** default seam services ([#64](https://github.com/clavia-labs/tardigrade/issues/64)) ([0d48c70](https://github.com/clavia-labs/tardigrade/commit/0d48c70c8498013d5478ec6dd4001ac6f565a28a))
* **codemode:** optional code mode package and a prose gate ([#6](https://github.com/clavia-labs/tardigrade/issues/6)) ([190be2c](https://github.com/clavia-labs/tardigrade/commit/190be2cb1bf2b849e441971e802416b18e0d40ab))
* **code:** packages flow as values ([#119](https://github.com/clavia-labs/tardigrade/issues/119)) ([eaf07be](https://github.com/clavia-labs/tardigrade/commit/eaf07becb6002cbd531521c7fab98a257ea1ed27))
* **code:** sql runner doc ([#98](https://github.com/clavia-labs/tardigrade/issues/98)) ([17044e5](https://github.com/clavia-labs/tardigrade/commit/17044e57944a36fa7284ed899cc101cbbf721ec3))
* **code:** type package requirements ([#117](https://github.com/clavia-labs/tardigrade/issues/117)) ([1386b55](https://github.com/clavia-labs/tardigrade/commit/1386b553ef9216d45197e8ecb7f12997b7e27f9e))
* **core:** check machine state names at both tiers ([#8](https://github.com/clavia-labs/tardigrade/issues/8)) ([d397467](https://github.com/clavia-labs/tardigrade/commit/d397467445c8f3d5747c114edcb5babfa88d30cc))
* **core:** driver give-up guard spec ([#122](https://github.com/clavia-labs/tardigrade/issues/122)) ([7a354f0](https://github.com/clavia-labs/tardigrade/commit/7a354f0656ea40400d4074a8f7aef8cb3bd3a7e5))
* **core:** facets observe service ([#121](https://github.com/clavia-labs/tardigrade/issues/121)) ([ab1ac93](https://github.com/clavia-labs/tardigrade/commit/ab1ac9317437d133e3894dbe1e55d8f21d9718d6))
* **evolve:** add GEPA harness orchestrator ([#2](https://github.com/clavia-labs/tardigrade/issues/2)) ([609f0fa](https://github.com/clavia-labs/tardigrade/commit/609f0fac361b5ffa5aee2adb2f3d299ed07b2b17))
* **evolve:** make GEPA mutate by model reflection ([#12](https://github.com/clavia-labs/tardigrade/issues/12)) ([0c2b6f0](https://github.com/clavia-labs/tardigrade/commit/0c2b6f0d87157205b37bcedb3f79a72c432b9107))
* **evolve:** track optimization cost ([#4](https://github.com/clavia-labs/tardigrade/issues/4)) ([8f9a11a](https://github.com/clavia-labs/tardigrade/commit/8f9a11ac19532666bafecb4b18296b3e689816de))
* **harness:** let a caller state the model's output ceiling ([#15](https://github.com/clavia-labs/tardigrade/issues/15)) ([55b0404](https://github.com/clavia-labs/tardigrade/commit/55b0404a57ba63fa7fb1c1bce915e2126ea0c5aa))
* **harness:** subagent delegation with session host and derived cost trees ([#5](https://github.com/clavia-labs/tardigrade/issues/5)) ([db97218](https://github.com/clavia-labs/tardigrade/commit/db97218f1b1c1c0573f606a0c70b2a8e05e29e08))
* journal model backoff so a restart can wait out a queue ([#19](https://github.com/clavia-labs/tardigrade/issues/19)) ([868f107](https://github.com/clavia-labs/tardigrade/commit/868f1072c593dd8bb77c6f5697704b759a812143))
* **model:** declared output limits ([#41](https://github.com/clavia-labs/tardigrade/issues/41)) ([4a22ab3](https://github.com/clavia-labs/tardigrade/commit/4a22ab3a7448d093a0e22ef0bde17b8cbe1d0f72))
* **model:** honor retry-after ([#38](https://github.com/clavia-labs/tardigrade/issues/38)) ([0c3ef9f](https://github.com/clavia-labs/tardigrade/commit/0c3ef9f5599b5075a150522d58057b500607c365))
* **model:** tunable stream bounds ([#54](https://github.com/clavia-labs/tardigrade/issues/54)) ([b3ef1e0](https://github.com/clavia-labs/tardigrade/commit/b3ef1e0d62c93f465063f4489f432ef03e7ee133))
* **model:** wire-reported cost provenance ([#67](https://github.com/clavia-labs/tardigrade/issues/67)) ([8d86873](https://github.com/clavia-labs/tardigrade/commit/8d86873f73141549e6ad3877de7b997f5e357a51))
* publish as tardie ([#147](https://github.com/clavia-labs/tardigrade/issues/147)) ([b020b2c](https://github.com/clavia-labs/tardigrade/commit/b020b2c8a3e1100606836a4eac89731211ed08f3))
* publish to npm ([#80](https://github.com/clavia-labs/tardigrade/issues/80)) ([73386a8](https://github.com/clavia-labs/tardigrade/commit/73386a862ef7f69135b977f08c7e8fc1ed0689e7))
* reserve model spend and project per-request options ([#21](https://github.com/clavia-labs/tardigrade/issues/21)) ([60dd9e6](https://github.com/clavia-labs/tardigrade/commit/60dd9e6d111c04797077c92627650b8d5abe1b92))
* **server:** self host api ([#129](https://github.com/clavia-labs/tardigrade/issues/129)) ([c8189ca](https://github.com/clavia-labs/tardigrade/commit/c8189ca48b4c695bb470fa071cc97ee12ada5edd))
* span pass and tracer seam ([#52](https://github.com/clavia-labs/tardigrade/issues/52)) ([b99334d](https://github.com/clavia-labs/tardigrade/commit/b99334db4cfb071dd6206003f394483867cc7121))
* unify npm package ([#100](https://github.com/clavia-labs/tardigrade/issues/100)) ([e0bfa37](https://github.com/clavia-labs/tardigrade/commit/e0bfa37d4415a2fe6e83e0d46291995e4d5becc3))
* **voyager:** refine actor navigation ([#151](https://github.com/clavia-labs/tardigrade/issues/151)) ([81302f3](https://github.com/clavia-labs/tardigrade/commit/81302f387e886c7147901ca9481895a7dc230f13))
* **voyager:** render native API ([#153](https://github.com/clavia-labs/tardigrade/issues/153)) ([a92cd3b](https://github.com/clavia-labs/tardigrade/commit/a92cd3b4c7b1d112c9095ad8a718845da47a600b))
* **voyager:** trajectory explorer ui ([#133](https://github.com/clavia-labs/tardigrade/issues/133)) ([226514a](https://github.com/clavia-labs/tardigrade/commit/226514aa5f9760f49953929e4868fbbaecbaf38b))
* **voyager:** window brush and chrome ([#134](https://github.com/clavia-labs/tardigrade/issues/134)) ([657c112](https://github.com/clavia-labs/tardigrade/commit/657c112497eccc402e1f7a63ff50583c795a664a))


### Bug Fixes

* **agent:** compact inside a turn ([#49](https://github.com/clavia-labs/tardigrade/issues/49)) ([34e5fb6](https://github.com/clavia-labs/tardigrade/commit/34e5fb6babf34f5fc9395d2b1c997d7269649487))
* carry provider reasoning state across turns ([#17](https://github.com/clavia-labs/tardigrade/issues/17)) ([cf9c7b6](https://github.com/clavia-labs/tardigrade/commit/cf9c7b6e28df0304c76f93a4cb871e639517b5f3))
* **cli:** prepare npm release ([#155](https://github.com/clavia-labs/tardigrade/issues/155)) ([4f54bbd](https://github.com/clavia-labs/tardigrade/commit/4f54bbd8cda722ecb0c3d447ac06a33039e5d119))
* continue truncated answers and compact before a request that will not fit ([#23](https://github.com/clavia-labs/tardigrade/issues/23)) ([e72f947](https://github.com/clavia-labs/tardigrade/commit/e72f9476841389747abc62b87cb13fe9aa55f0fe))
* **examples:** codeModeFor options form ([#130](https://github.com/clavia-labs/tardigrade/issues/130)) ([277ec40](https://github.com/clavia-labs/tardigrade/commit/277ec40ab0be0c5c5cbf901fdba65d88944d8c87))
* handle published dry runs ([#104](https://github.com/clavia-labs/tardigrade/issues/104)) ([2da1dae](https://github.com/clavia-labs/tardigrade/commit/2da1dae40afd4ba16dd25c4d237367cf85de4a99))
* **harness:** cancel a timed-out request and separate a broken proposer from a declined one ([#14](https://github.com/clavia-labs/tardigrade/issues/14)) ([73197ba](https://github.com/clavia-labs/tardigrade/commit/73197ba9c17a5368c72a779fdea9ed4a2f2702e2))
* **harness:** stop truncating what nobody asked to truncate ([#13](https://github.com/clavia-labs/tardigrade/issues/13)) ([b5d3c11](https://github.com/clavia-labs/tardigrade/commit/b5d3c11e6b5f4747a05b356791d81ac2916196f4))
* honour routes on the OpenAI-compatible gateway path ([#20](https://github.com/clavia-labs/tardigrade/issues/20)) ([678bba4](https://github.com/clavia-labs/tardigrade/commit/678bba4f01cee14ba67a2b913a6ca32075784cb0))
* **host:** type thread layers ([#57](https://github.com/clavia-labs/tardigrade/issues/57)) ([f615244](https://github.com/clavia-labs/tardigrade/commit/f61524401218f878786744a65ba7666c026fbbab))
* install stable package ([#157](https://github.com/clavia-labs/tardigrade/issues/157)) ([ad13106](https://github.com/clavia-labs/tardigrade/commit/ad1310604dafca7de6e9bd3cd4503fca2eb85029))
* **model:** key per ceiling rung ([#42](https://github.com/clavia-labs/tardigrade/issues/42)) ([5567ef7](https://github.com/clavia-labs/tardigrade/commit/5567ef7e5fa4dbd0d3df39d3b3e9bc48940e0b87))
* **model:** truncation fails loudly ([#39](https://github.com/clavia-labs/tardigrade/issues/39)) ([6d664c5](https://github.com/clavia-labs/tardigrade/commit/6d664c5bb78d7ea54a7bd9d3a25029c21dfc9cbf))
* read limits from the model, and fail where a guess would have been quiet ([#18](https://github.com/clavia-labs/tardigrade/issues/18)) ([8bb0941](https://github.com/clavia-labs/tardigrade/commit/8bb09416dafb1b72830749630d9ef7ba863ab9fd))
* track unified release scope ([#105](https://github.com/clavia-labs/tardigrade/issues/105)) ([b6fbdc3](https://github.com/clavia-labs/tardigrade/commit/b6fbdc343ad2aeb9cc17419915540e92bec6a04d))
* **voyager:** refine actor navigation ([#152](https://github.com/clavia-labs/tardigrade/issues/152)) ([ebb1e4d](https://github.com/clavia-labs/tardigrade/commit/ebb1e4d6975baebbf2ea4a1001cdcf8e5d993d27))
* **voyager:** refine API presentation ([#154](https://github.com/clavia-labs/tardigrade/issues/154)) ([0dcd42e](https://github.com/clavia-labs/tardigrade/commit/0dcd42ea7165b82b66167985c2d4bc93bb0e38cd))


### Code Refactoring

* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127)) ([210c170](https://github.com/clavia-labs/tardigrade/commit/210c17019d9543d3037a3f7b92d10122e56ef3e0))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125)) ([7d1dd73](https://github.com/clavia-labs/tardigrade/commit/7d1dd7319c9f2dc057252245b6fe14ca85072fb6))
* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141)) ([caccf62](https://github.com/clavia-labs/tardigrade/commit/caccf6278349731efa9ecc42d3f6c02676b11ab2))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139)) ([1964226](https://github.com/clavia-labs/tardigrade/commit/196422653959b51fdc6a9ade264beb90959175ed))
* drive every model through the AI SDK, and settle each attempt once ([#22](https://github.com/clavia-labs/tardigrade/issues/22)) ([c83e552](https://github.com/clavia-labs/tardigrade/commit/c83e5522ae0cd11f3edc9ece8d95e54cfef4d9a6))
* v6 core with platform bindings ([#24](https://github.com/clavia-labs/tardigrade/issues/24)) ([0c0f9d6](https://github.com/clavia-labs/tardigrade/commit/0c0f9d6b7992f5b53dffed7940539f40fb8aa8c2))

## [0.2.0-rc.1](https://github.com/clavia-labs/tardigrade/compare/v0.2.0-rc...v0.2.0-rc.1) (2026-08-21)


### Bug Fixes

* **dev:** refresh pushed actors ([#176](https://github.com/clavia-labs/tardigrade/issues/176)) ([7dde017](https://github.com/clavia-labs/tardigrade/commit/7dde017cb155b94f914903d559f93c43de23b274))

## [0.2.0-rc](https://github.com/clavia-labs/tardigrade/compare/v0.1.0...v0.2.0-rc) (2026-08-21)


### Features

* **cli:** add actor template ([#160](https://github.com/clavia-labs/tardigrade/issues/160)) ([22740f4](https://github.com/clavia-labs/tardigrade/commit/22740f41eabcac396cca9e885d77d6830ade2d2f))
* **cli:** add init command ([#162](https://github.com/clavia-labs/tardigrade/issues/162)) ([b191d22](https://github.com/clavia-labs/tardigrade/commit/b191d22a00794c1f2d6797bc5f4642633c645a5e))
* **cli:** guide actor onboarding ([#166](https://github.com/clavia-labs/tardigrade/issues/166)) ([5be3082](https://github.com/clavia-labs/tardigrade/commit/5be3082b9860e3380d2ce816a37ba1d06ba2b0c9))
* **voyager:** add event inspector ([#165](https://github.com/clavia-labs/tardigrade/issues/165)) ([fc24fda](https://github.com/clavia-labs/tardigrade/commit/fc24fda848a49844975700bbf14a13b90ebc2cd4))
* **voyager:** show actor digest ([#164](https://github.com/clavia-labs/tardigrade/issues/164)) ([80f5f70](https://github.com/clavia-labs/tardigrade/commit/80f5f70deb81708198e7b8bd08a8d8cd2af65fbb))

## [0.1.0](https://github.com/clavia-labs/tardigrade/compare/v0.1.0-rc.1...v0.1.0) (2026-08-21)


### Bug Fixes

* install stable package ([#157](https://github.com/clavia-labs/tardigrade/issues/157)) ([ad13106](https://github.com/clavia-labs/tardigrade/commit/ad1310604dafca7de6e9bd3cd4503fca2eb85029))

## [0.1.0-rc.1](https://github.com/clavia-labs/tardigrade/compare/v0.1.0-rc...v0.1.0-rc.1) (2026-08-20)


### ⚠ BREAKING CHANGES

* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139))
* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125))

### Features

* **actors:** build and push ([#149](https://github.com/clavia-labs/tardigrade/issues/149)) ([a48321b](https://github.com/clavia-labs/tardigrade/commit/a48321bff18dce045dbfd47c5e4674d0198852f7))
* **cli:** dev asks for a model ([#143](https://github.com/clavia-labs/tardigrade/issues/143)) ([3102f61](https://github.com/clavia-labs/tardigrade/commit/3102f61add932a1b746f7eecfa590aae0adfb0f9))
* **client:** derive the sdk from the api ([#135](https://github.com/clavia-labs/tardigrade/issues/135)) ([193c839](https://github.com/clavia-labs/tardigrade/commit/193c839398861af04d3036ee569027b1c29c95b7))
* **cli:** finish local quickstart ([#148](https://github.com/clavia-labs/tardigrade/issues/148)) ([f8d3c4b](https://github.com/clavia-labs/tardigrade/commit/f8d3c4b34521979e04acaa80bbff533968074382))
* **cli:** list available actors ([#150](https://github.com/clavia-labs/tardigrade/issues/150)) ([93dc099](https://github.com/clavia-labs/tardigrade/commit/93dc0991a8ab8c9d12cd9017fdc53f2204516253))
* **cli:** setup and a reaching actor ([#142](https://github.com/clavia-labs/tardigrade/issues/142)) ([5a660f2](https://github.com/clavia-labs/tardigrade/commit/5a660f21d7a775abf6466083b40bc7bb903dda88))
* **cli:** tdg command ([#136](https://github.com/clavia-labs/tardigrade/issues/136)) ([1e3e8c1](https://github.com/clavia-labs/tardigrade/commit/1e3e8c1ee4f3717ca090a2150d6d6cc20650a2ff))
* **code:** packages flow as values ([#119](https://github.com/clavia-labs/tardigrade/issues/119)) ([eaf07be](https://github.com/clavia-labs/tardigrade/commit/eaf07becb6002cbd531521c7fab98a257ea1ed27))
* **code:** type package requirements ([#117](https://github.com/clavia-labs/tardigrade/issues/117)) ([1386b55](https://github.com/clavia-labs/tardigrade/commit/1386b553ef9216d45197e8ecb7f12997b7e27f9e))
* **core:** driver give-up guard spec ([#122](https://github.com/clavia-labs/tardigrade/issues/122)) ([7a354f0](https://github.com/clavia-labs/tardigrade/commit/7a354f0656ea40400d4074a8f7aef8cb3bd3a7e5))
* **core:** facets observe service ([#121](https://github.com/clavia-labs/tardigrade/issues/121)) ([ab1ac93](https://github.com/clavia-labs/tardigrade/commit/ab1ac9317437d133e3894dbe1e55d8f21d9718d6))
* publish as tardie ([#147](https://github.com/clavia-labs/tardigrade/issues/147)) ([b020b2c](https://github.com/clavia-labs/tardigrade/commit/b020b2c8a3e1100606836a4eac89731211ed08f3))
* **server:** self host api ([#129](https://github.com/clavia-labs/tardigrade/issues/129)) ([c8189ca](https://github.com/clavia-labs/tardigrade/commit/c8189ca48b4c695bb470fa071cc97ee12ada5edd))
* **voyager:** refine actor navigation ([#151](https://github.com/clavia-labs/tardigrade/issues/151)) ([81302f3](https://github.com/clavia-labs/tardigrade/commit/81302f387e886c7147901ca9481895a7dc230f13))
* **voyager:** render native API ([#153](https://github.com/clavia-labs/tardigrade/issues/153)) ([a92cd3b](https://github.com/clavia-labs/tardigrade/commit/a92cd3b4c7b1d112c9095ad8a718845da47a600b))
* **voyager:** trajectory explorer ui ([#133](https://github.com/clavia-labs/tardigrade/issues/133)) ([226514a](https://github.com/clavia-labs/tardigrade/commit/226514aa5f9760f49953929e4868fbbaecbaf38b))
* **voyager:** window brush and chrome ([#134](https://github.com/clavia-labs/tardigrade/issues/134)) ([657c112](https://github.com/clavia-labs/tardigrade/commit/657c112497eccc402e1f7a63ff50583c795a664a))


### Bug Fixes

* **cli:** prepare npm release ([#155](https://github.com/clavia-labs/tardigrade/issues/155)) ([4f54bbd](https://github.com/clavia-labs/tardigrade/commit/4f54bbd8cda722ecb0c3d447ac06a33039e5d119))
* **examples:** codeModeFor options form ([#130](https://github.com/clavia-labs/tardigrade/issues/130)) ([277ec40](https://github.com/clavia-labs/tardigrade/commit/277ec40ab0be0c5c5cbf901fdba65d88944d8c87))
* **voyager:** refine actor navigation ([#152](https://github.com/clavia-labs/tardigrade/issues/152)) ([ebb1e4d](https://github.com/clavia-labs/tardigrade/commit/ebb1e4d6975baebbf2ea4a1001cdcf8e5d993d27))
* **voyager:** refine API presentation ([#154](https://github.com/clavia-labs/tardigrade/issues/154)) ([0dcd42e](https://github.com/clavia-labs/tardigrade/commit/0dcd42ea7165b82b66167985c2d4bc93bb0e38cd))


### Code Refactoring

* **agent:** codeModeFor options object ([#127](https://github.com/clavia-labs/tardigrade/issues/127)) ([210c170](https://github.com/clavia-labs/tardigrade/commit/210c17019d9543d3037a3f7b92d10122e56ef3e0))
* **agent:** drop rlm assembly ([#125](https://github.com/clavia-labs/tardigrade/issues/125)) ([7d1dd73](https://github.com/clavia-labs/tardigrade/commit/7d1dd7319c9f2dc057252245b6fe14ca85072fb6))
* **api:** drop the turn routes ([#141](https://github.com/clavia-labs/tardigrade/issues/141)) ([caccf62](https://github.com/clavia-labs/tardigrade/commit/caccf6278349731efa9ecc42d3f6c02676b11ab2))
* **api:** name actors and threads ([#139](https://github.com/clavia-labs/tardigrade/issues/139)) ([1964226](https://github.com/clavia-labs/tardigrade/commit/196422653959b51fdc6a9ade264beb90959175ed))

## [0.1.0-rc](https://github.com/clavia-labs/tardigrade/compare/v0.0.2-rc...v0.1.0-rc) (2026-08-20)


### Features

* **agent:** harden inference recovery ([#108](https://github.com/clavia-labs/tardigrade/issues/108)) ([c9367fd](https://github.com/clavia-labs/tardigrade/commit/c9367fdbc1b0884d2fcc9693ad64012b7fe380a5))
