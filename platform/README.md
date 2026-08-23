# platform

The packages state contracts and semantics: the log, the reconciler, the code lane, the agent,
and the ports they leave open (EventLog, Router, Sandbox, Infer). A package depends on effect
and on other packages, and on nothing else. That invariant is the line between the two trees.

A platform binds one port to the world. A binding that delivers events also stamps the sending span's context onto each event it persists (one traceparent string, first stamp wins), or every cross-lane trace it serves arrives fragmented. Storage and delivery on Cloudflare, a model provider
behind Infer, a Bun process: each binding is one subdirectory here, and it owns its own
dependencies. `packages/host` stays a package by the same rule: the reference runtime is
in-memory and dependency-free, and it is the executable contract a platform binding is tested
against.

Nothing lives here yet. `platform/model` (the Infer binding over the AI SDK) is the first
planned tenant; `platform/bun` binds the log to SQLite through @effect/sql-sqlite-bun, binds the workspace a bounded value spills to (docs/explanations/boundary.md) to a table in that same database, so an event and the value it points at are one file, and binds the workspace's sql verb to a second database beside it, where the model's own tables are durable and the log is out of a wrong statement's reach (docs/how-to/workspace.md); `platform/cloudflare` arrives with the v6 extraction.
