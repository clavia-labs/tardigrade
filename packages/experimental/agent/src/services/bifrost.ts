import { Effect, Layer, Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Bifrost, BifrostHandle } from "@clavia/tardigrade-model/bifrost"
import { bifrostWebhookVerifier, type BifrostWebhookOptions } from "@clavia/tardigrade-model/bifrost-webhook"
import { type ResolutionPoll } from "@clavia/tardigrade-experimental-host"
import { ModelLock } from "./model-lock"
import { Model, type ModelInput } from "./model"

const Completion = Schema.Struct({ choices: Schema.Array(Schema.Struct({
  finish_reason: Schema.NullOr(Schema.String),
  message: Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)), tool_calls: Schema.optionalKey(Schema.Array(Schema.Struct({
    id: Schema.NonEmptyString,
    function: Schema.Struct({ name: Schema.NonEmptyString, arguments: Schema.String }),
  }))) }),
})) })
const Arguments = Schema.Struct({ input: Schema.Json })

const decodeReply = (raw: unknown) => Effect.gen(function* () {
  const reply = yield* Schema.decodeUnknownEffect(Completion)(raw)
  const choice = reply.choices[0]
  if (!choice) return yield* Effect.fail(new RuntimeError("Bifrost returned no completion choices"))
  if (choice.finish_reason === "length") return yield* Effect.fail(new RuntimeError("Bifrost model reached its output token limit"))
  const toolCalls = yield* Effect.forEach(choice.message.tool_calls ?? [], call => Effect.gen(function* () {
    const json = yield* Effect.try({ try: () => JSON.parse(call.function.arguments), catch: RuntimeError.from })
    const args = yield* Schema.decodeUnknownEffect(Arguments)(json)
    return { callId: call.id, name: call.function.name, input: args.input }
  }))
  return { text: choice.message.content ?? "", toolCalls }
})

// bifrostWebhook supplies the Inbox verifier; omitted results wake its polling adapter after durable acceptance.
export const bifrostWebhook = (options: BifrostWebhookOptions) => Effect.map(bifrostWebhookVerifier(options), verify => (request: Request) => Effect.gen(function* () {
  const { id, handle, data } = yield* verify(request)
  if (data.status === "failed" && data.error !== undefined) return { id, handle, result: { status: "rejected" as const, reason: `Bifrost job failed: ${JSON.stringify(data.error)}` } }
  if (data.status === "completed" && data.response !== undefined) return { id, handle, result: yield* completionResult(data.response) }
  if (data.result_expired) return { id, handle, result: { status: "rejected" as const, reason: "Bifrost job result expired before webhook delivery" } }
  return { id, handle }
}))

const completionResult = (raw: unknown) => decodeReply(raw).pipe(
  Effect.flatMap(value => Schema.decodeEffect(Schema.Json)(value)),
  Effect.map(value => ({ status: "fulfilled" as const, value })),
  Effect.catch(error => Effect.succeed({ status: "rejected" as const, reason: String(error) })),
)

export const DEFAULT_BIFROST_PROVIDER = "bifrost"
export interface BifrostModelOptions {
  readonly provider?: string
  readonly maxOutputTokens: number
}

// bifrostModelServices supplies synchronous calls and remote submission; the host resolver delivers submitted results.
export function bifrostModelServices(options: BifrostModelOptions) {
  return Layer.effect(Model, Effect.gen(function* () {
    const remote = yield* Bifrost
    const lock = yield* ModelLock
    if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) return yield* Effect.fail(new RuntimeError("maxOutputTokens must be a positive safe integer"))
    const body = (input: ModelInput) => Effect.gen(function* () {
      const resolved = lock.resolve(input.model)
      if (resolved.model.provider !== (options.provider ?? DEFAULT_BIFROST_PROVIDER)) return yield* Effect.fail(new RuntimeError("The selected model does not belong to this Bifrost service"))
      return {
        model: resolved.model.model_id,
        max_completion_tokens: options.maxOutputTokens,
        messages: [
          { role: "system", content: input.system },
          ...input.context.map(message => message.role === "user" ? { role: "user", content: message.text }
            : message.role === "tool" ? { role: "tool", tool_call_id: message.providerId, content: message.text }
            : { role: "assistant", content: message.text || null, ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({
              id: call.providerId, type: "function", function: { name: call.name, arguments: JSON.stringify({ input: call.input }) },
            })) } : {}) }),
        ],
        ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: "function", function: {
          name: tool.name, description: `${tool.description} Execution: ${tool.execution ?? "sync"}.`,
          parameters: { type: "object", properties: { input: tool.inputSchema }, required: ["input"], additionalProperties: false },
        } })), tool_choice: "auto" } : {}),
      }
    })
    const submit = (input: ModelInput) => body(input).pipe(Effect.flatMap(remote.submit))
    return {
      submit,
      call: input => body(input).pipe(Effect.flatMap(remote.call), Effect.flatMap(decodeReply)),
    } satisfies typeof Model.Service
  }))
}

// bifrostPoll checks a remote model job once; scheduling belongs to the resolver layer.
export const bifrostPoll = Effect.map(Bifrost, remote => ((handle) => Effect.gen(function* () {
  const reference = yield* Schema.decodeUnknownEffect(BifrostHandle)(handle)
  const state = yield* remote.poll(reference)
  if (state.status === "rejected") return { status: "rejected" as const, reason: state.error }
  if (state.status !== "fulfilled") return state
  return yield* completionResult(state.value)
})) satisfies ResolutionPoll)
