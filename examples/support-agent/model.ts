import { Layer } from "effect"
import {
  Infer,
  inferWith,
  vercelGatewayInference,
  type AgentMessage,
  type ModelRequest
} from "@flamecast/harness"
import { knownOrders } from "./invoices"

const INPUT_USD_PER_TOKEN = 5 / 1_000_000
const OUTPUT_USD_PER_TOKEN = 25 / 1_000_000

const usageOf = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  costUsd:
    promptTokens * INPUT_USD_PER_TOKEN + completionTokens * OUTPUT_USD_PER_TOKEN
})

const orderIn = (text: string): string | undefined =>
  knownOrders.find((order) => text.includes(order))

const currentQuestion = (messages: ReadonlyArray<AgentMessage>): string =>
  messages.findLast((message) => message.role === "user")?.content ?? ""

const lastToolResult = (messages: ReadonlyArray<AgentMessage>): string | undefined =>
  messages.findLast((message) => message.role === "tool")?.content ?? undefined

const answerFrom = (result: string): string => {
  const parsed = JSON.parse(result) as {
    readonly invoice?: string
    readonly total?: string
    readonly status?: string
    readonly error?: string
  }
  if (parsed.error !== undefined) return `I could not find that invoice: ${parsed.error}`
  return `Invoice ${String(parsed.invoice)} totals ${String(parsed.total)} and is ${String(parsed.status)}.`
}

const estimated = (request: ModelRequest, completionTokens: number) =>
  usageOf(Math.ceil(JSON.stringify(request).length / 4), completionTokens)

export const stubModel = inferWith(async (request) => {
  const result = lastToolResult(request.messages)
  if (result !== undefined) {
    return { kind: "complete", output: answerFrom(result), usage: estimated(request, 24) }
  }

  const question = currentQuestion(request.messages)
  const order = orderIn(question)
  const offered = request.tools.some((tool) => tool.name === "lookup_invoice")
  if (order === undefined || !offered) {
    return {
      kind: "complete",
      output: `Tell me the order id and I will look up the invoice. I know ${knownOrders.join(", ")}.`,
      usage: estimated(request, 20)
    }
  }

  const served = request.messages.filter((message) => message.role === "tool").length
  return {
    kind: "call",
    callId: `c-${served + 1}`,
    name: "lookup_invoice",
    arguments: { orderId: order },
    text: `Looking up order ${order}.`,
    usage: estimated(request, 32)
  }
})

export interface Binding {
  readonly label: string
  readonly layer: Layer.Layer<Infer>
}

export const modelBinding = (): Binding => {
  const apiKey = process.env["AI_GATEWAY_API_KEY"]
  if (apiKey === undefined || apiKey === "") {
    return { label: "stub (offline, no key needed)", layer: stubModel }
  }
  const configured = process.env["AI_GATEWAY_MODEL"]
  const provider = vercelGatewayInference({
    apiKey,
    ...(configured === undefined || configured === "" ? {} : { model: configured })
  })
  return {
    label: `vercel ai gateway ${provider.state([]).model}`,
    layer: Layer.succeed(Infer, provider)
  }
}
