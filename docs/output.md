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

A contract is a value only `output` can make. It holds a frozen copy of the schema, so a caller who kept the original object cannot widen it afterwards, and its type carries a brand no object literal and no spread can counterfeit. `outputFrom` is the honest constructor for a schema no TypeScript signature saw: it applies every rule below and gives back a contract whose value type is `unknown`.

`outputOf` reads an answer only from a turn that declared that same contract. Holding a contract is not evidence about a turn, so a turn that declared nothing, or one that declared a different schema under the same name, fails the read rather than having its text reinterpreted.

## What, and how

A contract says what the answer is. Two further values say how one attempt got it.

Native structured output is how, whenever the configured endpoint can serve the call. The contract rides the model request as itself: it adds no tool to the tool table, no tool choice, and no sentence to the prompt. The binding maps it onto the provider's own response-format surface, `response_format: { type: "json_schema", strict: true }` on the OpenAI-compatible wire and `outputConfig.textFormat` on the Bedrock Converse wire, carrying the schema unchanged and under its declared name. Both ride alongside the turn's ordinary tools, so an agent still calls tools during the loop while the contract governs the one response that ends the turn.

A fallback is how when native output is unavailable for the call: the endpoint promises none, or it cannot carry a schema beside the tools this request offers. A fallback is a component you mount, and mounting one never turns native output off. On an endpoint that guarantees a strict schema, a mounted fallback is dormant, and the request is identical, down to the prompt, to the one an agent with nothing mounted sends.

Tardigrade validates the response against the declared schema before it records a terminal, in every mode including the native one. An endpoint that returns a value missing the guarantee it made is a contract violation by that endpoint or its adapter, and the turn fails with `output_contract_violation` rather than asking the model again.

Every attempt records what it declared and what it ran as. The ask carries the contract's name, its fingerprint, and the fallback the assembly mounted; the answer carries the mode the binding selected and the endpoint that served it, whether or not that endpoint reported a single token. Replay reads those records, so a capability or a policy that changes later cannot rewrite what an old turn meant.

## The supported schema profile

A contract's schema must be in the profile both bound wires send unchanged:

- The root is an object schema.
- Every object declares `properties`, `additionalProperties: false`, and a `required` list naming every property and nothing else.
- A union is spelled `anyOf`. An optional field is a union with `{ "type": "null" }`.
- Every schema node declares a `type` from `string`, `number`, `integer`, `boolean`, `null`, `array`, and `object`, or an `anyOf`.
- A string `format` comes from the allowlist in `OUTPUT_STRING_FORMATS`. A string `enum` lists at least one string and repeats none.
- No other keyword appears anywhere. `pattern`, `minLength`, `minimum`, `title`, `default`, `oneOf`, `allOf`, `not`, `$ref`, and `$defs` are all outside the profile.
- The schema is a tree. One that points back at a node already declaring it is refused.

The profile is a rule about honesty rather than taste. Both provider paths rewrite a schema before sending it: a property missing from `required` is widened to accept null, an open object is closed, and a keyword the strict subset does not know is dropped. The model would then be constrained by a schema this repository never wrote, while local validation went on enforcing the one it did. Inside the profile the rewrite is the identity, so the schema on the wire is the schema you declared.

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

`outputProfileErrors` is the same rule at run time, for a schema no TypeScript signature saw. It reads every node at any depth and reports one line per rule broken. The compile-time message reaches twelve levels of nesting; the rule itself has no depth limit.

## When the provider cannot

An endpoint either sends a strict schema through its own response format or it does not. Tardigrade never guesses which, and a provider name is not evidence: structured output on both wires is a property of the endpoint and the model behind it, so `openai` or `bedrock` says nothing about the model id an operator configured.

The capability is declared. The server and the command line read `MODEL_OUTPUT_GUARANTEE` together with `MODEL_OUTPUT_WITH_TOOLS`, and a host that builds the binding itself passes the whole value:

```ts
const model = infer({
  baseUrl: process.env.MODEL_BASE_URL!,
  apiKey: process.env.MODEL_API_KEY!,
  model: process.env.MODEL_ID!,
  output: { guarantee: "native", withTools: true }
})
```

`withTools` says the endpoint carries the schema and a tool list on one call. An endpoint that refuses the combination sets it false, and then a turn that offers tools falls back for that call alone. No adapter buys a second inference to finalize an answer, so a bill always matches the calls a reader can count in the log.

An undeclared endpoint, or one that declares no native guarantee, serves a contract only through a mounted fallback. With none, the turn fails with `output_unsupported` before a socket opens, so it costs nothing. `outputPreflight` is exported, so a host can run the same reading against its own contracts at startup.

Official documentation for the two surfaces this repository binds:

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Bedrock structured output](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)

## Fallbacks

`outputFailFast` takes the answer the model gives, validates it once, and ends the turn with `output_validation_failed` on a mismatch. Choosing not to retry is a decision, and mounting this is how you state it.

`outputRepair` is the framework's correction loop. It asks for the schema in the system text, hands a missed reply back with its reasons, and spends a bounded number of corrections:

```ts
import { actorOf, agentRuntime, codeModeFor, outputRepairFor, reply } from "tardie"

const agent = actorOf(agentRuntime(), [
  codeModeFor({ packages: [] }),
  reply,
  outputRepairFor({ attempts: 2, projectHistory: true })
])
```

