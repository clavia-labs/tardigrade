# Migrate an existing agent

This guide moves an existing agent application to Tardigrade. It uses Vercel AI SDK names because they are common, and the same inventory applies to another agent harness. The migration covers actor logic, stored conversations, the HTTP boundary, client updates, and deployment configuration.

Read the [Tardigrade skill](../../skills/tardigrade/SKILL.md), the [quickstart](../getting-started/quickstart.mdx), and the [server guide](server.md) before editing the application.

## Inventory and baseline

Record the current behavior before changing code:

- Find the agent definition, model configuration, system instructions, tools, stopping rules, structured outputs, persistence, API routes, client state, authentication, and deployment commands.
- Run the existing tests and save their commands and results.
- Choose one representative task with a stable input and an answer that can be checked for semantic parity.
- Run that task once with the current harness. Record the provider, model, model settings, output, input tokens, output tokens, provider cost, and wall-clock latency. Vercel AI SDK exposes aggregate model usage through `totalUsage` on [`generateText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) and agent results.
- Count nonblank, non-generated lines in the agent loop, tool adapters, persistence, API, and client integration. Report any one-time history import script separately.
- List direct agent and model dependencies from the application manifest.

Use the same provider, model, settings, task, data, and measurement boundary for the Tardigrade run. If a value cannot be collected on both runs, report it as unavailable.

## Map the harness

The current Vercel AI SDK agent surface includes [`ToolLoopAgent` and loop control](https://ai-sdk.dev/docs/agents/loop-control), [`generateText` and `streamText`](https://ai-sdk.dev/docs/ai-sdk-core/generating-text), [tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), and [UI stream responses](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-agent-ui-stream-response). Map another framework by responsibility instead of type name.

| Existing concern | Tardigrade home |
| --- | --- |
| `ToolLoopAgent`, `generateText`, `streamText`, or a manual model loop | `actor({ name, methods, components: [infer([...])] })`; pass `models: { allow?, default? }` to narrow or override the host policy |
| System instructions | `system(...)` |
| Tool declarations and handlers | Package components mounted through `codeMode`, or fixed tools mounted through `tool` |
| `stopWhen`, maximum steps, and retry options | `budget`, `infer` policy, and domain components with explicit policy values |
| `prepareStep` and dynamic context | A component whose `step(state, event)` tracks sufficient state and whose `output(state)` changes its view |
| Message arrays and conversation storage | One append-only event log per thread |
| Structured output | `output(...)` plus `outputValidateOnce` or `outputRepairFor(...)` |
| Lifecycle callbacks and telemetry | Recorded events, usage projections, and host telemetry |
| AI SDK UI stream protocol | `makeActorClient().append()` plus the durable event stream from `follow()` |

Install Tardigrade with the repository's package manager. Bun 1.4 or later runs the CLI and the durable SQLite host.

```bash
bun add tardie
bunx tardie init agent --dir agents/agent
```

Edit the generated `agents/agent/actor.ts`. Keep the actor name stable across build, push, client configuration, and stored traces.

### Instructions and tools

Move static system text into `system(...)`. When instructions depend on recorded events, declare their sufficient state with `initial`, `step`, and `output` so each event updates the projection once:

```ts
system({
  initial: () => ({ installed: 0 }),
  step: (state, event) => event.type === "PackageInstalled" ? { installed: state.installed + 1 } : state,
  output: (state) => `Installed packages: ${state.installed}`
})
```

Keep application data out of the prompt when a scoped package can read it on demand.

Use a package component through `codeMode([...components])` when its methods are ordinary operations that the model can combine, filter, or repeat in JavaScript. This exposes one `execute` tool to the model and keeps package methods behind the code surface. Use `tool` when a provider-visible tool call, approval step, or exact tool schema is part of the application contract.

Preserve tool names, descriptions, input checks, authorization, side-effect rules, and result shapes during the first pass. Convert Zod or framework-specific schemas to the JSON Schema accepted by Tardigrade. Wrap asynchronous handlers in Effect and turn expected failures into serializable results that the model can act on.

Move related tools to code packages only when the decision rule above applies. Measure the result because one `execute` schema can reduce repeated tool-schema context while code generation and compaction can add model work.

### Policies and output

State every policy that affects behavior. `budget([codeMode(packages)], { limit })` limits calls within its component subtree, so it is not a direct replacement for a model-step limit that counts completions. Express a custom stop condition as a component whose state retains the events that affect the decision. Pass `giveUpAfter` through the second argument to `infer`, and use `compaction(...)` when the application needs a model-window resolver or hysteresis ratios that differ from `DEFAULT_COMPACTION_POLICY`.

Convert each structured result to `output({ name, schema })`. Send that contract with the turn and mount one explicit fallback. Use `outputValidateOnce` when one invalid response should end the turn, or `outputRepairFor({ attempts, projectHistory })` when bounded correction is part of the product behavior.

### Model binding

Keep the baseline provider and model when the Tardigrade binding supports their transport. The built-in binding accepts OpenAI Responses, OpenAI-compatible chat completions, Anthropic Messages, and Bedrock Converse. Run `tdg setup` to write the first private provider connection and default model together. Once that baseline exists, use `tdg setup provider` or `tdg setup default` when the migration changes one concern. The server resolves model metadata from its catalog snapshot.

List every existing model option and confirm that the selected binding represents it. A custom transport or required option belongs in an application-owned `Infer` layer and custom host. Do not silently drop a temperature, provider option, retry bound, output guarantee, or timeout that affects behavior.

## Move the application boundary

Enter the actor directory, build it, then start its API:

```bash
cd agents/agent
tdg build actor.ts
bun run dev
```

Replace direct model invocation in the application backend with the generated client:

```ts
import { makeActorClient } from "tardie/client"

const client = makeActorClient({
  baseUrl: process.env.TARDIGRADE_URL!
})

await client.append(threadId, {
  type: "MessageReceived",
  id: messageId,
  text
})
```

Mint `threadId` once per conversation and `messageId` once per user turn. Reuse the same message id when retrying delivery so the log absorbs the duplicate.

Replace AI SDK UI transport and `useChat` state with application state derived from Tardigrade events. Follow a thread after its last rendered sequence:

```ts
const stop = client.follow(threadId, {
  after: lastSequence,
  onEvent: ({ seq, event }) => {
    lastSequence = seq
    render(event)
  },
  onError: showStreamError
})
```

Render `MessageReceived` as the user turn, `TextReturned` as working text, `ToolCalled` and `ToolReturned` as progress, `TurnCompleted` as the final answer, and `TurnFailed` as the failure. The stream carries durable event-level updates. It does not carry provider token chunks.

Browser `EventSource` cannot attach the bearer token used by `TARDIGRADE_TOKEN`. Keep a protected Tardigrade server private and relay its authenticated event stream through the application backend. Use `client.events(threadId, { after })` as a polling fallback when the relay is unavailable.

Keep an existing public API route as an adapter until every caller uses the new event and result shapes. Remove the adapter after its consumers and tests move to the Tardigrade client.

## Import conversation history

Import history into a separate SQLite database. Keep the source store unchanged until the new system passes validation and its rollback window ends. Stop writes or take a consistent export before conversion.

Use `createBunHost().seed()` for imported history. `seed` appends a complete batch without waking the actor, so recorded conversations do not run again during import.

```ts
import { createBunHost } from "tardie/bun/host"
import type { Event } from "tardie/core/event"
import { threadOf } from "tardie/server/host"

const host = await createBunHost({
  database: ".tardigrade/imported.sqlite",
  actorFor: () => undefined
})

const turn = "legacy:conversation-42:message-7"
const events: Event[] = [
  { type: "MessageReceived", id: turn, text: "What changed?", at: 1_700_000_000_000 },
  { type: "TurnCompleted", turn, output: "The deployment changed.", at: 1_700_000_001_000 }
]

await host.seed(threadOf("legacy-conversation-42"), events)
await host.close()
```

Derive stable thread, turn, and call ids from legacy identifiers. Preserve event order and timestamps. Every imported `MessageReceived` must have one terminal in its active epoch.

Map a complete tool exchange between its message and terminal as `ToolCalled` followed by `ToolReturned`. Stamp both events with the turn id, keep call ids unique within the thread, and preserve the tool arguments and result. Map stored assistant working text to `TextReturned` with the same turn id.

Map an incomplete legacy turn to `TurnFailed` with the same turn id, a clear import error, and `cause: "inference_error"`. Include any saved partial assistant text as `TextReturned` before the failure. This keeps every imported thread settled and makes the incomplete state visible.

Refuse to write the import into an existing target database. A fresh target makes the script repeatable from the unchanged source and prevents duplicate unkeyed history events.

Validate the import before cutover:

1. Compare source conversation, message, tool call, tool result, and terminal counts with the target events.
2. Check that timestamps and ids retain their order and that every call and turn is complete.
3. Start `TARDIGRADE_DB=.tardigrade/imported.sqlite bun run dev`, inspect representative threads with `tdg events`, and confirm that no turn is pending and `tdg ls` reports no imported thread as running or blocked.
4. Send a new message to an imported thread and verify that the model receives the imported context and produces one new terminal.
5. Stop and restart the server, then confirm the imported history and new turn remain available.

## Compare the result

Run the same representative task once with Tardigrade. Use the same model, settings, input, data, and timer boundary as the baseline. Check semantic output parity before comparing efficiency.

Each recorded attempt keeps captured provider usage under `usage.providerReports[].providerSpecific`. One report contains the provider object directly. Multiple observations from one request appear as an array in arrival order. Retries retain their reports as separate entries. The default model binding records these reports with unknown normalized token counts and costs.

A model binding selects an interpretation through `ModelConfig.usageAdapter`. `OPENAI_CHAT_COMPLETIONS_USAGE_V1` is a versioned adapter for the [OpenAI Chat Completions usage contract](https://github.com/openai/openai-python/blob/2a98f6a1dee448c6410531c89c2de0af4383c6a7/src/openai/types/completion_usage.py). It validates token counts and subset relationships. Missing or null optional breakdowns remain unknown. Cached input and reasoning output are parts of the reported input and output counts; they are not added to those counts. Selecting this adapter asserts that the route uses that contract. A gateway that serves a different usage schema needs a matching adapter, even when its request API accepts Chat Completions.

```ts
import { OPENAI_CHAT_COMPLETIONS_USAGE_V1, usageFrom } from "tardie"

const usage = usageFrom({
  provider: "openai",
  model: "example-model",
  providerSpecific: {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 }
  }
}, OPENAI_CHAT_COMPLETIONS_USAGE_V1)
```

The adapter identity and version accompany the interpreted usage. A custom contract can supply a descriptor with `id`, `version`, and `adapt`, or a callback for local interpretation. Tardigrade preserves raw reports alongside interpreted metrics. An omitted adapter leaves metrics unknown. The model binding retains raw evidence and records an accounting error when interpretation fails; a valid model output remains available. Repairing interpretation does not repeat generation. Saved reports can be interpreted again with `usageFrom(report, adapter)`.

Execution completion and accounting coverage are separate. `coverageIn(events, turn)` checks the framework's recorded inference invocations and their consequences. Its default requires prompt and completion token counts. A caller can choose other required metrics, including a cost metric, without making token-only collection depend on pricing. The result identifies missing metrics and unresolved evidence. Its `observed` field is a subtotal of known contributions, and only a result with `status: "complete"` has `total`.

```ts
import { coverageIn } from "tardie"

