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
- give-up, deferral, and contract-repair bounds
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

Every model reaches its gateway through one adapter, `modelInference()`, which drives an AI SDK language model. The SDK owns the wire format, so a Claude model that returns signed thinking blocks and a Gemini model that returns reasoning items are the same shape here, and a setting means the same thing for both. What the adapter owns is what the SDK has no opinion about: which failures earn another attempt, which earn a journaled wait, and what a turn records about what it spent.

A module says which model answers, and saying that means saying what it accepts, so `inference()` takes either a provider or a `contextWindow` to build the default gateway with. The type rejects a module that names neither. Generated code meets no type, so the construction rejects it too.

A gateway that is busy, unwell, or unreachable earns further attempts, bounded by `retries`, and one attempt is bounded by `timeout`. The provider says which failures those are, and a refusal is not one of them. Every attempt carries one idempotency key, so a retry after a reply this side never saw is the same call rather than a second one. A refusal earns no retry: a request refused for a bad key is refused the same way every time.

A failure that outlives those in-flight retries is still transient. The model loop appends `ModelDeferred` with the attempt, the due time, and the reason, then rests. The runtime wakes the session at `notBefore` by delivering `AlarmFired`, and the loop retries with the same idempotency key. A `Retry-After` of more than two seconds skips the in-flight retries and defers immediately, so a twenty-minute queue is a due time in the log rather than a sleep inside an Effect. It is read in both the forms the specification allows, a count of seconds and a date to wait until. `deferAtMost` bounds how many times one call may wait, defaulting to eight. A crash that leaves a `ModelCalled` with no consequence is journaled the same way, so a restart sleeps instead of immediately issuing another request. The next settle also appends `ModelSettled` with the reservation `ModelCalled` carried, so spend that never got a `ModelReturned` stays on the record. Only a mark no result and no settle has closed is settled that way, so one attempt is counted once. A restart whose due time has already passed appends `AlarmFired` from the log and continues. A wake names the attempt it answers and the due time it comes from, so a redelivered or stale one is absorbed by its dedup key and refused by the machine's guard rather than retrying against a queue that has not moved.

`ModelCalled` carries `reserved`, an upper bound on what the attempt could spend: the prompt as the estimator reads it, the answer as the request's own ceiling bounds it, and a cost when the provider holds a price table. A gateway catalog that publishes `pricing.input` and `pricing.output` fills that table at construction, and a caller can pass `pricing` on a provider that has no catalog. `usageIn` reports `settled` from `ModelReturned` and `unsettled` from in-flight `ModelCalled` rows plus `ModelSettled`. A cost the provider reported, including zero, is kept. A cost the provider omitted is filled from the table when one exists, and is left absent when none does: absence is unknown.

An attempt this side stops waiting for is cancelled. Dropping the wait alone leaves the request running: the model finishes it, the gateway bills for it, and the retry asks for the same completion again, so one turn is paid for twice. `timeout` therefore bounds what the gateway is asked to do rather than only what this side waits for.

`timeout` defaults to ten minutes, which is a guard against a socket that has gone quiet rather than a limit on how long a model may think. A bound inside the range where real answers land discards answers that were on their way, and a reasoning model working for two minutes is inside that range.

`maxOutputTokens` is the ceiling on one answer. Absent leaves it to the gateway's own default for the model. A long generated artifact can exceed a default sized for chat and stop partway through. That stop is the completion-token failure above, so the option that moves it is the one that failure names.

The gateway's catalog publishes the ceiling each model accepts, and a provider built from the catalog sends that figure, which is how a model that can write 128,000 tokens is allowed to. A provider built from a stated context window makes no catalog request and sends no ceiling, so the model's own default decides.

`headers`, `fetch`, `retries`, `timeout`, `temperature`, `maxOutputTokens`, and `providerOptions` are settings a gateway forwards rather than fixes.

`modelInference(options)` is the adapter those gateways are built from, and it is published. A caller reaching an endpoint the shipped gateways do not model builds an AI SDK language model and passes it here, rather than writing a second copy of the request handling.

Provider continuation data belongs to the adapter. The inference module records this opaque value on `ModelReturned`, and the renderer restores it on the related assistant message. Each value names its wire protocol, so a continuation written by one adapter is ignored by another.

The value is the assistant content the model returned, carried whole. Reasoning parts hold provider state, and a part this build has never met travels with the rest rather than being dropped for being unrecognized. The adapter names no model and no field, so a model the gateway adds later travels the same path as one it serves now.

This is the round trip that decides whether a model builds on what it already worked out. A gateway answers a request that lost that state with the same success as one that kept it, so nothing downstream says anything was lost. `bun run smoke:live` is what checks it against live models, because a stub cannot: it reads the prompt tokens the provider counted, since state that arrived was read and state that never arrived was not.