`DEFAULT_REPAIR_POLICY` is the policy `outputRepair` takes. `attempts` is how many corrections one turn epoch may spend, so a policy of two asks the model three times at most; a rejection past the bound ends the turn with `output_repairs_exhausted`, and the terminal carries the policy it spent. A bound that is not a whole count of asks is refused where it is stated rather than floored at a turn.

A correction is a typed `OutputRejected` event carrying the response verbatim, the schema identity, one line per reason, and the mode the attempt ran in. Nothing about a rejection is a tool call.

`projectHistory` decides what later inference sees. With it on, a rejected response and its correction stop being rendered once the turn completes, so later turns read as though the model gave the corrected value first. The same projection runs before the context measure and before the summary brief, so a corrected exchange can neither trigger a paid compaction nor leak into a summary. The rejection stays in the log, where the evidence belongs. The policy read is the one recorded on the rejection, so a deployment that mounts a different one later cannot rewrite an old turn.

## Writing your own

A domain-specific mechanism is a component that contributes a `delegated` fallback. The core records the rejection and stops there: it schedules no further inference and writes no feedback of its own. The component derives what happens next from the typed `OutputRejected`:

```ts
const houseStyle: AgentComponent = {
  name: "output.house-style",
  derive: (log) => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [
        {
          component: "output.house-style",
          fallback: { kind: "delegated", name: "house-style", projectHistory: true },
          system: "Reply with JSON matching the house schema."
        }
      ]
    },
    // Derive a transition that appends `outputRetryRequested` with your own feedback, or a
    // `turnFailed` of your own, or nothing at all. The turn rests until you decide.
    transitions: decide(log)
  })
}
```

`outputRetryRequested` records the request rather than the retry: the `ModelCalled` that follows is the durable fact that the ask began. Its `feedback` is what the model reads back, so the framework's own correction sentence never appears, and its `decision` is your component's serializable record of why, stamped for replay. The reactor releases the turn only once the rejection has one.

## Failure classes

A contract makes the shape of an answer certain. It leaves everything else about inference exactly as uncertain as it was. Each class below has its own `cause` on `TurnFailed`, because each has a different remedy:

| Cause | What happened | Remedy |
| --- | --- | --- |
| `output_unsupported` | The endpoint cannot serve the contract and no fallback is mounted, the schema is outside the profile, or the declaration is not a contract. Found before spend. | Declare the capability, mount a fallback, or fix the schema. |
| `output_contract_violation` | An endpoint that promised a native strict guarantee returned a value missing it. | Report it to the provider or the adapter. A retry hides a broken promise. |
| `output_validation_failed` | A fail-fast fallback read one answer and it missed the contract. | Read the reasons on the terminal. |
| `output_repairs_exhausted` | The framework correction loop spent its bound. | Raise `attempts`, simplify the schema, or use a stronger model. |
| `refused` | The provider declined the request, on the wire or through a guardrail. | Change the request. The same one earns the same refusal. |
| `truncated` | The answer was cut at the top output ceiling. | Raise `maxOutputTokens`, or ask for less at once. |
| `inference_error` | Transport, the endpoint, or the stream failed. | Read the message. |
| `inference_attempts_exhausted` | Retries or process attempts ran out. | Read the policy on the terminal. |

## Structural and semantic correctness

A strict schema buys structure. It says nothing about whether the values are right.

`{ "verdict": "ship", "reasons": [] }` satisfies the `REVIEW` contract above completely. So does `{ "verdict": "hold", "reasons": ["the deploy is fine"] }`, whose reason contradicts its verdict. Structure is what the schema can enforce; whether the verdict follows from the evidence is a judgement the schema cannot make.

Domain rules belong in your own code, after the value comes back:

```ts
const review = outputOf(REVIEW, await host.read("ag.root"), "m1")
if (review !== undefined && review.verdict === "hold" && review.reasons.length === 0) {
  // A held deploy owes an operator a reason. The schema cannot say so; this can.
}
```

Semantic rules the model should act on belong in a delegated fallback, so a rejection, its feedback, and its bound land in the log beside every other fact about the turn.

## Contracts a model asks for

A code body running inside `execute` can spawn a child agent and ask for structured output from it. That code is written by a model and runs through `AsyncFunction`, so no TypeScript step ever saw it.

Declare the contracts a child may be asked for, and a code body names one:

```ts
codeModeFor({ packages: [agentsPackage({ outputs: { review: REVIEW } })] })
```

```js
const { output } = await agents.run({ text: "review the deploy", output: "review" })
```

A name resolves to a contract whose schema a TypeScript signature already checked, once, at the run. A name nobody declared comes back as an error listing the ones that are. A raw schema object stays reachable for work the host could not anticipate, and it is the honest case: the value comes back as `unknown`, and the schema is checked against the profile before the child is briefed, so a schema outside it costs no model call.

`agents.result` and `agents.continue` read a run's contract from that run's own durable facts: the recorded call says whether structure was asked for, and the child's brief says under which schema. A later argument cannot make an answer structured that never was, and a registry entry that changes or disappears afterwards cannot re-read an old answer as a different shape. A run known to have asked for structure whose declaration cannot be read fails closed rather than answering with the raw text.
