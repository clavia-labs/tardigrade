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
      system: "You are a support agent. Answer clearly and briefly."
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

`agent.turn(message)` appends the message, settles the agent's machines, and returns the turn boundary. `InMemoryRuntime` supplies storage, routing, and the other runtime ports for this process. `inference()` owns its instruction, retry limits, truncation limits, selected provider, and model loop.

## Default Inference

The default provider is Vercel AI Gateway.

```sh
export AI_GATEWAY_API_KEY=...
export AI_GATEWAY_MODEL=anthropic/claude-sonnet-4.6
```

An explicit key works in any environment:

```ts
import { inference, vercelGatewayInference } from "flamecast-core/harness"

const inferenceModule = inference({
  provider: vercelGatewayInference({
    apiKey: secrets.aiGateway,
    model: "anthropic/claude-sonnet-4.6"
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
    model: "anthropic/claude-sonnet-4"
  })
})
```

Provider selection can be a function of the log. The inference module provides its selected-state projection as an Effect construction service, so dependent modules can consume it through typed dependency injection.

## Add Tools Through the Default Pack

```ts
import { Effect } from "effect"
import { createAgent, defaultPack, type NativeTool } from "flamecast-core/harness"

const lookupInvoice: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by order id.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: (input) => Effect.promise(() => invoices.lookup((input as { orderId: string }).orderId))
}

const agent = createAgent({
  modules: defaultPack({
    inference: {
      system: "Use lookup_invoice for order questions."
    },
    nativeTools: [lookupInvoice],
    budget: { defaultBudget: 24 },
    compaction: { triggerAt: 0.8, keepAt: 0.2 }
  })
})
```

`defaultPack()` returns inference, native-tool, budget, contract, and compaction modules. Each module owns its own options. `nativeTools` is the provider-native calling default; code mode, MCP, textual commands, and generic RPC can be implemented as alternative modules.

## Add a Nudge

```ts
import { nudge } from "flamecast-core/harness"

const citeInvoice = nudge({
  id: "cite-invoice",
  when: (log) => log.some((event) => event.type === "ToolReturned" && event.name === "lookup_invoice"),
  text: "Name the invoice id in the final answer."
})

const agent = createAgent({
  modules: [...defaultPack({ nativeTools: [lookupInvoice] }), citeInvoice]
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
import { agentNativeTool, defaultPack } from "flamecast-core/harness"

const askResearcher = agentNativeTool({
  name: "ask_researcher",
  description: "Ask the research agent for supporting evidence.",
  address: "agent:research"
})

const supervisor = createAgent({
  modules: defaultPack({ nativeTools: [askResearcher] })
})
```

The runtime decides how `agent:research` resolves. For long-running work, send through `Router.deliver` and set `replyTo` on the inbound message.

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

Module details are in [Modules](modules.md).
