# Modules

## Composition Contract

Modules are ordered values passed to `createAgent`. Order controls instruction order, native-tool order, machine order, and default agent identity.

Built-in modules are useful policies built from the concepts in [Concepts](concepts.md). They are replaceable defaults rather than framework primitives.

Module ids, instruction ids, nudge ids, machine ids, service providers, and static native-tool names must be unique. Each render bound has one owner and must be a nonnegative integer. A dynamic nudge cannot add a tool name that is already active. Replacing a built-in means constructing a different module tuple. Silent last-write replacement is rejected.

```ts
const agent = createAgent({
  modules: [inference({ contextWindow: 200_000 }), nativeTools([lookup]), budget(), contract(), morphCompaction()]
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

`messageTruncateAt` and `resultTruncateAt` bound how much of a received message and of a tool result reach the model, in characters. Both are absent until a caller sets one, so a render sends what the log holds. A bound the caller never asked for would drop text that only the rendered request could show was missing, and the log would still read as though the model saw all of it.

A provider states one maximum, `contextWindow`, and it bounds the whole request rather than any one message. A per-message default derived from it would be a policy the framework invented, so there is none. The window is enforced where it applies, in the provider, and [compaction](#compaction) is what keeps a session under it across turns.

A body that meets a bound the caller did set carries a marker naming its original size, so a model holding a fragment can read that it is holding one. `agent.request(log)` renders exactly what goes to the provider, so what a bound removed is readable at any point without running anything.

Vercel AI Gateway is the default provider. The gateway reads `AI_GATEWAY_API_KEY`, `AI_GATEWAY_MODEL`, and `AI_GATEWAY_CONTEXT_WINDOW`. Explicit options take precedence.

`cloudflareGatewayInference()` supports Cloudflare's account AI endpoint with `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, optional `CLOUDFLARE_AI_GATEWAY_ID`, model, and context-window settings.

A key or token is a secret, so it is read as a `Config` of a `Redacted` value at the request rather than held as a string from construction. It renders as `<redacted>` anywhere it is printed, it comes from the `ConfigProvider` in scope, and a test supplies one rather than setting an environment variable. Model names and endpoints are read at construction, because `state` reports them without an effect and neither is a secret.

## The Context Window

The context window belongs to the model, so `InferenceState.contextWindow` is what the model accepts. It is a number rather than a number this side might not have, because a figure written into the framework would be wrong for every model it was not measured against, and it decides more than one thing: the provider refuses an oversized request against it, and compaction divides it to find its trigger.

It is required for a second reason. The projection is read by a machine guard, so it has to fold the same way in every process. A window a provider learned partway through a session would answer one way where a call had been made and another where none had, and a replay would diverge from the run it replays. A provider holds its window before it exists, so the projection is a constant.

That decides the shape of a constructor. Stating the window builds a provider synchronously, with no network and no effect. Leaving it out means the gateway has to be asked, and asking is an effect, so the provider arrives in one.

```ts
const stated = vercelGatewayInference({ contextWindow: 200_000 })
const asked = yield* vercelGatewayInference({ model: "anthropic/claude-opus-4.5" })
```

`vercelGatewayInference()` reads the gateway's model catalog, which publishes a context window per model. One read per gateway for the life of the process, shared by every model built against it. A catalog the process cannot read, or one that lists no such model, fails the construction with a message naming the model and the option that settles it, and the failed read is dropped so the next construction tries again.

`cloudflareGatewayInference()` publishes no catalog on the path its chat requests use, so `contextWindow` or `CLOUDFLARE_AI_CONTEXT_WINDOW` is the only way it can know, and its absence is a construction error. `customInference()` asks for the window outright, because whoever wrote the function is the only one who can say.

A module says which model answers, and saying that means saying what it accepts, so `inference()` takes either a provider or a `contextWindow` to build the default gateway with. The type rejects a module that names neither. Generated code meets no type, so the construction rejects it too.

A gateway that is busy, unwell, or unreachable earns further attempts on a jittered exponential backoff, bounded by `retries`, and one attempt is bounded by `timeout`. Every attempt carries one idempotency key, so a retry after a reply this side never saw is the same call rather than a second one. A refusal earns no retry: a request refused for a bad key is refused the same way every time. A failure that outlives its retries becomes a failed action, which the model loop records as the turn's evidence.

An attempt this side stops waiting for is cancelled. Dropping the wait alone leaves the request running: the model finishes it, the gateway bills for it, and the retry asks for the same completion again, so one turn is paid for twice. `timeout` therefore bounds what the gateway is asked to do rather than only what this side waits for.

`timeout` defaults to ten minutes, which is a guard against a socket that has gone quiet rather than a limit on how long a model may think. A bound inside the range where real answers land discards answers that were on their way, and a reasoning model working for two minutes is inside that range.

`maxOutputTokens` is the ceiling on one answer. Absent leaves it to the gateway's own default for the model. A long generated artifact can exceed a default sized for chat and stop partway through. That stop is the completion-token failure above, so the option that moves it is the one that failure names.

`headers`, `fetch`, `retries`, `timeout`, and `maxOutputTokens` are settings a gateway forwards rather than fixes.

`openAiChatInference(options)` is the provider those gateways are built from, and it is published. A caller who needs another OpenAI-compatible endpoint, or a header the shipped gateways do not model, writes options rather than a second copy of the request serialization.

