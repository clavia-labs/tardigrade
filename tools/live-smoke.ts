import { Effect } from "effect"
import type { AgentMessage, ModelRequest, NativeToolSpec } from "../packages/harness/src/infer"
import { vercelGatewayInference } from "../packages/harness/src/providers/vercel-gateway"

// What the gate can not check: that the state a provider preserves actually reaches the model.
//
// A gateway answers a request that lost its provider state with the same success as one that kept
// it. Google's own API refuses such a request, and the gateway hides the refusal by substituting the
// sentinel that turns the validation off, so nothing in the reply says what was lost. The evidence
// is upstream, in the prompt tokens the provider counted: state that arrived was read, and state
// that never arrived was not.
//
// This runs the framework's own path rather than a wire format beside it, so what it measures is
// what an agent sends. Every model reaches the gateway through one adapter, so one reading per model
// covers every family.
//
// This costs money and calls live models, so it runs from a command rather than from the gate.
//
//   AI_GATEWAY_API_KEY=... bun run smoke:live

const KEY = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AIG_KEY
if (KEY === undefined || KEY === "") {
  console.error("live-smoke needs AI_GATEWAY_API_KEY. Nothing ran, and nothing was spent.")
  process.exit(2)
}

// The tool exists to split the turn in two. What the model does with the result is the measurement.
const TOOL: NativeToolSpec = {
  name: "lookup_invoice",
  description: "Look up one invoice by its id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"]
  }
}

// The identifier has to be worked out before the call, so the turn that calls the tool is also a
// turn that thinks, and there is state for the next request to carry.
const QUESTION =
  "The invoice id is 'INV-' followed by the product of the 3rd and 6th prime numbers. " +
  "Work out the id, look it up with the tool, then state the total and how you derived the id."

interface Reading {
  readonly model: string
  readonly preserved: number | undefined
  readonly stripped: number | undefined
  readonly status: string
}

const read = async (model: string): Promise<Reading> => {
  const provider = await Effect.runPromise(
    vercelGatewayInference({ model, apiKey: KEY, retries: 0, reasoning: "high" })
  )
  const ask = (messages: ReadonlyArray<AgentMessage>): ModelRequest => ({
    system: "",
    messages,
    tools: [TOOL]
  })
  const question: AgentMessage = { role: "user", content: QUESTION }
  const first = await Effect.runPromise(provider.react(ask([question]), "live/0"))
  if (first.kind !== "call") {
    return {
      model,
      preserved: undefined,
      stripped: undefined,
      status: first.kind === "fail" ? first.error.slice(0, 90) : "no tool call, so nothing to carry"
    }
  }
  const call = { id: first.callId, name: first.name, arguments: JSON.stringify(first.arguments) }
  const result: AgentMessage = {
    role: "tool",
    toolCallId: first.callId,
    toolName: first.name,
    content: '{"total":"4182.00"}'
  }
  // What the framework sends: the assistant turn with the state the provider returned.
  const preserved = await Effect.runPromise(
    provider.react(
      ask([
        question,
        {
          role: "assistant",
          content: first.text ?? "",
          toolCalls: [call],
          ...(first.continuation === undefined ? {} : { continuation: first.continuation })
        },
        result
      ]),
      "live/1"
    )
  )
  // What a harness that rebuilt the conversation from its own records alone would send.
  const stripped = await Effect.runPromise(
    provider.react(
      ask([
        question,
        { role: "assistant", content: first.text ?? "", toolCalls: [call] },
        result
      ]),
      "live/2"
    )
  )
  const tokens = (action: typeof preserved) => action.usage?.promptTokens
  return {
    model,
    preserved: tokens(preserved),
    stripped: tokens(stripped),
    status: preserved.kind === "fail" || stripped.kind === "fail" ? "a turn was refused" : "ok"
  }
}

// One list, because one adapter serves every family. A model that returns no thinking has nothing to
// carry, so the question is hard enough to spend reasoning tokens on every one of these.
const MODELS = [
  "google/gemini-3.1-pro-preview",
  "openai/gpt-5.6-sol",
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4.6"
]

const readings: Array<Reading> = []
for (const model of MODELS) {
  try {
    readings.push(await read(model))
  } catch (error) {
    readings.push({
      model,
      preserved: undefined,
      stripped: undefined,
      status: error instanceof Error ? error.message.slice(0, 90) : String(error)
    })
  }
}

console.log("\nprompt tokens the provider counted on the turn after the tool call\n")
const carries = (reading: Reading) =>
  reading.preserved !== undefined &&
  reading.stripped !== undefined &&
  reading.preserved > reading.stripped
for (const reading of readings) {
  const detail =
    reading.preserved === undefined || reading.stripped === undefined
      ? reading.status
      : `preserved ${reading.preserved}, stripped ${reading.stripped}`
  console.log(`  ${carries(reading) ? "CARRIED " : "FLAT    "} ${reading.model.padEnd(32)} ${detail}`)
}

// A model that reads the same either way is telling us the state never reached it. That is worth a
// failing exit, because it is the condition this command exists to notice.
const carried = readings.filter(carries)
console.log(
  `\n${carried.length} of ${readings.length} models read more when their state was preserved.`
)
if (carried.length === 0) {
  console.error("No model carried its state. The round trip is not reaching any provider.")
  process.exit(1)
}
