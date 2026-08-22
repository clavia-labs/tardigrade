# Structured output

A turn can declare an output contract. The contract is a named JSON Schema for the turn's result. `output` derives the result's TypeScript type from the schema, and `outputOf` returns the validated value.

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

In this example, `review.verdict` has type `"ship" | "hold"`, and `review.reasons` is a readonly string array.

`output` constructs a typed contract from a schema literal. `outputFrom` and `OutputContract.from` accept run-time values and return `OutputContract<unknown>`. Each contract keeps a frozen copy of its schema, so changing the source object cannot change the contract.

`outputOf` returns `undefined` while a turn is pending or after it fails. For a completed turn, it checks the contract name, schema, and stored result. A mismatch throws.

## Native output

The model binding uses native structured output whenever the configured endpoint declares that it supports the current call. The OpenAI-compatible binding sends `response_format: { type: "json_schema", strict: true }`. The Bedrock Converse binding sends `outputConfig.textFormat`. Both carry the contract's name and schema.

Native mode adds no output tool and no output instruction to the prompt. Ordinary tools remain available when the endpoint declares `withTools: true`. Tardigrade validates the returned JSON locally before recording `TurnCompleted`. A native response that fails local validation ends with `output_contract_violation` because the endpoint did not meet its declared guarantee.

`ModelCalled` records the declared contract and fallback before inference starts. When the binding selects a mode, the resulting tool call or terminal records that mode and the endpoint. Replay uses these records, so a later configuration change does not alter an earlier turn.

## Capability and fallback selection

The capability describes one configured endpoint and model:

```ts
const model = infer({
  baseUrl: process.env.MODEL_BASE_URL!,
  apiKey: process.env.MODEL_API_KEY!,
  model: process.env.MODEL_ID!,
  output: { guarantee: "native", withTools: true }
})
```

`withTools` states whether the endpoint accepts a strict output schema beside a tool list. Tardigrade does not infer this value from the provider name because support also depends on the endpoint and model.

The binding selects a mode for each call:

| Condition | Selected mode |
| --- | --- |
| Native output supports the call | Native |
| Native output does not support the call and the agent mounts a fallback | The mounted fallback |
| Native output does not support the call and the selected strategy has no fallback | `output_unsupported` before the provider request |

A mounted fallback does not disable native output. When native mode is available, fallback prompt text is omitted from the request.

The server and CLI read `MODEL_OUTPUT_GUARANTEE` and `MODEL_OUTPUT_WITH_TOOLS`. `tdg setup` asks for both values. A custom host passes the `output` value to `infer` directly. `outputPreflight` exposes the same compatibility check for startup validation.

Provider references:

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Bedrock structured output](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)

## Dependency injection and type checks

`Infer` is the injected Effect service. A model layer created by `modelInfer(...)` provides it, and the infer root requests it for each attempt.

Every agent assembly selects one output strategy component. `nativeOutput` selects provider-native output. `outputRepairFor(...)`, `outputValidateOnce`, and delegated fallbacks contribute an `OutputFallback` and any fallback prompt.

`infer` combines its child requirements with the model loop, and `actor` carries the root requirements to the host:

| Output strategy | Required model services |
| --- | --- |
| `nativeOutput` | `Infer` and `NativeOutputSupport` |
| Validate-once, repair, or delegated fallback | `Infer` |

`modelInfer(...)` provides `NativeOutputSupport` only when its statically known configuration declares `{ guarantee: "native", withTools: true }`.

```ts
import { actor, codeMode, infer, nativeOutput, outputRepairFor, reply } from "tardie"
import { infer as modelInfer } from "tardie/model"

const nativeOnly = actor(infer([codeMode, reply, nativeOutput]))
const nativeModel = modelInfer({ ...modelConfig, output: { guarantee: "native", withTools: true } })
// nativeModel provides Infer and NativeOutputSupport.

const portable = actor(infer([codeMode, reply, outputRepairFor({ attempts: 1 })]))
const unprovenModel = modelInfer({ ...modelConfig, output: { guarantee: "none" } })
// portable requires Infer. unprovenModel provides it.
// A host that binds nativeOnly to unprovenModel has a missing NativeOutputSupport type error.
```

The host fails type checking when it connects a native-only agent to a statically unsupported model layer. This check covers the declared configuration and program wiring. TypeScript cannot verify a remote endpoint. A configuration widened to `ModelConfig` or read from the environment supplies no static proof until application code narrows it, so the usual dynamic host selects an explicit fallback. A `withTools: false` declaration also supplies no proof because `nativeOutput` does not encode an empty tool surface in its type. `outputPreflight` checks each actual call before the provider request. Local validation catches an endpoint that breaks its declaration after the request.

Actor artifacts and server environment variables meet after TypeScript has run. The built-in server and generated actor template select `outputValidateOnce` explicitly. A custom artifact that selects `nativeOutput` relies on the server's per-call preflight and native capability declaration.

TypeScript also checks the schema profile for schema literals, derives the result type, and checks the closed `OutputFallback` union. `outputRepairFor` accepts `Partial<RepairPolicy>`, so policy field names and value types are checked at the call site. Construction rejects invalid numeric bounds, invalid booleans, malformed custom fallbacks, and multiple fallback components.

## Schema profile

An output schema must follow this profile:

