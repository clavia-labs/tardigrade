# Structured output

A turn's output contract declares the shape of the model's final response. Declare one, and the turn's answer is a value of that shape rather than prose you parse afterwards.

```ts
import { output, outputOf, receive } from "tardie"

const REVIEW = output({
  name: "review",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["ship", "hold"] },
      reasons: { type: "array", items: { type: "string" } }
    },
    required: ["verdict", "reasons"],
    additionalProperties: false
  }
})

await receive(agent, { id: "m1", text: "review the deploy", output: REVIEW })
await host.drive()

const review = outputOf(REVIEW, await host.read("ag.root"), "m1")
// review: { readonly verdict: "ship" | "hold"; readonly reasons: ReadonlyArray<string> } | undefined
```

`output` reads the schema literal and derives the TypeScript value from it, so `review.verdict` is the union the schema spells and `review.reasons.map` is an array method. Nothing was cast and nothing was annotated twice.

## How the contract reaches the model

The contract rides the model request as itself. It adds no tool to the tool table, no tool choice, and no sentence to the system prompt. The binding maps it onto the provider's own response-format surface: `response_format: { type: "json_schema", strict: true }` on the OpenAI-compatible wire, and `outputConfig.textFormat` on the Bedrock Converse wire. Both carry the schema alongside the turn's ordinary tools, so an agent still calls tools during the loop and the contract governs the one response that ends the turn.

Tardigrade validates the response against the declared schema before it records a terminal, on every provider including the strict ones. A strict provider that returns a value missing its own guarantee is a contract violation by that provider or its adapter, and the turn fails with `output_contract_violation` rather than asking the model again. Repair is a choice a developer makes, and it is described below.

## The supported schema profile

A contract's schema must be in the profile both bound wires send unchanged:

- The root is an object schema.
- Every object declares `properties`, `additionalProperties: false`, and a `required` list naming every property.
- A union is spelled `anyOf`. An optional field is a union with `{ "type": "null" }`.
- `oneOf`, `allOf`, `not`, `$ref`, `$defs`, `if`, `then`, and `else` are outside the profile.
- Every schema node declares a `type` or an `anyOf`.
- A string `format` comes from the allowlist in `OUTPUT_STRING_FORMATS`.
- The schema nests no deeper than `OUTPUT_SCHEMA_DEPTH`, which `outputProfileErrors` takes as an override. The bound is what makes the check total over a schema a model wrote, which may point at itself.

The profile is a rule about honesty rather than taste. Both provider paths rewrite a schema before sending it: a property missing from `required` is widened to accept null, and an open object is closed. The model would then be constrained by a schema this repository never wrote, and local validation would reject a response the provider was told to give. Inside the profile the rewrite is the identity, so the schema on the wire is the schema you declared.

`output` checks the profile twice. The type rejects an out-of-profile literal at the call site:

```ts
output({
  name: "loose",
  // Type error: required must list every property; missing "notes"
  schema: {
    type: "object",
    properties: { title: { type: "string" }, notes: { type: "string" } },
    required: ["title"],
    additionalProperties: false
  }
})
```

`outputProfileErrors` is the same rule at run time, for a schema no TypeScript signature saw. It reports one line per rule broken.

## When the provider cannot

A provider either sends a strict schema through its own response format or it does not. Tardigrade never guesses which.

`PROVEN_OUTPUT_CAPABILITIES` in the model binding names the providers whose wire this repository reads: `openai` and `bedrock`. An OpenAI-compatible endpoint that no provider name identifies promises nothing, because the promise belongs to the endpoint and the model rather than to the shape of the request. A turn that declares a contract against such an endpoint fails with `output_unsupported` before a socket opens, so it costs nothing.

An operator who knows their endpoint honours a strict JSON schema declares it. The server and the command line read `MODEL_OUTPUT_GUARANTEE=native`, and a host that builds the binding itself passes the capability:

```ts
const model = infer({
  baseUrl: process.env.MODEL_BASE_URL!,
  apiKey: process.env.MODEL_API_KEY!,
  model: process.env.MODEL_ID!,
  output: { guarantee: "native", withTools: true }
})
```

`withTools` says the endpoint carries the schema and a tool list on one call. An endpoint that refuses the combination sets it false, and a turn that would need both fails before spend. No adapter buys a second inference to finalize an answer, so a bill always matches the calls a reader can count in the log.

`outputPreflight` is exported, so a host can run the same check against its own contracts at startup rather than on the first turn.

## Repair, when you choose it