const coverage = coverageIn(events, turn, {
  required: ["promptTokens", "completionTokens"]
})

if (coverage.status === "complete") {
  console.log(coverage.total.promptTokens, coverage.total.completionTokens)
} else {
  console.log(coverage.observed, coverage.missing, coverage.unresolved)
}
```

Coverage is scoped to framework-recorded inference invocations. A recorded call with no consequence remains unresolved, including an earlier occurrence whose later retry returned a result. Internal transport retries can contribute several provider reports to one invocation. This projection does not establish that every physical HTTP request was durably recorded before submission, or recover a receipt that the provider never exposed. Custom transports must expose their own request evidence. The application decides whether incomplete coverage pauses collection, blocks publication, or requires intervention.

`usageIn(events, turn)` returns interpreted usage with missing native-attempt evidence kept unknown. Use `coverageIn` when a report requires evidence of completeness and the identities of unresolved invocations. A measured zero remains zero. Token counts must be non-negative safe integers, and costs must be non-negative finite numbers. Numeric strings require explicit conversion in a custom adapter.

`priced(usage, table)` estimates cost from explicit prompt, completion, cache-read, and cache-write counts. An unused cache bucket needs an explicit zero. A positive cache bucket needs its matching rate. The helper keeps `reportedCostUsd` and `estimatedCostUsd` as distinct metrics. Its `costUsd` projection prefers an existing cost, then the reported cost, then the estimate. A complete table recomputes the estimate. An incomplete table preserves a recorded estimate or leaves it unknown. The binding rejects `ModelConfig.pricing`. Price tables belong in explicit usage adapters or analysis code.

Measure latency from request delivery through the terminal event.

For each numeric measure, report `change = Tardigrade - existing` and `percent = change / existing * 100`. A negative token, cost, latency, line, or dependency change is a reduction. Leave the percentage unavailable when the existing value is zero or either value is missing.

| Measure | Existing | Tardigrade | Change | Method |
| --- | ---: | ---: | ---: | --- |
| Harness lines | | | | Nonblank, non-generated lines in the inventoried harness and integration files |
| Direct dependencies | | | | Agent and model dependencies in the application manifest |
| Input tokens | | | | One matched task |
| Output tokens | | | | One matched task |
| Cost | | | | Provider value or stated price table |
| Latency | | | | Delivery through terminal |

Treat one matched model run as a sample. State any output difference or provider variance that limits the comparison. Report a regression with the same detail as an improvement.

## Cut over and report

Prepare the production Tardigrade deployment, database path, credentials, health check, and client URL. Keep production deployment as a separate authorized action. The migration itself proves the local actor with `tdg build`, `bun run dev`, and a representative `tdg call`.

Keep the existing endpoint and store available for rollback. Switch traffic only after tests pass, imported threads settle, a new turn succeeds, and the application renders event progress and terminals. Remove the existing harness dependencies after a repository search finds no remaining imports and the rollback window closes.

Finish with a short report containing:

- A summary of the actor, tool, policy, persistence, API, client, history, and deployment configuration changes.
- Existing test results, migration checks, and the matched task result.
- The comparison table with unavailable values labeled.
- Known behavior gaps and rollback instructions.
- The thread and event evidence for the migrated task.
