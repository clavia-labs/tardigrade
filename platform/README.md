# Platform adapters

`platform/` contains runtime-specific adapters. `packages/core` defines actor contracts and execution rules. `packages/host` supplies shared hydration, delivery, and execution machinery. `packages/http` serves hosts over HTTP, and `packages/model` supplies model bindings and provider adapters.

`bun` stores each actor instance's directory in SQLite and gives each thread its own event log, workspace, runtime, and alarm state. Workspace SQL uses a separate database so model queries cannot alter the event log.

[`cloudflare`](cloudflare/README.md) mounts each thread in a SQLite Durable Object and schedules execution through immediate passes and alarm watchdogs. Celld runs this binding through its compatible Durable Object surface.

[`worker-loader`](worker-loader/README.md) binds Sandbox to loaded Worker isolates on workerd and Celld.
