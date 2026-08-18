# Observability

The event log contains the evidence needed to understand a session. Derived views stay reproducible because they are projections.

## Read the Current Log

```ts
const log = await Effect.runPromise(Effect.provide(agent.log, runtime))
```

`runtime-in-memory` exposes the currently bound process-local session. Durable session discovery across process restarts requires a persistent runtime.

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

Effect construction services expose typed module values, including projections. Machine state can be reconstructed with `foldOf(machine, log)`. `RequestOptionsProjection` is the same kind of service: a module contributes a fold, and `agent.request(log).options` is what that fold chose.

## Replay

```ts
const replayed = await Effect.runPromise(
  Effect.provide(agent.replay(recorded), runtime)
)
```

Replay appends the recording and settles. When every effect already has a committed consequence, no provider or tool runs again.

## Branch a Recording

```ts
const branch = alternateAgent.branch(recorded, { at: 9, id: "alternate:17" })
const result = await Effect.runPromise(Effect.provide(branch.replay([]), runtime))
const branchLog = await Effect.runPromise(Effect.provide(branch.log, runtime))
```

The branch uses a private in-memory log. Its writes cannot change `recorded` or the runtime session that supplied it.

## Fork the Current Session

```ts
const fork = await Effect.runPromise(Effect.provide(agent.fork({ at: 9 }), runtime))
```

Fork reads the bound session and creates the same independent branch shape.

## Cost Projections

```ts
import { toolCallsOf, treeUsageIn, usageIn } from "flamecast-core/harness"

const usage = usageIn(log, "m-1")
const total = treeUsageIn(log, "m-1")
const toolCalls = toolCallsOf(log)
```

`usageIn(log, turn)` sums the prompt tokens, completion tokens, and provider cost for one turn. `settled` comes from `ModelReturned`. `unsettled` comes from a `ModelCalled` still in flight and from a `ModelSettled` that closed an attempt without a result. `costUsd` is present when every part of that total is known. A provider that reported zero is free. A provider that omitted cost leaves `costUsd` absent unless a price table filled it.

`treeUsageIn(log, turn)` adds the usage every sub-agent result reported, and a child reports its own tree usage, so the sum covers the whole delegation tree from one log.

`toolCallsOf(log)` counts work-tool calls in any log span. It uses the budget rules, so `answer` and `request-budget` calls have zero tool cost.

## Across Sessions

A swarm is a set of session logs, and the [`Sessions`](runtimes.md#port-contract) port is the read side: `list` gives the addresses the runtime serves and `read(address)` gives one session's evidence. Each inbound head's `origin` names the session, turn, and call that sent it, so the delegation tree is a projection over the set of logs, and every single-session view on this page applies per session.