Reaching every model through one SDK is what makes that round trip one path rather than one per wire format. A Claude model returns thinking blocks that carry a signature, a Gemini model returns a thought signature on its function call, and a GPT model returns an encrypted reasoning item. The SDK normalizes all three, and it normalizes the request vocabulary with them, so `reasoning` means the same thing for every model instead of reaching one API as `output_config` and another as `reasoning_effort`.

That default takes nothing away from an earlier model. Sonnet 4.6 and Sonnet 4 spend no thinking tokens on either surface until something asks them to, so the surface they are asked on changes what is preserved rather than what is produced.

Where a request runs is a deployment's decision, so no provider here states a preference and `routes` is empty until a caller fills it. This has one consequence worth knowing. The adapter asks for one tool call at a time, because the harness runs one at a time, and a route can ignore that request. Amazon Bedrock does, and answers with several calls. A turn served that way fails on the model's own second call, and the failure names the setting that was asked for, the route behaviour that ignored it, and `routes` as the way to reach a route that honours it.

A caller that drops the state gets an answer rather than an error, which is what makes the loss quiet. Google rejects a function call that arrives with no thought signature, and names the missing field in a 400. The gateway keeps that rejection away from the caller by sending a sentinel value in place of the signature, which turns the validation off. The request then succeeds, and the model answers the turn without the thoughts it had already paid for.

Google defines that sentinel for a caller replaying function calls it made itself, and discourages it otherwise, because a model that gets it answers without its earlier thoughts. The gateway applies it on the caller's behalf, and says so nowhere in its documentation or its responses. A harness therefore can not learn from the wire that it dropped the state, which is why the regression test pins the fields rather than a status code.

The measurement shows the difference upstream. With the signature, Google counted 333 prompt tokens and resumed thinking. With the signature dropped, it counted 92 and started the turn cold. A request that sent the sentinel by hand matched the dropped one exactly, which is how the substitution shows itself from outside.

A Claude model loses its state the same quiet way, though nothing stands in for what went missing. The substitution belongs to Google alone. What the families share is that the request succeeds either way, so only the token count says whether the model received what it had already thought.

Each family puts its state in a different field, so the adapter preserves fields rather than a list of names. This is what lets one round trip serve a model whose state lives in the tool call and a model whose state lives beside the message.

`bun run smoke:live` is what checks that the preserved state reaches the model, because no test that stubs the gateway can. It runs one tool-calling turn per model twice, once replaying what the provider returned and once replaying only what an event log holds, and reads the prompt tokens the provider counted. A model that reads the same either way never received the state. It calls live models and costs money, so it runs from a command rather than from the gate.

The last run, on 2026-08-18, read more with the state preserved for every model: Gemini 3.1 Pro at 390 against 106, GPT 5.6 Sol at 163 against 129, DeepSeek V4 Pro at 551 against 433, Claude Opus 5 at 622 against 569, and Claude Sonnet 4.6 at 899 against 775. Every one of those reached its model through the one adapter, which is what says a Claude model keeps its thinking without a surface of its own.

A response the gateway stopped at its completion-token limit is a failed action too. The fragment it returns has the shape of an answer, so reading it as one would finish a turn on half a sentence or dispatch a tool call whose arguments stop mid-JSON. The failure carries the usage, because those tokens were spent.

The harness action type carries one tool call, so a response that contains several becomes a visible failed action with its usage. No call is silently dropped. The failure names `routes`, because that option reaches a provider that serves one call at a time, and it is forwarded for every model rather than for some of them.

A request estimated past a known context window is refused before it is sent. It cannot succeed, so sending it buys a slow refusal in the gateway's words, and this one names both sizes and the model they belong to. The estimate is characters over four, which runs low against JSON and code, so a refusal means the request is past the window rather than near it.

## requestOptions

`requestOptions(of)` contributes `RequestOptionsProjection`. The projection is a fold from the log to per-request provider settings, and inference reads it when it builds the model request, so the settings are a projection the way `InferenceStateProjection` feeds compaction. Invariant 4 holds: model requests are pure projections of the log, and a replay sends what the run it replays sent. `agent.request(log)` shows the choice without calling a provider.

`RequestOptions` names `reasoning`, `temperature`, and `maxOutputTokens`, which mean the same thing on every provider, and carries everything else in `providerOptions` under the key of the provider that reads it. A service tier is one vendor's word for one vendor's queue, so it travels there rather than as a field that would imply otherwise.

A policy that reads what has already happened is what makes this worth a projection. Asking for more thinking after an answer was rejected, or leaving a cheap queue after it has made this turn wait, is a fold over the log:

```ts
const agent = createAgent({
  modules: [
    inference({ contextWindow: 200_000 }),
    requestOptions((log) => ({
      reasoning: log.filter((event) => event.type === "AnswerRejected").length > 0 ? "high" : "low"
    })),
    nativeTools([lookup])
  ]
})
```

The framework ships no such policy, because which setting is worth its cost belongs to a deployment. Changing a setting between attempts changes the request, so the next attempt mints its own call rather than reusing the idempotency key that told the gateway the last one was the same call.

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
