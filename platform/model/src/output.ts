import type * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime"
import { outputProfileErrors } from "tardie/output"
import type { OutputRequest } from "tardie/request"

// The binding's half of the output contract: which provider can promise a strict schema, what
// the promise costs a request, and how the declared schema reaches each wire. A turn that
// declares a contract the configured provider cannot honour fails here, before a socket opens
// (docs/output.md, "When the provider cannot").

// OutputCapability is what one configured endpoint can promise about a declared contract.
// `guarantee: "native"` means the endpoint takes the schema on its own response-format surface
// and constrains the response to it. `withTools` says the schema may ride the same call as a
// tool list: an endpoint that refuses the combination fails the turn before spend rather than
// letting the binding buy a second inference to finalize, which no caller asked for.
export interface OutputCapability {
  readonly guarantee: "native" | "none"
  readonly withTools: boolean
}

// PROVEN_OUTPUT_CAPABILITIES is the table of providers this repository binds and has read the
// wire for: the OpenAI Chat Completions `response_format: { type: "json_schema", strict: true }`
// alongside `tools`, and the Converse `outputConfig.textFormat` alongside `toolConfig`. A
// provider absent from this table is unproven, whatever protocol it speaks, because the promise
// belongs to the endpoint and the model rather than to the shape of the request.
export const PROVEN_OUTPUT_CAPABILITIES: Readonly<Record<string, OutputCapability>> = {
  openai: { guarantee: "native", withTools: true },
  bedrock: { guarantee: "native", withTools: true }
}

// capabilityOf resolves the endpoint's capability: what the configuration declares, else what
// the provider name proves, else nothing. An OpenAI-compatible endpoint nobody named is the
// third case: it may well be strict, and no request this binding can send would tell.
export const capabilityOf = (config: {
  readonly provider?: string
  readonly output?: OutputCapability
}): OutputCapability | undefined => {
  if (config.output !== undefined) return config.output
  if (config.provider === undefined) return undefined
  return PROVEN_OUTPUT_CAPABILITIES[config.provider]
}

// outputPreflight says why this request cannot be served, before it is sent. It is empty when
// the request declares no contract, when the implementation asks for no guarantee, or when the
// endpoint can keep the one it asks for. A host may call it at startup against its own
// contracts; the binding calls it on every attempt, so a log carrying a foreign contract fails
// the same way (model.test.ts, "an unsupported contract fails before the fetch, so nothing is
// spent").
export const outputPreflight = (
  request: { readonly output?: OutputRequest; readonly tools: ReadonlyArray<unknown> },
  config: { readonly provider?: string; readonly model: string; readonly output?: OutputCapability }
): ReadonlyArray<string> => {
  const output = request.output
  if (output === undefined || output.implementation.guarantee !== "native") return []
  const where = `${config.provider ?? "the configured OpenAI-compatible endpoint"} model ${config.model}`
  const capability = capabilityOf(config)
  if (capability === undefined) {
    return [
      `${where} declares no structured output capability, so the "${output.implementation.name}" implementation cannot promise the contract "${output.contract.name}". Declare one with the binding's \`output\` option when the endpoint honours a strict JSON schema, or mount an output implementation that does not need one.`
    ]
  }
  if (capability.guarantee !== "native") {
    return [
      `${where} declares no native structured output, so the contract "${output.contract.name}" cannot be obtained from its response format. Mount an output implementation that does not need one.`
    ]
  }
  if (!capability.withTools && request.tools.length > 0) {
    return [
      `${where} cannot carry the contract "${output.contract.name}" and a tool list on one call. Let the turn spend its tool budget before it answers, or mount an output implementation that does not need a native schema.`
    ]
  }
  const problems = outputProfileErrors(output.contract.schema)
  if (problems.length === 0) return []
  return [
    `the contract "${output.contract.name}" is outside the schema profile both wires send unchanged:`,
    ...problems.map((problem) => `- ${problem}`)
  ]
}

// outputSchemaFor returns the schema a native attempt sends, and undefined when the attempt
// sends none. It is the one place that reads the implementation's guarantee, so no leg can send
// a schema an implementation asked to be left off.
export const outputSchemaFor = (output: OutputRequest | undefined): unknown =>
  output === undefined || output.implementation.guarantee !== "native" ? undefined : output.contract.schema

// converseOutputConfig maps a contract onto the Converse structured output surface. The schema
// travels as a JSON string there, which is the shape `ConverseStreamCommandInput` declares
// (@aws-sdk/client-bedrock-runtime, OutputFormat).
export const converseOutputConfig = (output: OutputRequest): BedrockRuntime.OutputConfig => ({
  textFormat: {
    type: "json_schema",
    structure: { jsonSchema: { name: output.contract.name, schema: JSON.stringify(output.contract.schema) } }
  }
})
