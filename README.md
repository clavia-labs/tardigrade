<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Tardigrade logo: a tardigrade drawn from overlapping circles" src="docs/assets/logo-light.svg" width="170">
  </picture>
</p>

# Tardigrade

A durable and modular agent harness built for self-improvement.

### A harness made for self-improvement
As models get increasingly smart, they will be capable of writing their own harnesses to improve themselves ([Meta-Harness](https://arxiv.org/abs/2603.28052)). A harness that is too rigid and complex is a hindrance to this. We need something more composable, and easy to author.

We took inspiration from React. React derives the component tree as a function of state (`UI = f(state)`). Similarly, Tardigrade defines the harness as a set of state transitions derived from the event log, an idea with roots in [Harel's statecharts](https://www.sciencedirect.com/science/article/pii/0167642387900359).

$$\lbrace\mathrm{transitions}\rbrace = f(\mathrm{log})$$

## Why Tardigrade

- **Composable harness.** Add tools, code execution, budgets, compaction, and replies as independent capabilities.
- **Strongly typed, built on Effect.** Typed services and Layers make each capability's dependencies explicit. A missing service fails during compile.
- **Crash proof.** A durable host derives unfinished work from the stored log.
- **Serverless.** All you need is a durable store, no process has to stay alive. Any new invocation reads the log, runs the transitions it owes, and settles.
- **Inspect and improve every run.** Log as core supports native debugging, replay, and experiments with state forked from any checkpoint.

## Quickstart

Use a [supported Bun runtime](docs/explanations/runtime-and-recovery.md#runtime) and an OpenAI-compatible or Bedrock model endpoint.

```bash
bun add @clavia/tardigrade
```

You can use `npm install @clavia/tardigrade` instead. Install `@clavia/tardigrade@next` to test a release candidate.

### Create a capability

An agent is made of capabilities. A capability is one value with two halves: what the model is shown (`tools`, `system`), and how the calls that come back are handled (`serve`). This one gives the model a single tool:

```ts
import type { Capability } from "@clavia/tardigrade"

const deploys: Capability = {
  name: "deploys",
  tools: () => [
    {
      name: "recent_deploys",
      description: "List recent production deploys",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }
  ],
  serve: (call, log, answer) => {
    if (call.name !== "recent_deploys") return undefined
    return [answer([{ service: "api", revision: "a17c", summary: "Add rate limiting" }])]
  }
}
```

`tools` derives what the model is offered from the log; a constant capability ignores it. `serve` handles a call that comes back: `answer` mints the transition that records the result, and returning `undefined` passes the call to the next capability. Replace the sample result with a call to your deployment API.

The call follows one route:

1. `tools` adds `recent_deploys` to the next model request.
2. The model selects it and returns a tool call. Tardigrade records `ToolCalled` in the log.
3. The shared router asks each mounted capability's `serve` to handle the call. `deploys` matches the name and answers.
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
- [Run the server](docs/how-to/server.md): host the HTTP server over a durable SQLite log, and read its API.
- [Use the command line](docs/how-to/cli.md): drive a server with `tdg`, and serve the API and the UI from one process.
- [Runtime and turn recovery](docs/explanations/runtime-and-recovery.md): understand runtime requirements, retry scopes, and failed-turn recovery.
- [Why Tardigrade](docs/explanations/why.md): learn what the log-as-state model makes possible.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
