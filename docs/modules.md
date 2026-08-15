# Modules

## Composition Contract

Modules are ordered values passed to `createAgent`. Order controls instruction order, native-tool order, machine order, and default agent identity.

Built-in modules are useful policies built from the concepts in [Concepts](concepts.md). They are replaceable defaults rather than framework primitives.

Module ids must be unique. Replacing a built-in means constructing a different module tuple. Silent last-write replacement is deliberately rejected.

```ts
const agent = createAgent({
  modules: [inference(), nativeTools([lookup]), budget(), contract(), morphCompaction()]
})
```

`defaultPack(options)` builds that tuple with module-owned configuration.

## inference

`inference(options)` contributes:

- the model loop and reply machine
- the static system instruction
- provider selection
- give-up and contract-repair bounds
- message and tool-result truncation limits
- the `InferenceStateProjection` construction service

`messageTruncateAt` and `resultTruncateAt` bound how much of a received message and of a tool result reach the model, in characters. Both are absent until a caller sets one, so a render sends what the log holds. A bound the caller never asked for would drop text that only the rendered request could show was missing, and the log would still read as though the model saw all of it. Context size has an owner already: [compaction](#compaction) checkpoints the log against the provider's window.

A body that meets a bound the caller did set carries a marker naming its original size, so a model holding a fragment can read that it is holding one.

Vercel AI Gateway is the default provider. The gateway reads `AI_GATEWAY_API_KEY`, `AI_GATEWAY_MODEL`, and `AI_GATEWAY_CONTEXT_WINDOW`. Explicit options take precedence.

`cloudflareGatewayInference()` supports Cloudflare's account AI endpoint with `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_AI_GATEWAY_ID`, model, and context-window settings.

A key or token is a secret, so it is read as a `Config` of a `Redacted` value at the request rather than held as a string from construction. It renders as `<redacted>` anywhere it is printed, it comes from the `ConfigProvider` in scope, and a test supplies one rather than setting an environment variable. Model names, endpoints, and context windows are read at construction, because `state` reports them without an effect and none of them is a secret.

A gateway that is busy, unwell, or unreachable earns further attempts on a jittered exponential backoff, bounded by `retries`, and one attempt is bounded by `timeout`. Every attempt carries one idempotency key, so a retry after a reply this side never saw is the same call rather than a second one. A refusal earns no retry: a request refused for a bad key is refused the same way every time. A failure that outlives its retries becomes a failed action, which the model loop records as the turn's evidence.

A response the gateway stopped at its completion-token limit is a failed action too. The fragment it returns has the shape of an answer, so reading it as one would finish a turn on half a sentence or dispatch a tool call whose arguments stop mid-JSON. The failure carries the usage, because those tokens were spent.

## nativeTools

`nativeTools(list)` implements the model provider's native tool-calling interface. It contributes schemas and a dispatch machine. A handler success or failure becomes a `ToolReturned` event, so the model can observe the outcome and replay can reuse it.

`tool(options)` declares a tool's schema and its handler together. The input is a `Schema`, and one declaration serves three readers: `jsonSchemaOf` lowers it to the JSON Schema the model reads, the compiler types the handler against it, so a field the schema does not offer is a compile error rather than an `undefined` read at runtime, and arguments are decoded against it before the handler runs. A mismatch returns to the model as an ordinary tool error it can repair, and it reports every failing field at once so a repair costs one turn rather than one turn per field.

Native tool calling is one interface policy. MCP, textual commands, one generic RPC operation, or another protocol can use its own request projection and machines without changing the event-log or module primitives. [Code mode](codemode.md) is the policy that ships, in its own package.

`subagentTool(options)` adapts `callAgent` to a `NativeTool`, so a model delegates to another agent through the same surface it already understands. [Orchestration](orchestration.md) covers the delegation surface.

## budget

`budget(options)` projects tool spend, emits the wall event, withdraws spending tools, and optionally exposes a budget-request tool. The default budget and all wall text belong to this module.

Budget control is event driven. A grant or denial can arrive later through replay or routing, which lets parked work resume without a waiting process. [Cost projections](observability.md#cost-projections) expose the tool spend.

## contract

`contract(options)` reads a schema from the inbound message, exposes an `answer` tool for that schema, validates the arguments, and records rejections. The inference module owns the repair attempt limit because it owns the model loop that enforces it.

A turn declares its output in its own message, so the schema travels as the JSON Schema the log carries rather than as a runtime value. A caller lowers a `Schema` with `jsonSchemaOf` when it sends the message, and the check lifts that JSON back into a schema and decodes against it. Lowering and lifting are pure, so the decide that runs the check reaches the same verdict on every settle and every replay.

## compaction

`morphCompaction(options)` requires `InferenceStateProjection`. Its default trigger is 80 percent of the selected model's context window and its retained tail is 20 percent.

The module appends `CompactionCompleted` with an `upTo` offset and summary. It deletes no events. Rendering substitutes the latest summary for the compacted prefix.

When a Morph API key is absent or the call fails, the local deterministic fallback produces the checkpoint.

## nudge

`nudge(options)` creates a render-only module. It contributes no machine and emits no event.

Use a nudge for conditional prompt text or conditional native-tool surfaces that are pure projections of the log. Use a machine when behavior must append facts, wait for events, or perform effects.

A nudge can depend on machine state. For example, a machine can record `ReminderShown`, while the nudge predicate projects whether the reminder should still appear. The durable lifecycle belongs to the machine and the request contribution remains a projection.

## Custom Module

```ts
import { Context } from "effect"
import { defineModule, type Projection } from "flamecast-core/harness"

class RetrievalConfidence extends Context.Service<
  RetrievalConfidence,
  Projection<number>
>()("example/RetrievalConfidence") {}

const retrieval = defineModule({
  id: "retrieval",
  version: "3",
  identity: { index: "support-v4" },
  services: Context.make(RetrievalConfidence, retrievalConfidence),
  setup: () => ({
    events: ["RetrievalCompleted"],
    machines: [retrievalMachine],
    nativeTools: [searchTool.spec]
  })
})
```

`version` and `identity` contribute to the default agent id. Generated-code systems can set `createAgent({ id })` directly.

The standard event names live in [Events](events.md). The module type vocabulary lives in [Concepts](concepts.md).
