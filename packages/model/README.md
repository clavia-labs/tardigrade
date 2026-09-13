# Model package

`modelLayer` connects host configuration and catalog selection to inference. `inferenceLayer` binds a provider directly.

```text
src/
  index.ts          Public entry point
  config.ts         Host configuration validation
  host.ts           Model layer assembly
  selection.ts      Model selection and access policy
  catalog/          Discovery, metadata, storage, and pagination
  providers/        Provider composition, options, and gateway transport
  services.ts       Effect LanguageModel and request settings
  stream/           Collection, timeouts, and observation
  testing/          Shared provider fixtures
```

Tests sit beside the modules they cover. Shared fixtures are excluded from the published package. The export map retains established flat catalog paths.

The package uses `@tardie/ai` and the scoped provider packages. Bedrock hosts install the optional `@tardie/ai-bedrock` peer; Cloudflare gateway hosts also install the declared Smithy transport peers. Hosts install upstream `effect@4.0.0-rc.115`. Dynamic tools use native encoded schemas, and the shared provider wrapper supplies deferred validation and response formats.

The agent inference component translates turns in `src/inference/model/`. Compaction owns its summary translation in `src/component/compaction/model.ts`. Both consume Effect's `LanguageModel` service. Provider assembly and catalog selection stay in this package. Other libraries connect through a bridge that implements `LanguageModel`.

Provider integration tests live under `providers/`. Bedrock wire translation and its tests live in the Effect fork’s `@tardie/ai-bedrock` package. Agent integration tests live under `packages/agent/src/inference/integration/`. Request policy and observer tests live under `stream/`.

## Request configuration

Set request options through `modelLayer`'s `configure` callback or pass them to `inferenceLayer`. Each option has an exported default in `tardie/model/request-policy`. The overall attempt deadline is optional.

```ts
{
  maxOutputTokens: 4096,
  timeout: {
    firstChunkMs: 90_000,
    idleMs: 90_000,
    attemptMs: 180_000
  },
  retry: {
    backoffMs: [1000, 3000],
    maxRetryAfterMs: 60_000,
    retryAfterJitterMs: 250
  }
}
```

Each backoff entry permits one retry. Its value is the ceiling for a random wait when the provider supplies no delay. A provider delay above `maxRetryAfterMs` ends retries. An accepted provider delay receives up to `retryAfterJitterMs` additional waiting time.

The interpreter uses current configuration after recovery. A recorded retry keeps its `dueAt`. `ModelCalled` records pricing separately for cost estimates. `ModelReturned` stores serialized Effect errors and prompt continuations. Historical envelopes remain available through the upcaster.
