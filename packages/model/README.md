# Model package

`modelLayer` connects host configuration and catalog selection to inference. `inferenceLayer` binds a provider directly.

```text
src/
  index.ts          Public entry point
  config.ts         Host configuration validation
  host.ts           Model layer assembly
  selection.ts      Model selection and access policy
  catalog/          Discovery, metadata, storage, and pagination
  providers/        Protocol options, provider layers, and Bedrock
  inference/        Requests, responses, output, usage, and observers
  testing/          Shared provider fixtures
```

Tests sit beside the modules they cover. Shared fixtures are excluded from the published package. The export map retains established flat catalog paths.

The package uses `@tardie/ai` and the scoped provider packages. Hosts install `effect` through the pinned `@tardie/effect` alias. Dynamic tools use native encoded schemas, and the shared provider wrapper supplies deferred validation and response formats.
