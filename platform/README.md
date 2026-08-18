# platform

A platform binds the packages to one real place. The packages state the semantics: the log, the
reconciler, the code lane, the agent. A platform supplies the ports for one environment: storage,
delivery, the alarm, the model. `packages/host` is the reference in-memory binding: it is the
executable statement every platform must match, and the conformance tests run against it.

This directory holds one subdirectory per environment (`platform/cloudflare`, `platform/node`).
It is empty until a binding lands.
