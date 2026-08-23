<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Tardigrade logo: a tardigrade drawn from overlapping circles" src="docs/assets/logo-light.svg" width="170">
  </picture>
</p>

# Tardigrade

[![npm version](https://img.shields.io/npm/v/tardie.svg)](https://www.npmjs.com/package/tardie)

Tardigrade is a framework for building durable, modular agents that can run at the edge. It is inspired by [React](https://react.dev/)'s declarative approach to building user interfaces.

### A declarative way to build agents
As models get increasingly smart, they will be capable of writing their own harnesses to improve themselves ([Meta-Harness](https://arxiv.org/abs/2603.28052)). A harness that is too rigid and complex is a bottleneck to this. We need something more composable, and easy to author.

We took inspiration from React. React derives its component tree and declared effects from state (`{ UI, effects } = f(state)`). Tardigrade derives a view and state transitions from the event log, an idea with roots in [Harel's statecharts](https://www.sciencedirect.com/science/article/pii/0167642387900359).

$$\lbrace\mathrm{view},\ \mathrm{transitions}\rbrace = f(\mathrm{log})$$

## Why Tardigrade

- **Composable harness.** Add tools, code execution, budgets, compaction, and replies as independent components.
- **Strongly typed, built on Effect.** Typed services and Layers make each component's dependencies explicit. A missing service fails during compile.
- **Crash proof.** A durable host derives unfinished work from the stored log.
- **Serverless.** All you need is a durable store, no process has to stay alive. Any new invocation reads the log, runs the transitions it owes, and settles.
- **Inspect and improve every run.** Log as core supports native debugging, replay, and experiments with state forked from any checkpoint.

## Quickstart

Install Tardigrade and initialize an editable template actor. Use Bun 1.4 or later. If you are using a coding agent, the [Tardigrade skill](skills/tardigrade/SKILL.md) can help.

If you have an existing agent application, follow the [migration guide](docs/how-to/migrate.md) to move its harness, history, API, client, and deployment configuration.

```bash
bun add -g tardie
tdg init researcher
cd researcher
```

The `init` command creates `researcher/actor.ts` from the bundled template. Read the [Quickstart guide](docs/quickstart.md) to understand the framework, then edit `actor.ts` to describe the agent. Build and push the result into the local actor registry:

```bash
tdg build actor.ts
tdg push actor.ts --target local
tdg dev
```

Keep `tdg dev` running. Start the actor from another shell in the same directory:

```bash
tdg run "read this repo and tell me what it does" --actor researcher
```

Voyager opens at [localhost:4242](http://localhost:4242) by default. `tdg run` prints the direct Voyager URL for the new trace.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/voyager-dark.png">
  <img alt="The voyager: a thread's log, one row per event" src="docs/assets/voyager-light.png">
</picture>

## Build your own harness

```bash
bun add tardie
```

You can use `npm install tardie` instead. Install `tardie@next` to test a release candidate.

### Create a component

An agent is made of components. A component derives a view and owed transitions from the log. An agent view includes system fragments, tool bindings, and context policy. This component gives the model one tool and owes no autonomous work:

```ts
import type { AgentComponent } from "tardie"

const deploys: AgentComponent = {
  name: "deploys",
  derive: () => ({
    view: {
      system: ["Inspect recent deployments when a release may explain an incident."],
      tools: [{
        spec: {
          name: "recent_deploys",
          description: "List recent production deploys",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        },
        serve: (_call, _log, answer) => [
          answer([{ service: "api", revision: "a17c", summary: "Add rate limiting" }])
        ]
      }],
      context: [],
      output: []
    },
    transitions: []
  })
}
```

`derive` is a pure log projection. Each tool binding keeps its specification and handler together, so a tool derived for the model is routable by construction. `answer` mints the transition that records the result. Replace the sample result with a call to your deployment API.

The call follows one route:

1. The component adds `recent_deploys` to its derived view.
2. The model selects it and returns a tool call. Tardigrade records `ToolCalled` in the log.
3. The infer root finds the paired handler in the view that offered the call and asks it to serve against the current log.
4. Tardigrade records `ToolReturned`. The next model request includes the result.

### Compose an agent

Mount the component beside the built-in parts that this task needs:

```ts
import { actor, budget, codeMode, compaction, infer, outputValidateOnce, reply, system } from "tardie"

const instructions = system(
  "You are a release analyst. Identify risky changes and recommend the safest next action."
)

const releaseAnalyst = actor(infer([
  instructions, // the agent's system prompt
  deploys,     // recent_deploys and its paired handler
  codeMode(),  // durable JavaScript execution over an empty package scope
  budget,      // a per-turn code budget
  compaction,  // bounded model context
  reply,       // results for parent agents
  outputValidateOnce // validates one structured result without correction
]))
```

`infer` composes its children, preserves their transitions, and adds inference and tool routing over their final view. `actor` adapts the root component to reconciliation and carries its service requirements into the host type. System fragments join in component order, so the model sees the release instructions beside `recent_deploys` and `execute` in one request. Policy components derive work from the same log.

`codeMode([...components])` applies the same structure to the code surface. Each package factory returns a leaf `CodeComponent`. Code mode composes their package views and transitions, then exposes the combined scope through one `execute` tool. Use `definePackage({...})` for a custom leaf. Use `composeComponents(name, CODE_VIEW_ALGEBRA, children)` when one code component groups other code components.

This agent can inspect deployments, analyze results with JavaScript, compact a long investigation, and report to a parent agent. Change the list to create another harness.

A run can follow this path:

```text
MessageReceived -> recent_deploys -> execute -> TurnCompleted
```

Each action and result becomes an event that every component can interpret.

### Run the composition

<details>
<summary>Bind a model and durable SQLite host</summary>

The three code blocks form one program.

```ts
import { infer } from "tardie/model"
import { createBunHost } from "tardie/bun/host"

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

await host.commitRoot("bun:main", {
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

- [Quickstart](docs/quickstart.md): build the event loop and its agent components from first principles.
- [Structured output](docs/output.md): declare a typed result and read its value.
- [HTTP server](docs/how-to/server.md)
- [CLI](docs/how-to/cli.md)
- [Why Tardigrade](docs/explanations/why.md): learn what the log-as-state model makes possible.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
