# Building an Agent

## Smallest Useful Agent

With `AI_GATEWAY_API_KEY` set, construct and invoke an agent in one file:

```ts
import { Effect } from "effect"
import { createAgent, inference, keyOf } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const agent = createAgent({
  modules: [
    inference({
      system: "You are a support agent. Answer clearly and briefly.",
      contextWindow: 200_000
    })
  ]
})

const result = await Effect.runPromise(
  Effect.provide(
    agent.turn({
      id: "message-1",
      text: "Where can I find my latest invoice?"
    }),
    InMemoryRuntime({ keyOf, session: "user-42" })
  )
)

if (result.kind === "completed") console.log(result.output)
```

`agent.turn(message)` appends the message, settles the agent's machines, and returns the turn boundary. `InMemoryRuntime` supplies storage, routing, and the other runtime ports for this process. `inference(options)` owns its instruction, retry limits, truncation limits, selected provider, and model loop.

`contextWindow` says what the model accepts. A module names it or names a provider that already holds one, because nothing else can know, and [the context window](modules.md#the-context-window) covers where the number comes from. `yield* vercelGatewayInference()` reads it from the gateway's catalog instead.

## Default Inference

The default provider is Vercel AI Gateway.

```sh
export AI_GATEWAY_API_KEY=...
export AI_GATEWAY_MODEL=anthropic/claude-sonnet-4.6
```

The key is read through `Config` when the request is made, so it comes from whatever `ConfigProvider` is in scope and stays redacted on the way to the request. A test supplies its own provider instead of setting an environment variable. An explicit key works in any environment:

```ts
import { inference, vercelGatewayInference } from "flamecast-core/harness"

const inferenceModule = inference({
  provider: vercelGatewayInference({
    apiKey: secrets.aiGateway,
    model: "anthropic/claude-sonnet-4.6",
    contextWindow: 200_000
  })
})
```

Cloudflare AI Gateway uses the same provider interface:

```ts
import { cloudflareGatewayInference, inference } from "flamecast-core/harness"

const inferenceModule = inference({
  provider: cloudflareGatewayInference({
    accountId: secrets.cloudflareAccount,
    apiToken: secrets.cloudflareToken,
    gatewayId: "support",
    model: "anthropic/claude-sonnet-4",
    contextWindow: 200_000
  })
})
```

Provider selection can be a function of the log. The inference module provides its selected-state projection as an Effect construction service, so dependent modules can consume it through typed dependency injection.

Per-request provider settings are a projection too. `flexThenStandard()` asks for flex until the current turn has two deferrals, then standard:

```ts
import { createAgent, flexThenStandard, inference } from "flamecast-core/harness"

const agent = createAgent({
  modules: [inference({ contextWindow: 200_000 }), flexThenStandard()]
})
```

## Add Tools Through the Default Pack

A tool declares its input once, as a `Schema`. The declaration is lowered to the JSON Schema the model reads, and arguments are decoded against it before the handler runs, so the handler receives the type its own schema describes.

```ts
import { Effect, Schema } from "effect"
import { createAgent, defaultPack, tool } from "flamecast-core/harness"

const lookupInvoice = tool({
  name: "lookup_invoice",
  description: "Look up one invoice by order id.",
  input: Schema.Struct({
    orderId: Schema.String.annotate({ description: "The order to look up." })
  }),
  run: (input) => Effect.promise(() => invoices.lookup(input.orderId))
})

const agent = createAgent({
  modules: defaultPack({
    inference: {
      system: "Use lookup_invoice for order questions.",
      contextWindow: 200_000
    },
    nativeTools: [lookupInvoice],
    budget: { defaultBudget: 24 },
    compaction: { triggerAt: 0.8, keepAt: 0.2 }
  })
})
```

`defaultPack(options)` returns inference, native-tool, budget, contract, and compaction modules. Each module owns its own options. `nativeTools` is the provider-native calling default; code mode, MCP, textual commands, and generic RPC can be implemented as alternative modules.

## Add a Nudge

```ts
import { nudge } from "flamecast-core/harness"

const citeInvoice = nudge({
  id: "cite-invoice",
  when: (log) => log.some((event) => event.type === "ToolReturned" && event.name === "lookup_invoice"),
  text: "Name the invoice id in the final answer."
})

const agent = createAgent({
  modules: [
    ...defaultPack({
      inference: { contextWindow: 200_000 },
      nativeTools: [lookupInvoice]
    }),
    citeInvoice
  ]
})
```

`nudge()` returns a render-only module, not a machine. The nudge appears as a late system message when active. Set `placement: "system"` only when it must join the static prefix.

## Add Typed Module State

```ts
import { Context } from "effect"
import { defineModule, type Projection } from "flamecast-core/harness"

class TenantProjection extends Context.Service<
  TenantProjection,
  Projection<string>
>()("example/TenantProjection") {}

const tenantSource = defineModule({
  id: "tenant-source",
  services: Context.make(TenantProjection, (log) =>
    String(log.findLast((event) => event.tenant)?.tenant ?? "default")
  ),
  setup: () => ({})
})

const tenantInstruction = defineModule({
  id: "tenant-instruction",
  requires: [TenantProjection] as const,
  setup: (services) => {
    const tenant = Context.get(services, TenantProjection)
    return {
      nudges: [
        {
          id: "tenant",
          when: () => true,
          text: "Follow the active tenant policy.",
          nativeTools: (log) => policyTools(tenant(log))
        }
      ]
    }
  }
})
```

Leaving out `tenantSource` fails tuple type-checking and runtime validation.

`Context.Service`, `Context.make`, and `Context.get` are Effect's dependency-injection primitives. The harness adds module-graph validation and passes each `setup` function a context containing only its declared requirements.

## Delegate to Another Agent

```ts
import { Effect } from "effect"
import { callAgent, createAgent, defaultPack, keyOf, serve, subagentTool } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const supervisor = createAgent({
  modules: defaultPack({
    inference: { contextWindow: 200_000 },
    nativeTools: [
      subagentTool({
        name: "ask_researcher",
        description: "Ask the research agent for supporting evidence.",
        address: "agent:research"
      })
    ]
  })
})

const runtime = InMemoryRuntime({
  keyOf,
  sessions: {
    "agent:supervisor": serve(supervisor),
    "agent:research": serve(researcher)
  }
})

const answer = await Effect.runPromise(
  Effect.provide(callAgent("agent:supervisor", { id: "m-1", text: "go" }), runtime)
)
```

`serve` turns an agent into what the runtime holds at an address, and the `sessions` registry says who answers where. Each agent picks its own model through its `inference` module. The tool result carries the answer and inclusive usage, and the receiving session's log records who asked through `origin`.

Code can delegate without a model in the loop through `callAgent(address, message)`, and several concurrent calls joined by `await` are a fan-out. For long-running work, set `replyTo` on the message; the reply arrives at that address as a new message stamped with `origin`, `outcome`, and `usage`. [Orchestration](orchestration.md) covers the design, and [Building a swarm](building-a-swarm.md) walks the whole path.

## Let the Model Write the Orchestration

```ts
import { agents, codemode } from "flamecast-core/codemode"

const execute = codemode({ capabilities: [agents({ allow: ["worker/*"] })] })

const lead = createAgent({
  modules: defaultPack({
    inference: { contextWindow: 200_000 },
    nativeTools: [execute]
  })
})
```

The model writes a script, and a fan-out is `Promise.all` over `agents.call`. Bind a sandbox with `Layer.succeed(Sandbox, inProcessSandbox())` for a turn, or hand one to a runtime through `services`. [Code mode](codemode.md) covers capabilities and sandbox choice.

## Test Inference

Tests can override inference with `inferWith(async (request, key) => action)` while production uses the provider configured by the inference module.

## Replay and Fork

```ts
const recorded = await Effect.runPromise(Effect.provide(agent.log, runtime))

const replay = agent.branch(recorded)
const alternative = agent.branch(recorded, { at: 7, id: "alternative" })

await Effect.runPromise(Effect.provide(replay.replay([]), runtime))
await Effect.runPromise(Effect.provide(alternative.replay([]), runtime))
```

Use `agent.fork({ at })` when the source log is already bound to the current runtime.

Module details are in [Modules](modules.md). [Building a swarm](building-a-swarm.md) continues into multiple agents.
