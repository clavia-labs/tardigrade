# Observability

The event log contains the evidence needed to understand a session. Derived views stay reproducible because they are projections.

## Read the Current Log

```ts
const log = await Effect.runPromise(Effect.provide(agent.log, runtime))
```

`runtime-memory` exposes only the currently bound in-process session. Durable session discovery is waiting on a persistent runtime.

## Human Transcript

```ts
import { transcript } from "flamecast-core/harness"

console.log(transcript(log))
```

The transcript formats known event fields and preserves unknown event facts.

## Inspect the Model Request

```ts
const request = agent.request(log)
```

This shows the static system prefix, compacted conversation, active tail nudges, and current tools without calling a provider.

## Inspect Module State

```ts
import { Context } from "effect"
import { InferenceStateProjection } from "flamecast-core/harness"

const selected = Context.get(agent.services, InferenceStateProjection)(log)
```

Effect construction services expose typed module values, including projections. Machine state can be reconstructed with `foldOf(machine, log)`.

## Replay

```ts
const replayed = await Effect.runPromise(
  Effect.provide(agent.replay(recorded), runtime)
)
```

Replay appends the recording and settles. When every effect already has a committed consequence, no provider or tool runs again.

## Branch a Recording

```ts
const branch = candidateAgent.branch(recorded, { at: 9, id: "candidate:17" })
const result = await Effect.runPromise(Effect.provide(branch.replay([]), runtime))
const branchLog = await Effect.runPromise(Effect.provide(branch.log, runtime))
```

The branch uses a private in-memory log. Its writes cannot change `recorded` or the runtime session that supplied it.

## Fork the Current Session

```ts
const fork = await Effect.runPromise(Effect.provide(agent.fork({ at: 9 }), runtime))
```

Fork reads the bound session and creates the same independent branch shape.

## Compare Programs

`flamecast-core/evolve` can compare pure observations on a finite corpus and find the first recorded model-call prefix whose request changes. [Evolution](evolution.md) covers the guarantees and limits.

## Telemetry

Core defines a `Sink` port, and the memory runtime binds a no-op implementation. No harness path currently emits sink records. External telemetry can project the stored log until a sink-producing module or runtime integration is added.
