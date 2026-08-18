# Modules

## Composition Contract

Modules are ordered values passed to `createAgent`. Order controls instruction order, native-tool order, machine order, and default agent identity.

Built-in modules are useful policies built from the concepts in [Concepts](concepts.md). They are replaceable defaults rather than framework primitives.

Module ids, instruction ids, nudge ids, machine ids, service providers, and static native-tool names must be unique. Each render bound has one owner and must be a nonnegative integer. A dynamic nudge cannot add a tool name that is already active. Replacing a built-in means constructing a different module tuple. Silent last-write replacement is rejected.

A machine may only transition on an event some module in the tuple declares. A module declares what it emits, so a transition on an undeclared event is a module missing from the tuple, and the state waiting on it would rest for good: no error, no answer, no sign of which module was left out. The check reads the tuple at construction, where the missing module is still visible. The rule runs one way, because declaring an event nothing transitions on is ordinary: a module records facts for a projection or a reader, and no machine has to care.

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
- give-up, deferral, contract-repair, and continue bounds
- message and tool-result truncation limits
- the `InferenceStateProjection` construction service

`messageTruncateAt` and `resultTruncateAt` bound how much of a received message and of a tool result reach the model, in characters. Both are absent until a caller sets one, so a render sends what the log holds. A bound the caller never asked for would drop text that only the rendered request could show was missing, and the log would still read as though the model saw all of it.

