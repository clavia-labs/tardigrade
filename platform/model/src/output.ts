import { NATIVE_MODE, outputNameErrors, outputProfileErrors, type OutputMode } from "tardie/output/contract"
import type { OutputRequest } from "tardie/inference/request"

// The binding's half of the output contract: what an endpoint promises about a declared schema,
// what that promise costs a request, and how the schema reaches each wire. A turn that declares a
// contract the configured endpoint cannot honour fails here, before a socket opens
// (model.test.ts, "the output mode one attempt runs in").

// OutputCapability is what one configured endpoint promises about a declared contract. It is a
// union so a value cannot say two things at once: an endpoint that promises nothing has no
// tool-combination question to answer, and one that promises a native strict schema must say
// whether that schema may ride the same call as a tool list.
export type OutputCapability =
  | { readonly guarantee: "none" }
  | { readonly guarantee: "native"; readonly withTools: boolean }

// capabilityOf resolves the endpoint's capability: what the configuration declares, and nothing
// else. A provider name is not evidence. Structured output on both wires this repository binds is
// a property of the endpoint AND the model behind it: OpenAI documents Chat Completions
// structured outputs for a listed set of models, and AWS documents Converse structured output for
// a listed set of Claude models, so `provider: "openai"` or `provider: "bedrock"` says nothing
// about the model id an operator configured. Inferring a strict guarantee from the vendor would
// let an unsupported model pass preflight and spend
// (https://developers.openai.com/api/docs/guides/structured-outputs;
// https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).
export const capabilityOf = (config: { readonly output?: OutputCapability }): OutputCapability | undefined =>
  config.output

// UNPROVEN is the message an endpoint that declared nothing earns. It names the two ways out, so
// an operator reading a failed turn knows what to set rather than which source to read.
const UNPROVEN = (where: string, contract: string, implementation: string): string =>
  `${where} declares no structured output capability, so the "${implementation}" implementation cannot promise the contract "${contract}". ` +
  `Declare one when this endpoint and this model honour a strict JSON schema through model-directory metadata or the binding's \`output\` option, ` +
  `or mount an output implementation that needs no guarantee.`

// outputModeOf selects how one attempt obtains the declared contract. Native comes first
// whenever the configured endpoint can serve this call, because a strict schema on the wire is a
// better guarantee than any local reading; mounting a fallback never turns that off. Native is
// unavailable when the endpoint promises nothing, when it promises nothing native, or when it
// cannot carry a schema beside the tools this request offers, and then the declared fallback runs.
// With neither, the turn fails before it spends (model.test.ts, "no native capability runs the
// declared fallback, and fails without one").
export const outputModeOf = (
  request: { readonly output?: OutputRequest; readonly tools: ReadonlyArray<unknown> },
  config: { readonly provider?: string; readonly model: string; readonly output?: OutputCapability }
): { readonly mode: OutputMode } | { readonly errors: ReadonlyArray<string> } => {
  const output = request.output
  const where = `${config.provider ?? "the configured OpenAI-compatible endpoint"} model ${config.model}`
  if (output === undefined) return { mode: NATIVE_MODE }
  if (output.kind === "invalid") {
    return { errors: [`${where} was asked for an output that is not a contract:`, ...output.errors.map((e) => `- ${e}`)] }
  }
  const problems = [...outputNameErrors(output.contract.name), ...outputProfileErrors(output.contract.schema)]
  if (problems.length > 0) {
    return {
      errors: [
        `${where} was asked for the contract "${output.contract.name}", which is outside the schema profile both wires send unchanged:`,
        ...problems.map((problem) => `- ${problem}`)
      ]
    }
  }
  const capability = capabilityOf(config)
  if (capability?.guarantee === "native" && (capability.withTools || request.tools.length === 0)) {
    return { mode: NATIVE_MODE }
  }
  if (output.fallback !== undefined) return { mode: output.fallback }
  if (capability === undefined) return { errors: [UNPROVEN(where, output.contract.name, "native")] }
  if (capability.guarantee !== "native") {
    return {
      errors: [
        `${where} declares no native structured output, so the contract "${output.contract.name}" cannot be obtained from its response format, and this agent mounts no output fallback.`
      ]
    }
  }
  return {
    errors: [
      `${where} declares that it cannot carry the contract "${output.contract.name}" and a tool list of ${request.tools.length} on one call, and this agent mounts no output fallback. Let the turn spend its tool budget before it answers, or mount one.`
    ]
  }
}

// outputPreflight says why this request cannot be served, before it is sent. It is empty when the
// request can run in some mode, and it is the same reading outputModeOf does, so a host may call
// it at startup against its own contracts and read what a turn would read
// (model.test.ts, "an unsupported contract fails before the fetch, so nothing is spent").
export const outputPreflight = (
  request: { readonly output?: OutputRequest; readonly tools: ReadonlyArray<unknown> },
  config: { readonly provider?: string; readonly model: string; readonly output?: OutputCapability }
): ReadonlyArray<string> => {
  const selected = outputModeOf(request, config)
  return "errors" in selected ? selected.errors : []
}

// outputSchemaFor returns the schema an attempt sends, and undefined when it sends none. Only a
// native mode puts a schema on the wire, so no endpoint is handed one it never promised to keep.
export const outputSchemaFor = (output: OutputRequest | undefined, mode: OutputMode): unknown =>
  output === undefined || output.kind !== "contract" || mode.kind !== "native" ? undefined : output.contract.schema

// outputNameFor is the schema identity a native attempt sends beside the schema. Both wires carry
// a name, and both carry the declared one (compatibleResponseFormat; converseOutputConfig).
export const outputNameFor = (output: OutputRequest | undefined, mode: OutputMode): string | undefined =>
  outputSchemaFor(output, mode) === undefined || output?.kind !== "contract" ? undefined : output.contract.name

// fallbackSystemFor is the extra prompt an attempt sends: the fallback's own instruction, and only
// on an attempt running as that fallback. A native attempt reads exactly what it would read with
// nothing mounted (model.test.ts, "a mounted fallback is dormant on a native endpoint").
export const fallbackSystemFor = (output: OutputRequest | undefined, mode: OutputMode): string | undefined =>
  mode.kind === "native" || output?.kind !== "contract" ? undefined : output.fallbackSystem

// compatibleResponseFormat is the strict native response format the OpenAI-compatible wire takes.
// It is built here and passed through the adapter's provider-options seam rather than through its
// own schema converter: that converter exists to make an arbitrary schema strict-compatible, and
// the supported profile already is, so the schema travels unchanged and carries its declared name
// instead of the adapter's fixed one (@tanstack/openai-base, mapOptionsToRequest;
// model.test.ts, "a declared contract rides response_format").
export const compatibleResponseFormat = (
  output: OutputRequest | undefined,
  mode: OutputMode
):
  | {
      readonly type: "json_schema"
      readonly json_schema: { readonly name: string; readonly schema: unknown; readonly strict: true }
    }
  | undefined => {
  const schema = outputSchemaFor(output, mode)
  const name = outputNameFor(output, mode)
  if (schema === undefined || name === undefined) return undefined
  return { type: "json_schema", json_schema: { name, schema, strict: true } }
}