Provider continuation data belongs to the provider adapter. The inference module records this opaque value on `ModelReturned`, and the renderer restores it on the related assistant message. Each value names its wire protocol. An incompatible adapter ignores the value.

The OpenAI-compatible adapter preserves conversation extension fields from assistant messages and tool calls. These fields include Gemini thought signatures and encrypted reasoning details. Flamework owns this round trip for applications.

The adapter names no model and no field, so a model the gateway adds later travels the same path as one it serves now. This is what keeps the round trip free of a per-provider table.

A live check against the Vercel AI Gateway on 2026-08-16 measured what each family returns on this surface, and what a second turn does when the fields go missing. Gemini carries its state in the tool call, as a thought signature. Claude Sonnet 4.6 and DeepSeek carry it in the reasoning details. GPT 5.6 Sol and Claude Opus 5 return no reasoning state here, because extended thinking on those models needs the Anthropic and OpenAI surfaces that this adapter does not speak.

A caller that drops the state gets an answer rather than an error, which is what makes the loss quiet. Google rejects a function call that arrives with no thought signature. The gateway keeps that rejection away from the caller by sending a documented sentinel value in place of the signature, which turns the validation off. The request then succeeds, and the model answers the turn without the thoughts it had already paid for.

The measurement shows the difference upstream. With the signature, Google counted 333 prompt tokens and resumed thinking. With the signature dropped, it counted 92 and started the turn cold. A request that sent the sentinel by hand matched the dropped one exactly, which is how the substitution shows itself from outside. Anthropic behaves the same way through its reasoning details, at 707 prompt tokens against 673.

Each family puts its state in a different field, so the adapter preserves fields rather than a list of names. This is what lets one round trip serve a model whose state lives in the tool call and a model whose state lives beside the message.

A response the gateway stopped at its completion-token limit is a failed action too. The fragment it returns has the shape of an answer, so reading it as one would finish a turn on half a sentence or dispatch a tool call whose arguments stop mid-JSON. The failure carries the usage, because those tokens were spent.

The OpenAI-compatible provider requests serial tool calling with `parallel_tool_calls: false`. The harness action type carries one tool call, so a response that still contains several calls becomes a visible failed action with its usage. No call is silently dropped.

A request estimated past a known context window is refused before it is sent. It cannot succeed, so sending it buys a slow refusal in the gateway's words, and this one names both sizes and the model they belong to. The estimate is characters over four, which runs low against JSON and code, so a refusal means the request is past the window rather than near it.

## nativeTools

`nativeTools(list)` implements the model provider's native tool-calling interface. It contributes schemas and a dispatch machine. A handler success or failure becomes a `ToolReturned` event, so the model can observe the outcome and replay can reuse it.

`tool(options)` declares a tool's schema and its handler together. The input is a `Schema`, and one declaration serves three readers: `jsonSchemaOf` lowers it to the JSON Schema the model reads, the compiler types the handler against it, so a field the schema does not offer is a compile error rather than an `undefined` read at runtime, and arguments are decoded against it before the handler runs. A mismatch returns to the model as an ordinary tool error it can repair, and it reports every failing field at once so a repair costs one turn rather than one turn per field.

Native tool calling is one interface policy. MCP, textual commands, one generic RPC operation, or another protocol can use its own request projection and machines without changing the event-log or module primitives. [Code mode](codemode.md) is the policy that ships, in its own package.

`subagentTool(options)` adapts `callAgent` to a `NativeTool`, so a model delegates to another agent through the same surface it already understands. Its input is decoded before routing. [Orchestration](orchestration.md) covers the delegation surface.

## budget

`budget(options)` projects tool spend, emits the wall event when the final allowed work call is recorded, withdraws spending tools, and optionally exposes a budget-request tool. A budget of zero exposes no work tools and refuses a hidden work call before its handler runs. The default budget and all wall text belong to this module.

Budget control is event driven. A grant or denial can arrive later through replay or routing, which lets parked work resume without a waiting process. Both decisions carry the `callId` of their `BudgetRequested` event. The first committed decision for that turn and call wins, a redelivery is absorbed, and a stale decision leaves the request parked. Use `budgetGranted()` and `budgetDenied()` to construct these events. [Cost projections](observability.md#cost-projections) expose the tool spend.

## contract

`contract(options)` reads a schema from the inbound message, exposes an `answer` tool for that schema, validates the arguments, and records rejections. The inference module owns the repair attempt limit because it owns the model loop that enforces it.

A turn declares its output in its own message, so the schema travels as the JSON Schema the log carries rather than as a runtime value. A caller lowers a `Schema` with `jsonSchemaOf` when it sends the message, and the check lifts that JSON back into a schema and decodes against it. Lowering and lifting are pure, so the decide that runs the check reaches the same verdict on every settle and every replay.

## compaction

`morphCompaction(options)` requires `InferenceStateProjection`. Its default trigger is 80 percent of the selected model's context window and its retained tail is 20 percent.

Both are ratios of [the model's window](#the-context-window), which the provider holds before it exists, so a model switch moves both and the trigger stays a fold over the log. `fireTokens` and `keepTokens` state the two thresholds directly for a session that would rather set them than derive them.

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