A provider states one maximum, `contextWindow`, and it bounds the whole request rather than any one message. A per-message default derived from it would be a policy the framework invented, so there is none. The window is enforced where it applies, in the provider, and [compaction](#compaction) is what keeps a session under it across turns and, when a request plus its output ceiling would not fit, mid-turn.

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

A gateway that is busy, unwell, or unreachable earns further attempts on a jittered exponential backoff, bounded by `retries`, and one attempt is bounded by `timeout`. Every attempt carries one idempotency key, so a retry after a reply this side never saw is the same call rather than a second one. A refusal earns no retry: a request refused for a bad key is refused the same way every time.

A failure that outlives those in-flight retries is still transient. The model loop appends `ModelDeferred` with the attempt, the due time, and the reason, then rests. The runtime wakes the session at `notBefore` by delivering `AlarmFired`, and the loop retries with the same idempotency key. A `Retry-After` of more than two seconds skips the in-flight retries and defers immediately, so a twenty-minute queue is a due time in the log rather than a sleep inside an Effect. `deferAtMost` bounds how many times one call may wait, defaulting to eight. A crash that leaves a `ModelCalled` with no consequence is journaled the same way, so a restart sleeps instead of immediately issuing another request. The next settle also appends `ModelSettled` with the reservation `ModelCalled` carried, so spend that never got a `ModelReturned` stays on the record. A restart whose due time has already passed appends `AlarmFired` from the log and continues.

`ModelCalled` carries `reserved`, an estimate of prompt tokens and, when the provider holds a price table, of cost. A gateway catalog that publishes `pricing.input` and `pricing.output` fills that table at construction, and a caller can pass `pricing` on a provider that has no catalog. `usageIn` reports `settled` from `ModelReturned` and `unsettled` from in-flight `ModelCalled` rows plus `ModelSettled`. A cost the provider reported, including zero, is kept. A cost the provider omitted is filled from the table when one exists, and is left absent when none does: absence is unknown.

An attempt this side stops waiting for is cancelled. Dropping the wait alone leaves the request running: the model finishes it, the gateway bills for it, and the retry asks for the same completion again, so one turn is paid for twice. `timeout` therefore bounds what the gateway is asked to do rather than only what this side waits for.

`timeout` defaults to ten minutes, which is a guard against a socket that has gone quiet rather than a limit on how long a model may think. A bound inside the range where real answers land discards answers that were on their way, and a reasoning model working for two minutes is inside that range.

`maxOutputTokens` is the ceiling on one answer. Absent leaves it to the gateway's own default for the model. A long generated artifact can exceed a default sized for chat and stop partway through. That stop is recorded as `AnswerTruncated`, and the turn continues rather than starting the artifact again. `continueAtMost` bounds how many times one answer may be cut, defaulting to eight, and it counts the answer being written now: a tool call ends an answer, so a turn that writes several long documents gets the bound for each of them. Fragments of a completed answer are stitched into `TurnCompleted.output`, because a caller asked for an answer rather than its last instalment.

A tool call cut before its arguments closed is recorded as `tool` and `arguments` rather than described in the fragment's text. Nothing was dispatched: the partial arguments never parsed, so no tool ran and nothing has to be undone. Naming the tool is what lets a module tell that case from cut prose, which is the difference between asking the model to continue and asking it to make a smaller call.

What to say about either case is [a nudge](#truncation), not something this loop or the renderer writes.

The Messages API refuses a request that states no ceiling, so a provider for it always sends one. The gateway's catalog publishes the ceiling each model accepts, and a provider built from the catalog sends that figure, which is how a model that can write 128,000 tokens is allowed to. A provider built from a stated context window makes no catalog request, so what is left is 64,000, a ceiling current Claude models accept, or the window itself when that is smaller. State `maxOutputTokens` to raise or lower it. An older model that refuses 64,000 needs the option set to what it accepts.

`InferenceState.maxOutputTokens` is that ceiling when the provider states one, sitting beside `contextWindow` so a fold can reserve output headroom. The window check refuses a request whose estimated input plus that ceiling exceeds the window, because the Messages API requires `input + max_tokens <= window` and a check on input alone would pass a body the API then refuses.

`compactMidTurn` lets the loop checkpoint in the middle of a turn. Before a request is issued, the same reservation is measured against the window. If it would not fit, the loop appends `CompactionFired` and rests until `CompactionCompleted`, then re-renders against the new checkpoint. It is the window itself rather than a fraction of it, because how full a log may get before compacting is worth doing is [compaction's](#compaction) policy, and a second ratio here could disagree with the one the author set. This is what keeps a long tool-calling turn from growing past the window with no chance to compact, since the between-turn trigger cannot fire while a turn is open.

One checkpoint per attempt. A summary that does not buy enough room would reach the same verdict on the same log for ever, so a second fire with no model call between them fails with the window error instead.

The option is off by default, and `defaultPack` turns it on. It names a dependency `inference` cannot satisfy alone: something has to answer `CompactionFired` with a checkpoint. Asking for it without a module that writes them is a construction error, because the loop's `compacting` state transitions on an event no module declares, which is [the check that catches a missing module](#composition). A turn that rested there for good would return nothing and say nothing.

`headers`, `fetch`, `retries`, `timeout`, and `maxOutputTokens` are settings a gateway forwards rather than fixes.

`openAiChatInference(options)` is the provider those gateways are built from, and it is published. A caller who needs another OpenAI-compatible endpoint, or a header the shipped gateways do not model, writes options rather than a second copy of the request serialization.

Provider continuation data belongs to the provider adapter. The inference module records this opaque value on `ModelReturned`, and the renderer restores it on the related assistant message. Each value names its wire protocol. An incompatible adapter ignores the value.

The OpenAI-compatible adapter preserves conversation extension fields from assistant messages and tool calls. These fields include Gemini thought signatures and encrypted reasoning details. Flamework owns this round trip for applications.

The adapter names no model and no field, so a model the gateway adds later travels the same path as one it serves now. This is what keeps the round trip free of a per-provider table.

A live check against the Vercel AI Gateway on 2026-08-17 measured what each family returns on this surface, and what a second turn does when the fields go missing. Gemini carries its state in the tool call, as a thought signature. Claude Sonnet 4.6 and DeepSeek carry it in the reasoning details, as text with a signature. GPT 5.6 Sol carries it in the reasoning details too, as a summary beside an encrypted block. The adapter preserves all of these, because it copies fields rather than names.

A turn that needs no thought produces no state, so a model looks stateless until the question earns the reasoning. Measure this with a question hard enough to spend reasoning tokens, and read the token counters rather than the presence of a field.

A Claude model returns no reasoning details on this surface at all. Opus 5 and Sonnet 5 spend hundreds of thinking tokens here and return nothing to carry them, so on this wire format their thoughts end with the turn that made them. This is why an Anthropic model is asked on the Anthropic surface instead.

`anthropicMessagesInference(options)` speaks the Messages API, where a Claude model returns its thinking as blocks that carry a signature. `vercelGatewayInference()` chooses it for every `anthropic/` model, because the surface a model is asked on is not a decision a caller can be expected to make. The continuation protocol tag is what lets the two wire formats live beside each other: a continuation written by one adapter names its format, and the other ignores it.

The Messages surface takes the thinking configuration that matches the model's generation, and there is no one setting that suits both. Adaptive thinking is rejected by Claude Sonnet 4 and earlier, and a token budget is rejected by Opus 5 and Sonnet 5. So the adapter asks for neither by default: the Claude 5 generation already thinks without being asked, and an earlier model takes `thinkingBudget`. `effort` sets the adaptive level where the model supports one.

That default takes nothing away from an earlier model. Sonnet 4.6 and Sonnet 4 spend no thinking tokens on either surface until something asks them to, so the surface they are asked on changes what is preserved rather than what is produced.

Where a request runs is a deployment's decision, so no provider here states a preference and `routes` is empty until a caller fills it. This has one consequence worth knowing. The adapter asks for one tool call at a time, because the harness runs one at a time, and a route can ignore that request. Amazon Bedrock does, and answers with several calls. A turn served that way fails on the model's own second call, and the failure names the setting that was asked for, the route behaviour that ignored it, and `routes` as the way to reach a route that honours it.

A caller that drops the state gets an answer rather than an error, which is what makes the loss quiet. Google rejects a function call that arrives with no thought signature, and names the missing field in a 400. The gateway keeps that rejection away from the caller by sending a sentinel value in place of the signature, which turns the validation off. The request then succeeds, and the model answers the turn without the thoughts it had already paid for.

Google defines that sentinel for a caller replaying function calls it made itself, and discourages it otherwise, because a model that gets it answers without its earlier thoughts. The gateway applies it on the caller's behalf, and says so nowhere in its documentation or its responses. A harness therefore can not learn from the wire that it dropped the state, which is why the regression test pins the fields rather than a status code.

The measurement shows the difference upstream. With the signature, Google counted 333 prompt tokens and resumed thinking. With the signature dropped, it counted 92 and started the turn cold. A request that sent the sentinel by hand matched the dropped one exactly, which is how the substitution shows itself from outside.

A Claude model loses its state the same quiet way, though nothing stands in for what went missing. The substitution belongs to Google alone. What the families share is that the request succeeds either way, so only the token count says whether the model received what it had already thought.

Each family puts its state in a different field, so the adapter preserves fields rather than a list of names. This is what lets one round trip serve a model whose state lives in the tool call and a model whose state lives beside the message.

`bun run smoke:live` is what checks that the preserved state reaches the model, because no test that stubs the gateway can. It runs one tool-calling turn per model twice, once replaying what the provider returned and once replaying only what an event log holds, and reads the prompt tokens the provider counted. A model that reads the same either way never received the state. It calls live models and costs money, so it runs from a command rather than from the gate.

The last run, on 2026-08-17, read more with the state preserved for every model: Gemini 3.1 Pro at 431 against 99, GPT 5.6 Sol at 164 against 129, DeepSeek V4 Pro at 563 against 392, Claude Opus 5 at 622 against 571, and Claude Sonnet 4.6 at 706 against 590.

A response the gateway stopped at its completion-token limit is a truncated action. The fragment it returns has the shape of an answer, so reading it as one would finish a turn on half a sentence or dispatch a tool call whose arguments stop mid-JSON. The action carries the usage, because those tokens were spent, and it carries the cut tool call as a name and its raw partial arguments rather than as prose. A provider that wrote that call into the text would be inventing a notation for it, and the model that reads the conversation back was trained on no such notation. The inference loop records all of it as `AnswerTruncated`.

The OpenAI-compatible provider requests serial tool calling with `parallel_tool_calls: false`. The harness action type carries one tool call, so a response that still contains several calls becomes a visible failed action with its usage. No call is silently dropped. The failure names `routes`, because that option reaches a provider that honours the serial request, and it is forwarded on this path the same way it is on the Messages path.

A request estimated past a known context window is refused before it is sent. It cannot succeed, so sending it buys a slow refusal in the gateway's words, and this one names both sizes, the reserved output ceiling, and the model they belong to. The estimate is characters over four, which runs low against JSON and code, so a refusal means the request is past the window rather than near it.

## requestOptions

`requestOptions(of)` contributes `RequestOptionsProjection`. The projection is a fold from the log to per-request provider settings: service tier, temperature, output ceiling, effort, routes, and a body overlay. Inference reads it when it builds the model request, so the settings are a projection the way `InferenceStateProjection` feeds compaction, and invariant 4 still holds: model requests are pure projections of the log.

`flexThenStandard()` is the shipped policy. It asks for flex until the current turn has two `ModelDeferred` events, then standard. A replay of the same log sends the same tier. `agent.request(log)` shows the choice without calling a provider.

```ts
const agent = createAgent({
  modules: [inference({ contextWindow: 200_000 }), flexThenStandard(), nativeTools([lookup])]
})
```

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

The module appends `CompactionCompleted` with an `upTo` offset and summary. It deletes no events. Rendering substitutes the latest summary for the compacted prefix. A cut that would split a `ToolCalled` from its `ToolReturned` snaps back so the pair stays in the tail: both APIs reject a result with no call.

The inference loop can append `CompactionFired` mid-turn, and this module already accepts that event from idle. A mid-turn checkpoint is stamped with the open turn so the model loop can observe `CompactionCompleted` and continue. The two triggers ask different questions: this module's ratio asks whether a log has grown enough to be worth summarizing, and the loop asks whether the next request can be sent at all.

When a Morph API key is absent or the call fails, the local deterministic fallback produces the checkpoint.

## nudge

`nudge(options)` creates a render-only module. It contributes no machine and emits no event.

Use a nudge for conditional prompt text or conditional native-tool surfaces that are pure projections of the log. Use a machine when behavior must append facts, wait for events, or perform effects.

A nudge can depend on machine state. For example, a machine can record `ReminderShown`, while the nudge predicate projects whether the reminder should still appear. The durable lifecycle belongs to the machine and the request contribution remains a projection.

## truncation

`truncationNudge(options)` returns the two nudges that speak to a model whose answer was cut at [the output ceiling](#inference), and `defaultPack` includes them. `continueText` answers cut prose and `reissueText` answers a cut tool call.

The split is the point. Cut prose can be continued from the fragment. A cut tool call cannot: its arguments stopped mid-JSON, so nothing was dispatched, and the call has to be made again at a size that finishes. Both are read from `AnswerTruncated`, which carries the tool's name when a call was what stopped.

These words are agent design, so they are a module rather than something the loop or the renderer writes. The renderer replays the fragment as the assistant turn it was and says nothing about it, because what to ask for next depends on what the agent was building. An agent whose tools can append wants to name that affordance. An agent that would rather split the work or shorten the deliverable says so instead. An agent that wants none of this composes its modules without these two.

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
