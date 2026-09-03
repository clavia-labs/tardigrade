<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/mark-dark.svg">
    <img alt="Tardigrade" src="docs/assets/mark.svg" width="120">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tardie"><img alt="npm version" src="https://img.shields.io/npm/v/tardie.svg"></a>
  <a href="https://discord.gg/Z74jwRxz4k"><img alt="Join Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&amp;logoColor=white"></a>
</p>

# Tardigrade

Tardigrade is a typescript framework for building modular agents around an immutable event log. It is built on [Effect TS](https://effect.website/) and is inspired by [React](https://react.dev/)'s declarative approach to building user interfaces.

### Agents that can self-improve
As models get increasingly smart, they will be capable of writing their own harnesses to improve themselves ([Meta-Harness](https://arxiv.org/abs/2603.28052)). A harness that is too rigid and complex is a bottleneck to this. We need something more composable, and easy to author.

We took inspiration from React. React derives its component tree and declared effects from state (`{ UI, effects } = f(state)`). A Tardigrade component is a [Moore machine](https://en.wikipedia.org/wiki/Moore_machine) over events. It updates its state for each event, then derives a view and transitions from that state.

<p align="center"><code>S₀ = initial()</code></p>

<p align="center"><code>Sₙ₊₁ = step(Sₙ, eₙ₊₁)</code></p>

<p align="center"><code>{ view, transitions } = output(Sₙ)</code></p>

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
bun add -g tardie@latest
tdg init researcher
cd researcher
tdg dev
```

`tdg init` configures the first provider and model. Edit `actor.ts` to describe the agent. The [CLI guide](docs/how-to/cli.md) covers non-interactive setup, more providers, and deployment.

From another shell, discover the actor's methods and call one:

```bash
tdg methods --actor researcher
tdg call message '{"text":"read this repo and tell me what it does"}' --actor researcher
```

Voyager opens at [localhost:4242](http://localhost:4242) by default. `tdg call` prints the direct Voyager URL for the new trace.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/voyager-dark.png">
  <img alt="The voyager: a thread's log, one row per event" src="docs/assets/voyager-light.png">
</picture>

## Deploy

Deploy the generated Worker with either platform CLI:

Cloudflare:

```bash
bunx wrangler deploy
```

Celld:

```bash
celld deploy --config celld.jsonc
```

See the [Cloudflare](platform/cloudflare/README.md) and [Celld](docs/how-to/celld.md) guides for platform configuration and secrets.

## Build your own harness

```bash
bun add tardie
```

You can use `npm install tardie` instead. Install `tardie@next` to test a release candidate.

### Create a component

An agent is made of components. Each component owns a machine with `initial`, `step`, and `output`. Its state retains the information from prior events that can affect its future output. An agent view includes system fragments, tool bindings, and context policy. This component gives the model one tool and owes no autonomous work:

```ts
import { component, type AgentComponent, type AgentView } from "tardie"

const deploys: AgentComponent = component<undefined, AgentView>({
  name: "deploys",
  initial: () => undefined,
  step: (state, _event) => state,
  output: () => ({
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
})
```

`initial` creates private state. `step` updates it for each event. This component ignores events and preserves its state. `output` derives its view and enabled transitions. Each tool keeps its specification and handler together. `answer` records the result. Replace the sample result with your deployment API.

An offered tool follows this lifecycle:

1. The component adds `recent_deploys` to the agent's composed view.
2. `infer` includes its specification in the model request.
3. The model calls it. Tardigrade records `ToolCalled`.
4. Tardigrade runs the attached handler and records `ToolReturned`.
5. `infer` includes the result in the next model request.

### Compose an agent

Mount the component beside the built-in parts that this task needs:

```ts
import {
  actor, agentMethods, agentsPackage, budget, budgetAuthority, caller, codeMode,
  compaction, fetchPackage, filesPackage, infer,
  outputValidateOnce, system, workspacePackage
} from "tardie"

const instructions = system(
  "You are a release analyst. Identify risky changes and recommend the safest next action."
)

const releaseAnalyst = actor({
  // name supplies the actor's stable identity.
  name: "release-analyst",
  // methods declare how the world can communicate with this actor.
  methods: agentMethods,
  // components implement those methods and derive transitions from the actor's private log.
  components: [
    // infer handles messages as model loops composed by children.
    infer([
      instructions, // system prompt
      deploys,      // provides recent_deploys tool and paired handler
      // budget scopes the tool-call limit to the codeMode subtree
      budget([
        codeMode([  // sandboxed code execution
          filesPackage(),
          fetchPackage(),
          agentsPackage(),
          workspacePackage()
        ])
      ], { authority: caller() }),
      compaction(), // bounded model context
      outputValidateOnce // validates structured result once without correction
    ]),
    budgetAuthority() // budgetAuthority handles requestBudget for this actor.
  ]
})
```

- `actor` gives the composition a stable name and callable methods. `infer` turns its child components into an agent loop and inherits the host's model policy unless the actor narrows it with `models`.

- `compaction()` uses the selected model's catalog window. It summarizes at 80 percent and retains a 50 percent tail. Pass `fireRatio` and `keepRatio` to change those values. Each checkpoint records the policy it applied.

- `codeMode([...components])` exposes its packages through one `execute` tool.

- `budget([...components])` meters tool calls within its subtree. `caller()` sends escalation requests to the invoking actor, and `budgetAuthority()` handles them locally.

This agent can inspect deployments and files, fetch sources, delegate research, and analyze results with JavaScript. Change the package list to create another harness.

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
import { Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { infer } from "tardie/model"
import { createBunHost } from "tardie/bun/host"

const model = infer({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  provider: "openai",
  model: "gpt-5.2",
  protocol: "openai-responses",
  contextWindowTokens: 400_000
})

const platform = Layer.mergeAll(
  model,
  BunFileSystem.layer,
  BunPath.layer,
  FetchHttpClient.layer
)

const host = await createBunHost({
  log: "agents.sqlite",
  actorFor: () => releaseAnalyst.actor,
  layersFor: () => platform
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

The actor provider and default model must match the binding. The binding states its protocol and context window, so selection is checked before a request spends tokens.

</details>

## How durability works

Every message, model action, tool result, and checkpoint lands in the log. Component machines consume those events and derive keyed transitions from their current state.

<p align="center"><code>Sₙ₊₁ = step(Sₙ, eₙ₊₁)</code></p>

The host runs transitions with unrecorded keys. It appends their events and repeats until the agent rests.

If the process stops during `recent_deploys`, the log still contains its unanswered `ToolCalled`. `host.recover()` replays the log through the component machines, derives the same key and input, then runs the handler again. Live execution only steps the machines with newly appended events.

External effects have at-least-once execution. Each keyed result is recorded once. Providers can use the transition key as an idempotency key.

## Learn more

- [Quickstart](docs/quickstart.md): build the event loop and its agent components from first principles.
- [HTTP server](docs/how-to/server.md)
- [CLI](docs/how-to/cli.md)
- [Why Tardigrade](docs/explanations/why.md): learn what the log-as-state model makes possible.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
