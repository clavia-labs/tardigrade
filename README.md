<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Tardigrade logo: a tardigrade drawn from overlapping circles" src="docs/assets/logo-light.svg" width="170">
  </picture>
</p>

# Tardigrade

Build durable agents by composing small, inspectable capabilities.

[React derives interfaces from components that interpret state](https://react.dev/learn#creating-and-nesting-components). Tardigrade derives model context from capabilities that interpret the event log. Those capabilities also handle model calls and derive durable state transitions.

## Why Tardigrade

- **Compose the harness.** Add tools, code execution, budgets, compaction, and replies as independent capabilities.
- **Keep composition strongly typed.** TypeScript carries each capability's service requirements into the host. Missing services fail during typechecking.
- **Build on Effect.** Typed services and Layers make dependencies explicit. Managed lifecycles, structured concurrency, and tracing share one runtime.
- **Resume after a crash.** A durable host derives unfinished work from the stored log.
- **Run beyond one context window.** Compaction bounds model context while the workspace keeps larger values available.
- **Inspect every run.** The complete log supports debugging, replay, and experiments with copied logs.

## Quickstart

Use Bun 1.3 or later and an OpenAI-compatible or Bedrock model endpoint.

```bash
bun add @clavia/tardigrade
```

You can use `npm install @clavia/tardigrade` instead. Install `@clavia/tardigrade@next` to test a release candidate.

### Create a capability

An agent is made of capabilities. This capability gives the model one native tool and its handler:

```ts
import { Effect } from "effect"
import { toolList } from "@clavia/tardigrade"

const deploys = toolList([
  {
    spec: {
      name: "recent_deploys",
      description: "List recent production deploys",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    run: () =>
      Effect.succeed([
        { service: "api", revision: "a17c", summary: "Add rate limiting" }
      ])
  }
])
```

`spec` tells the model when and how to call the tool. `run` handles the call. Replace the sample result with an Effect that calls your deployment API.

The call follows one route:

1. `toolList` adds `recent_deploys` to the next model request.
2. The model selects it and returns a tool call. Tardigrade records `ToolCalled` in the log.
3. The shared router asks each mounted capability to handle the call. `toolList` matches the name and runs `run`.
4. Tardigrade records `ToolReturned`. The next model request includes the result.

### Compose an agent

Mount the capability beside the built-in parts that this task needs:

```ts
import { agentOf, budget, codeMode, compaction, reply } from "@clavia/tardigrade"

const releaseAnalyst = agentOf([
  deploys,     // recent_deploys and its handler
  codeMode,    // durable JavaScript execution
  budget,      // a per-turn code budget
  compaction,  // bounded model context
  reply        // results for parent agents
])
```

`agentOf` combines every model-facing part and runtime handler. The model sees `recent_deploys` and `execute` in one request. Policy capabilities react to the same log.

This agent can inspect deployments, analyze results with JavaScript, compact a long investigation, and report to a parent agent. Change the list to create another harness.

A run can follow this path:

```text
MessageReceived -> recent_deploys -> execute -> TurnCompleted
```

Each action and result becomes an event that every capability can interpret.

### Run the composition

<details>
<summary>Bind a model and durable SQLite host</summary>

The three code blocks form one program.

```ts
import { infer } from "@clavia/tardigrade/model"
import { createBunHost } from "@clavia/tardigrade/bun/host"

const model = infer({
  baseUrl: process.env.MODEL_BASE_URL!,
  apiKey: process.env.MODEL_API_KEY!,
  model: process.env.MODEL_ID!
})

const host = await createBunHost({
  log: "agents.sqlite",
  actorFor: () => releaseAnalyst,
  layersFor: () => model
})

await host.deliver("bun:main", {
  type: "MessageReceived",
  id: "m1",
  text: "What changed in the deploy?",
  at: Date.now()
})
await host.drive()

const completed = (await host.read("main")).findLast(
  (event) => event.type === "TurnCompleted"
)
console.log(completed)
await host.close()
```

The model binding uses the OpenAI-compatible protocol by default. Add `provider: "bedrock"` to the model options for Bedrock.

</details>

## How durability works

Every message, model action, tool result, and checkpoint lands in the log. Reactors read that log and derive keyed transitions.

$$\lbrace\mathrm{transitions}\rbrace = f(\mathrm{log})$$

The host runs transitions with unrecorded keys. It appends the returned events and repeats until the agent rests.

If the process stops during `recent_deploys`, the log still contains its unanswered `ToolCalled`. `host.recover()` derives the same key and input, then runs the handler again.

Effects have at-least-once execution. Each keyed result is recorded once. Providers can use the transition key as an idempotency key.

## Learn more

- [Quickstart](docs/quickstart.md): build the event loop and its agent capabilities from first principles.
- [Why Tardigrade](docs/explanations/why.md): learn what the log-as-state model makes possible.
- [Publishing](docs/how-to/publish.md): publish release candidates and stable releases to npm.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
