<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Tardigrade logo: a tardigrade drawn from overlapping circles" src="docs/assets/logo-light.svg" width="170">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tardie"><img alt="npm version" src="https://img.shields.io/npm/v/tardie.svg"></a>
  <a href="https://discord.gg/Z74jwRxz4k"><img alt="Join Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&amp;logoColor=white"></a>
</p>

# Tardigrade

Tardigrade is a typescript framework for building durable, modular agents that can run on the cloud. It is inspired by [React](https://react.dev/)'s declarative approach to building user interfaces.

### Agents that can self-improve
As models get increasingly smart, they will be capable of writing their own harnesses to improve themselves ([Meta-Harness](https://arxiv.org/abs/2603.28052)). A harness that is too rigid and complex is a bottleneck to this. We need something more composable, and easy to author.

We took inspiration from React. React derives its component tree and declared effects from state (`{ UI, effects } = f(state)`). Tardigrade derives a view and transitions from the event log, an idea with roots in [Harel's statecharts](https://www.sciencedirect.com/science/article/pii/0167642387900359).

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

An agent is made of components. A component derives a view and transitions from the log. An agent view includes system fragments, tool bindings, and context policy. This component gives the model one tool and owes no autonomous work:

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

`derive` is a pure log projection. Each tool binding keeps its specification and handler together, so a tool derived for the model is routable by construction. `answer` constructs the intent that records the result. Replace the sample result with a call to your deployment API.

The call follows one route:

1. The component adds `recent_deploys` to its derived view.
2. The model selects it and returns a tool call. Tardigrade records `ToolCalled` in the log.
3. The infer root finds the paired handler in the view that offered the call and asks it to serve against the current log.
4. Tardigrade records `ToolReturned`. The next model request includes the result.

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

`infer` composes the components into an agent loop. With no model override it inherits the host's allowed coordinates and default. An actor can pass `models: { allow?, default? }` to narrow that set, change its default, or do both. Every effective default must belong to the effective set. `actor` binds those components to a stable name and callable interface. `agentMethods` provides `message` and `requestBudget`. Every actor method call is a durable future that remains pending until it receives one completed or failed terminal response. A message may select another allowed model with a complete `{ provider, model_id }` reference.

`compaction(policy?)` bounds model context. The host resolves the selected model's window from its catalog snapshot. Compaction fires at 80 percent and keeps a 50 percent tail unless the actor states other ratios:

```ts
const boundedContext = compaction({
  fireRatio: 0.8,
  keepRatio: 0.5
})
```

When compaction runs, its checkpoint records the applied policy with the summary.

`codeMode([...components])` combines code packages behind one `execute` tool. Define a package with `definePackage(...)`. Group packages with `composeComponents(...)`.

`budget([...components], { limit?, authority? })` meters calls to tools derived by its child components and closes that subtree at the limit. Components beside the wrapper remain outside that budget. An authority lets an escalatable child call `requestBudget`; `caller()` selects the actor that sent its current message. `budgetAuthority()` is the local automatic handler. Another actor can keep the same method pending while a service or human decides it.

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

Every message, model action, tool result, and checkpoint lands in the log. Reactors read that log and derive keyed transitions.

$$\lbrace\mathrm{transitions}\rbrace = f(\mathrm{log})$$

The host runs transitions with unrecorded keys. It appends their events and repeats until the agent rests.

If the process stops during `recent_deploys`, the log still contains its unanswered `ToolCalled`. `host.recover()` derives the same key and input, then runs the handler again.

External effects have at-least-once execution. Each keyed result is recorded once. Providers can use the transition key as an idempotency key.

## Learn more

- [Quickstart](docs/quickstart.md): build the event loop and its agent components from first principles.
- [HTTP server](docs/how-to/server.md)
- [CLI](docs/how-to/cli.md)
- [Why Tardigrade](docs/explanations/why.md): learn what the log-as-state model makes possible.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