`outputRepair` is one implementation of an output contract, for a provider with no strict guarantee. It asks for the schema in the system text, validates the reply locally, and hands the model its own reasons back for a bounded number of corrections. Mount it like any other component:

```ts
import { actorOf, agentRuntime, codeModeFor, outputRepairFor, reply } from "tardie"

const agent = actorOf(agentRuntime(), [
  codeModeFor({ packages: [] }),
  reply,
  outputRepairFor({ attempts: 2, projectHistory: true })
])
```

`DEFAULT_REPAIR_POLICY` is the policy `outputRepair` takes. `attempts` is how many corrections one turn epoch may spend, so a policy of two asks the model three times at most; a rejection past the bound ends the turn with `output_repairs_exhausted`, and the terminal carries the policy it spent. A correction is a typed `OutputRejected` event carrying the response verbatim, the schema identity, and one line per reason, so an operator reads what the model sent and why it was refused.

`projectHistory` decides what later inference sees. With it on, a rejected response and its correction stop being rendered once the turn completes, so later turns read as though the model gave the corrected value first. The rejection stays in the log, where the evidence belongs; only the render drops it. With it off, the whole exchange keeps rendering.

An implementation is a value, so a domain-specific mechanism is the same move: a component whose view carries its own `OutputImplementation` and whose system text asks for the contract its own way. `guarantee: "none"` sends the provider no schema, and `onMismatch` says whether a response that misses the contract ends the turn or records a rejection for that component to act on. Two components declaring an implementation collide at construction, because a turn has one final response.

## Failure classes

A contract makes the shape of an answer certain. It leaves everything else about inference exactly as uncertain as it was. Each class below has its own `cause` on `TurnFailed`, because each has a different remedy:

| Cause | What happened | Remedy |
| --- | --- | --- |
| `output_unsupported` | The endpoint cannot promise the contract, or the schema is outside the profile. Found before spend. | Declare the capability, pick another endpoint, or mount an implementation that needs no guarantee. |
| `output_contract_violation` | A provider claiming a strict guarantee returned a value that misses the schema. | Report it to the provider or the adapter. A retry hides a broken promise. |
| `output_repairs_exhausted` | A correcting implementation spent its bound. | Raise `attempts`, simplify the schema, or use a stronger model. |
| `refused` | The provider declined the request. | Change the request. The same one earns the same refusal. |
| `truncated` | The answer was cut at the top output ceiling. | Raise `maxOutputTokens`, or ask for less at once. |
| `inference_error` | Transport, the endpoint, or the stream failed. | Read the message. |
| `inference_attempts_exhausted` | Retries or process attempts ran out. | Read the policy on the terminal. |

## Structural and semantic correctness

A strict schema buys structure. It says nothing about whether the values are right.

```ts
const REVIEW = output({
  name: "review",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["ship", "hold"] },
      reasons: { type: "array", items: { type: "string" } }
    },
    required: ["verdict", "reasons"],
    additionalProperties: false
  }
})
```

`{ "verdict": "ship", "reasons": [] }` satisfies this contract completely. So does `{ "verdict": "hold", "reasons": ["the deploy is fine"] }`, whose reason contradicts its verdict. Structure is what the schema can enforce; whether the verdict follows from the evidence is a judgement the schema cannot make.

Domain rules belong in your own code, after the value comes back:

```ts
const review = outputOf(REVIEW, await host.read("ag.root"), "m1")
if (review !== undefined && review.verdict === "hold" && review.reasons.length === 0) {
  // A held deploy owes an operator a reason. The schema cannot say so; this can.
}
```

Semantic rules that the model should retry on belong in a component, the same seam `outputRepair` uses, so a rejection and its bound land in the log beside every other fact about the turn.

## Contracts a model asks for

A code body running inside `execute` can spawn a child agent and ask for structured output from it. That code is written by a model and runs through `AsyncFunction`, so no TypeScript step ever saw it.

Declare the contracts a child may be asked for, and a code body names one:

```ts
codeModeFor({ packages: [agentsPackage({ outputs: { review: REVIEW } })] })
```

```js
const { output } = await agents.run({ text: "review the deploy", output: "review" })
```

A name resolves to a contract whose schema a TypeScript signature already checked. A name nobody declared comes back as an error listing the ones that are.

A raw schema object stays reachable for work the host could not anticipate, and it is the honest case: the value comes back as `unknown`, and the schema is checked against the profile before the child is briefed. A schema outside the profile is an error the calling body reads, and no child spawns and no model is called.