- The root is an object schema.
- Every object declares `properties`, `additionalProperties: false`, and a `required` list that names every property exactly once.
- A union uses `anyOf`. A nullable field uses a union with `{ "type": "null" }`.
- Every node declares `type` from `string`, `number`, `integer`, `boolean`, `null`, `array`, and `object`, or declares `anyOf`.
- A string `format` comes from `OUTPUT_STRING_FORMATS`.
- A string `enum` has at least one unique member.
- Other keywords are outside the profile. This includes `pattern`, `minLength`, `minimum`, `title`, `default`, `oneOf`, `allOf`, `not`, `$ref`, and `$defs`.
- The schema is a tree. Cycles are rejected.

The profile is a conservative shared subset for the two bindings. Tardigrade sends the declared schema unchanged. An endpoint or model may impose additional model, version, nesting, property-count, or schema-size restrictions. Declaring native capability asserts that the configured endpoint accepts the contracts the application sends.

`output` reports an out-of-profile literal at the call site:

```ts
output({
  name: "loose",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, notes: { type: "string" } },
    required: ["title"],
    additionalProperties: false
  }
  // Type error: required must list every property; missing "notes"
})
```

`outputProfileErrors` applies the same rules to unknown values at run time. Tardigrade applies no fixed schema-depth limit to either check. The TypeScript compiler can still reach its own instantiation limit on an unusually deep literal.

## Validate-once fallback

`outputValidateOnce` asks for JSON in the fallback prompt and validates one response. A mismatch ends the turn with `output_validation_failed`. It performs no correction attempt.

```ts
import { actor, codeModeFor, infer, outputValidateOnce, reply } from "tardie"

const agent = actor(infer([
  codeModeFor({ packages: [] }),
  reply,
  outputValidateOnce
]))
```

## Repair fallback

`outputRepairFor` records an invalid response and asks again with the validation errors. Its policy is explicit:

```ts
import { actor, codeModeFor, infer, outputRepairFor, reply } from "tardie"

const agent = actor(infer([
  codeModeFor({ packages: [] }),
  reply,
  outputRepairFor({ attempts: 2, projectHistory: true })
]))
```

`attempts` is the maximum number of correction requests for one turn epoch. A value of `2` permits at most three model calls: the initial call and two corrections. Exhaustion ends with `output_repairs_exhausted`. `DEFAULT_REPAIR_POLICY` provides the exported defaults, and `outputRepairFor` accepts overrides.

Each invalid response becomes an `OutputRejected` event with the original text, schema identity, validation errors, selected mode, usage, and endpoint. Repair is not represented as a tool call.

`projectHistory: true` removes completed repair exchanges from later model input, context measurement, and compaction summaries. `OutputRejected`, any delegated `OutputRetryRequested`, and the later `ModelCalled` remain in the durable log. The projection reads the policy recorded on the rejection, so later configuration changes do not alter prior history.

## Delegated fallback

A custom fallback contributes `kind: "delegated"`. The core records `OutputRejected` and waits. The component can append `outputRetryRequested` with domain-specific feedback, fail the turn, or leave it pending.

```ts
import { defineOutputFallback } from "tardie"

const houseStyle = defineOutputFallback({
  name: "output.house-style",
  derive: (log) => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [
        {
          component: "output.house-style",
          kind: "fallback",
          fallback: { kind: "delegated", name: "house-style", projectHistory: true },
          system: "Reply with JSON matching the house schema."
        }
      ]
    },
    transitions: decide(log)
  })
})
```

`outputRetryRequested` records the component's feedback and serializable decision. The later `ModelCalled` event records whether another request began. The framework does not add its repair message to a delegated fallback.

## Failure causes

| Cause | Meaning |
| --- | --- |
| `output_unsupported` | The call has no usable native capability or fallback, the schema is outside the profile, or the declaration is invalid. This is detected before the provider request. |
| `output_contract_violation` | An endpoint declared native strict output and returned a value that failed local validation. |
| `output_validation_failed` | A validate-once fallback returned a value that failed validation. |
| `output_repairs_exhausted` | The repair fallback used every configured correction attempt. |
| `refused` | The provider refused the request. |
| `truncated` | The response reached the configured output ceiling. |
| `inference_error` | Transport, endpoint, or stream processing failed. |
| `inference_attempts_exhausted` | The configured provider or process retry policy was exhausted. |

## Structural and semantic validation

A schema checks structure. Application code remains responsible for domain meaning. The `REVIEW` contract accepts `{ "verdict": "ship", "reasons": [] }` because its fields and values match the schema. It cannot establish whether the evidence supports that verdict.

Run domain checks after reading the value:

```ts
const review = outputOf(REVIEW, await host.read("ag.root"), "m1")
if (review !== undefined && review.verdict === "hold" && review.reasons.length === 0) {
  throw new Error("a held deploy requires a reason")
}
```

A delegated fallback can run domain validation before it requests another attempt.

## Child agent contracts

Code executed by the model can request structured output from a child agent. Register known contracts with `agentsPackage`:

```ts
codeModeFor({ packages: [agentsPackage({ outputs: { review: REVIEW } })] })
```

The model-written code names the registered contract:

```js
const { output } = await agents.run({ text: "review the deploy", output: "review" })
```

A registered name resolves to the contract checked by TypeScript when the actor was built. An unknown name returns an error with the available names. A raw schema is also accepted for dynamic work and returns `unknown`; it is checked against the profile before the child receives a request.

`agents.result` and `agents.continue` read the contract from the child run's durable events. Later registry changes cannot reinterpret an earlier result.
