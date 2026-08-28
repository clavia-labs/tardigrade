import * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime"
import { FetchHttpHandler } from "@smithy/fetch-http-handler"
import { BedrockConverseTextAdapter, type BEDROCK_CONVERSE_MODELS } from "@tanstack/ai-bedrock"
import type { OutputRequest } from "tardie/inference/request"
import { NATIVE_MODE, type OutputMode } from "tardie/output/contract"
import { outputNameFor, outputSchemaFor } from "./output"
import type { ModelAdapter, ModelConfig, ModelStopClass, StreamBounds } from "./adapter"

type SmithyHandler = Pick<FetchHttpHandler, "handle" | "destroy">

const bedrockHandler = (config: ModelConfig, bounds: StreamBounds): SmithyHandler => {
  const transport: Promise<SmithyHandler> =
    (globalThis as { Bun?: unknown }).Bun === undefined
      ? Promise.resolve(new FetchHttpHandler({ requestTimeout: bounds.totalMs }))
      : (() => {
          const moduleName = "@smithy/node-http-handler"
          return (import(/* @vite-ignore */ moduleName) as Promise<typeof import("@smithy/node-http-handler")>).then(
            ({ NodeHttpHandler: Handler }) =>
              new Handler({
                connectionTimeout: bounds.firstChunkMs,
                socketTimeout: bounds.idleMs,
                requestTimeout: bounds.totalMs,
                throwOnRequestTimeout: true
              })
          )
        })()

  return {
    handle: async (request, handlerOptions) => {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== "authorization")
      )
      request.headers["cf-aig-authorization"] = `Bearer ${config.apiKey}`
      return (await transport).handle(request, handlerOptions)
    },
    destroy: () => {
      void transport.then((handler) => handler.destroy()).catch(() => undefined)
    }
  }
}

export const converseOutputConfig = (
  output: OutputRequest,
  mode: OutputMode
): BedrockRuntime.OutputConfig | undefined => {
  const schema = outputSchemaFor(output, mode)
  const name = outputNameFor(output, mode)
  if (schema === undefined || name === undefined) return undefined
  return { textFormat: { type: "json_schema", structure: { jsonSchema: { name, schema: JSON.stringify(schema) } } } }
}

export const converseStopClass = (stopReason: string | undefined): ModelStopClass => {
  switch (stopReason) {
    case "guardrail_intervened":
    case "content_filtered":
      return "refused"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "truncated"
    case "malformed_model_output":
      return "violation"
    default:
      return "ok"
  }
}

export const tapStopReason = <T>(
  stream: AsyncIterable<T>,
  into: { stopReason?: string }
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for await (const event of stream) {
      const stop = (event as { messageStop?: { stopReason?: unknown } }).messageStop?.stopReason
      if (typeof stop === "string") into.stopReason = stop
      yield event
    }
  }
})

export const tapConverseUsage = <T>(
  stream: AsyncIterable<T>,
  into: { usage?: unknown }
): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for await (const event of stream) {
      const usage = (event as { metadata?: { usage?: unknown } }).metadata?.usage
      if (usage !== undefined) into.usage = usage
      yield event
    }
  }
})

export const bedrockConverseTextAdapter = (
  config: ModelConfig,
  maxTokens: number,
  bounds: StreamBounds,
  output?: OutputRequest,
  mode: OutputMode = NATIVE_MODE,
  stops: { stopReason?: string } = {},
  reported: { usage?: unknown } = {}
) => {
  const handler = bedrockHandler(config, bounds)
  const region = config.region ?? config.baseUrl.split("/").filter((s) => s !== "").at(-1)
  if (region === undefined) throw new Error("a Bedrock connection must declare its AWS region")
  return new (class extends BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]> {
    protected override importBedrockRuntime(): Promise<typeof BedrockRuntime> {
      return Promise.resolve(BedrockRuntime)
    }
    protected override buildClientConfig(
      resolved: Parameters<BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]>["buildClientConfig"]>[0],
      resolvedRegion: string,
      endpoint: string | undefined
    ) {
      return { ...super.buildClientConfig(resolved, resolvedRegion, endpoint), requestHandler: handler, maxAttempts: 1 }
    }
    public override buildInput(options: Parameters<BedrockConverseTextAdapter<(typeof BEDROCK_CONVERSE_MODELS)[number]>["buildInput"]>[0]) {
      const input = super.buildInput(options) as BedrockRuntime.ConverseStreamCommandInput
      input.inferenceConfig = { ...input.inferenceConfig, maxTokens }
      const outputConfig = output === undefined ? undefined : converseOutputConfig(output, mode)
      if (outputConfig !== undefined) input.outputConfig = { ...input.outputConfig, ...outputConfig }
      return input
    }
    protected override async sendStream(input: BedrockRuntime.ConverseStreamCommandInput) {
      const stream = await super.sendStream(input)
      return tapStopReason(tapConverseUsage(stream, reported), stops)
    }
  })({ apiKey: "byok", region, baseURL: config.baseUrl }, config.model as (typeof BEDROCK_CONVERSE_MODELS)[number])
}

// bedrockAdapter binds the Bedrock Converse protocol through the AWS and TanStack adapters.
export const bedrockAdapter: ModelAdapter = {
  id: "tanstack/bedrock-converse",
  protocols: ["bedrock-converse"],
  start: ({ config, request, mode, maxTokens, bounds, messages, tools, systemPrompts }) => {
    const stops: { stopReason?: string } = {}
    const reported: { usage?: unknown } = {}
    const adapter = bedrockConverseTextAdapter(config, maxTokens, bounds, request.output, mode, stops, reported)
    return {
      stream: adapter.chatStream({
        model: config.model,
        messages: messages as never,
        tools: tools as never,
        systemPrompts,
        modelOptions: { max_tokens: maxTokens } as never,
        logger: new Proxy({}, { get: () => () => {} }) as never
      } as never),
      reportedUsage: () => reported.usage,
      stopClass: () => converseStopClass(stops.stopReason),
      finishReason: () => stops.stopReason
    }
  }
}

// bedrockAdapterForBun verifies the Bun transport dependency before the host accepts Bedrock configuration.
export const bedrockAdapterForBun = async (): Promise<ModelAdapter> => {
  await import("@smithy/node-http-handler")
  return bedrockAdapter
}
