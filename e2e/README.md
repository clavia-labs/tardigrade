# End-to-end tests

This workspace holds a small set of journeys whose ownership crosses top-level packages. A journey starts from a public actor or application boundary, creates a fresh environment, uses deterministic seams for systems outside the repository, and asserts the visible result plus durable trace invariants.

Place focused component, protocol, and package integration tests beside their source. Add a journey here when a failure could arise from the composition of several top-level packages and the complete path is itself a supported contract.

`actor/harness.ts` creates an isolated in-process host with a real store, sandbox, router, and reconciler. Actor journeys replace only inference, which keeps the suite deterministic while exercising the runtime graph. A scenario owns its actor assembly and scripted decisions so its behavior can be understood from one file.

The actor graph journey covers concurrent foreground children, background work, structured output, budget exhaustion, grant and denial decisions, durable outgoing actor calls, response aggregation, and graph quiescence.

Run this workspace with `bun run e2e`. The repository gate runs it as `test:e2e`, type-checks it as `typecheck:e2e`, and applies the Effect rules as `lint:effect:e2e`.
