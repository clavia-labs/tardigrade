# Worker Loader platform

This binding runs the Sandbox port in a fresh Worker Loader isolate. Capability transport carries package calls through a Durable Object stub on workerd. Replay transport carries the same calls as JSON boundaries on Celld.

## Verify

```bash
bun run --cwd platform/worker-loader typecheck
bun run --cwd platform/worker-loader test
bun run --cwd platform/worker-loader test:workers
bun run --cwd platform/worker-loader test:celld
```

`test:workers` runs the runtime suite on workerd. `test:celld` requires a running Apple Container service and runs the shared replay case on Celld with a loaded Worker limit of one. It starts a local object store, deploys the fixture, verifies the result through HTTP, and removes its generated containers, network, and deploy image. Set `TARDIGRADE_CELLD_IMAGE`, `TARDIGRADE_CELLD_NODE_IMAGE`, `TARDIGRADE_CELLD_ESBUILD_VERSION`, `TARDIGRADE_CELLD_STORE_IMAGE`, `TARDIGRADE_CELLD_STORE_CLIENT_IMAGE`, `TARDIGRADE_CELLD_LOADED_WORKER_LIMIT`, `TARDIGRADE_CELLD_PORT`, or `TARDIGRADE_CELLD_TIMEOUT_MILLIS` to override a test dependency or policy.

`DEFAULT_WORKER_LOADER_SANDBOX_POLICY` exposes the loaded Worker compatibility date, compatibility flags, console cap, outbound policy, and transport. `layerWorkerLoaderSandbox` accepts overrides for each value.
