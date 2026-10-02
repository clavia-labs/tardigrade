<p align="left">
  <br>
  <img alt="Tardie, the Tardigrade mascot" src="assets/mascot/tardie-normal.svg" width="160">
</p>

<p align="left">
  <a href="https://www.npmjs.com/package/tardie"><img alt="npm version" src="https://img.shields.io/npm/v/tardie.svg"></a>
  <a href="https://discord.gg/Z74jwRxz4k"><img alt="Join Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&amp;logoColor=white"></a>
</p>

> [!WARNING]
> Tardigrade is under active development. APIs may change.

# Tardigrade

Tardigrade is a typescript framework for building composable agents around an immutable event log. It is built on [Effect TS](https://effect.website/) and takes a functional approach to managing agent state and effects, drawing inspiration from [Elm](https://elm-lang.org/), and [Jotai](https://jotai.org/).

<p align="center"><code>{ view, effects } = f(event log)</code></p>

## Quickstart

```sh
bun add tardie
```

For coding agents, use the [Tardigrade skill](https://github.com/clavia-labs/tardigrade/blob/main/skills/tardigrade/SKILL.md).

### Atoms hold state

Use atoms to store values for other atoms to use.

```ts
import { atom } from "tardie/core"

const role = atom("You are a research assistant.")
const style = atom("Cite your sources and keep answers concise.")
```

Derive values from atoms using `get`.

```ts
const system = atom(get => `${get(role)}\n${get(style)}`)
```

### Durable atoms reduce state from event log

Durable atoms reduce an immutable event log into state.

```ts
import { Schema } from "effect"
import { durableAtom } from "tardie/core"
import { Event, TrajectoryState, trajectoryState } from "tardie/agent"

const history = durableAtom({
  name: "researcher.history",
  input: Event,
  schema: TrajectoryState,
  initial: { entries: [], models: [] },
  reduce: trajectoryState,
})

const messages = atom(get => get(history).entries.map(entry => entry.message))
```

### Effect atoms propose actions

Effect atoms derive views and propose actions.

Simplified [`compact`](packages/agent/src/atoms/compact.ts):

```ts
const compact = messages => effectAtom(get => {
  const history = get(messages)
  const state = get(compactionState)
  const context = prepareMessages(history, state)
  const shouldSummarize = !state.pending && exceedsThreshold(context)

  return {
    view: { messages: context, compacting: Boolean(state.pending) },
    events: {},
    acts: shouldSummarize ? { summarize: summarizeRequest(context, state) } : {},
  }
})
```

Recorded results update durable compaction state.

### It's atoms all the way

Compose the atoms into an agent actor.

```ts
import { Effect } from "effect"
import { defineActor } from "tardie/core"
import { agentMethods, compact, infer, tools as libraryTools } from "tardie/agent"

const researcher = defineActor("researcher", Effect.gen(function* () {
  const tools = yield* libraryTools()
  const context = yield* compact(messages, {
    triggerRatio: 0.8,
    retainRatio: 0.5,
  })
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))

  return { atom: agent, methods: agentMethods }
}))
```

```text
event log -> history -> messages -> compact --+
                                              |
                                    system ---+-> infer -> researcher
                                              |
                                     tools ---+
```

Hosting: [Bun](packages/examples/bun.ts), [services](packages/examples/services.ts), [Cloudflare](packages/examples/cloudflare.ts).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
