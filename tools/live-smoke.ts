// What the gate can not check: that the state a provider preserves actually reaches the model.
//
// A gateway answers a request that lost its provider state with the same 200 as one that kept it.
// Google's own API refuses such a request, and the gateway hides the refusal by substituting the
// sentinel that turns the validation off, so nothing in the reply says what was lost. The evidence
// is upstream, in the prompt tokens the provider counted: state that arrived was read, and state
// that never arrived was not.
//
// This costs money and calls live models, so it runs from a command rather than from the gate.
//
//   AI_GATEWAY_API_KEY=... bun run smoke:live
//
// Each model runs one tool-calling turn twice, once replaying everything the provider returned and
// once replaying only what a harness would rebuild from an event log. A model whose preserved run
// reads more than its stripped run is carrying its reasoning across the tool call.

const KEY = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AIG_KEY
if (KEY === undefined || KEY === "") {
  console.error("live-smoke needs AI_GATEWAY_API_KEY. Nothing ran, and nothing was spent.")
  process.exit(2)
}

const BASE = process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1"

// The tool exists to split the turn in two. What the model does with the result is the measurement.
const TOOL = {
  name: "lookup_invoice",
  description: "Look up one invoice by its id.",
  parameters: {
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
  readonly surface: string
  readonly preserved: number | undefined
  readonly stripped: number | undefined
  readonly status: string
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asRecords = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) ? value.flatMap((item) => (asRecord(item) === undefined ? [] : [asRecord(item)!])) : []

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: response.status, body: { raw: text.slice(0, 200) } as Record<string, unknown> }
  }
}

// What the provider says it read. The gateway's own prompt count is normalized and rounds the
// difference away, so the provider's figure is the one that answers the question.
const promptTokensOf = (body: Record<string, unknown>, message: Record<string, unknown> | undefined) => {
  const metadata = asRecord(message?.provider_metadata)
  for (const name of ["vertex", "google", "anthropic", "openai", "bedrock"]) {
    const usage = asRecord(asRecord(metadata?.[name])?.usageMetadata)
    if (typeof usage?.promptTokenCount === "number") return usage.promptTokenCount
    const native = asRecord(asRecord(metadata?.[name])?.usage)
    if (typeof native?.input_tokens === "number") return native.input_tokens
  }
  const usage = asRecord(body.usage)
  return typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined
}

const chatCompletions = async (model: string): Promise<Reading> => {
  const base = {
    model,
    tools: [{ type: "function", function: TOOL }],
    parallel_tool_calls: false,
    reasoning: { effort: "high" }
  }
  const first = await post("/chat/completions", {
    ...base,
    messages: [{ role: "user", content: QUESTION }]
  })
  const answer = asRecord(asRecords(first.body.choices)[0]?.message)
  const call = asRecords(answer?.tool_calls)[0]
  if (first.status !== 200 || answer === undefined || call === undefined) {
    return {
      model,
      surface: "chat-completions",
      preserved: undefined,
      stripped: undefined,
      status: first.status === 200 ? "no tool call, so nothing to carry" : `HTTP ${first.status}`
    }
  }
  const result = { role: "tool", tool_call_id: String(call.id), content: '{"total":"4182.00"}' }
  const second = async (assistant: unknown) =>
    await post("/chat/completions", {
      ...base,
      messages: [{ role: "user", content: QUESTION }, assistant, result]
    })

  // Everything the provider returned, minus the routing metadata that describes the call after it.
  const kept = { ...answer }
  delete kept.provider_metadata
  delete kept.providerMetadata
  const preserved = await second(kept)
  // What a harness that rebuilds the conversation from its own records would send.
  const stripped = await second({
    role: "assistant",
    content: answer.content ?? null,
    tool_calls: [{ id: call.id, type: "function", function: call.function }]
  })
  return {
    model,
    surface: "chat-completions",
    preserved: promptTokensOf(preserved.body, asRecord(asRecords(preserved.body.choices)[0]?.message)),
    stripped: promptTokensOf(stripped.body, asRecord(asRecords(stripped.body.choices)[0]?.message)),
    status: preserved.status === 200 && stripped.status === 200 ? "ok" : "a turn was refused"
  }
}

const messages = async (model: string, thinking?: Record<string, unknown>): Promise<Reading> => {
  const base = {
    model,
    max_tokens: 8192,
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    // This command pins a route, which is a choice a deployment makes rather than one the framework
    // makes for it. It is pinned here so the reading measures what the state does and not where the
    // gateway happened to send the request.
    providerOptions: { gateway: { only: ["anthropic", "vertex"] } },
    ...thinking
  }
  const headers = { "anthropic-version": "2023-06-01" }
  const first = await post("/messages", {
    ...base,
    messages: [{ role: "user", content: QUESTION }]
  }, headers)
  const content = asRecords(first.body.content)
  const use = content.find((block) => block.type === "tool_use")
  if (first.status !== 200 || use === undefined) {
    return {
      model,
      surface: "messages",
      preserved: undefined,
      stripped: undefined,
      status: first.status === 200 ? "no tool call, so nothing to carry" : `HTTP ${first.status}`
    }
  }
  const second = async (assistant: ReadonlyArray<Record<string, unknown>>) =>
    await post("/messages", {
      ...base,
      messages: [
        { role: "user", content: QUESTION },
        { role: "assistant", content: assistant },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: String(use.id), content: '{"total":"4182.00"}' }
          ]
        }
      ]
    }, headers)

  const preserved = await second(content)
  const stripped = await second(
    content.filter((block) => block.type === "text" || block.type === "tool_use")
  )
  const inputTokens = (body: Record<string, unknown>) => {
    const usage = asRecord(body.usage)
    return typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined
  }
  return {
    model,
    surface: "messages",
    preserved: inputTokens(preserved.body),
    stripped: inputTokens(stripped.body),
    status: preserved.status === 200 && stripped.status === 200 ? "ok" : "a turn was refused"
  }
}

const MODELS: ReadonlyArray<readonly [string, () => Promise<Reading>]> = [
  ["google/gemini-3.1-pro-preview", () => chatCompletions("google/gemini-3.1-pro-preview")],
  ["openai/gpt-5.6-sol", () => chatCompletions("openai/gpt-5.6-sol")],
  ["deepseek/deepseek-v4-pro", () => chatCompletions("deepseek/deepseek-v4-pro")],
  // Anthropic models are asked on their own surface, which is the one that carries their thinking.
  // The Claude 5 generation thinks whether or not it is asked to, so it is measured as it ships.
  ["anthropic/claude-opus-5", () => messages("anthropic/claude-opus-5")],
  // A model from before adaptive thinking thinks only when asked, and a model that never thought
  // has no state to carry, which would read as a lost round trip rather than an idle one.
  [
    "anthropic/claude-sonnet-4.6",
    () =>
      messages("anthropic/claude-sonnet-4.6", {
        thinking: { type: "enabled", budget_tokens: 2048 }
      })
  ]
]

const readings: Array<Reading> = []
for (const [model, run] of MODELS) {
  try {
    readings.push(await run())
  } catch (error) {
    readings.push({
      model,
      surface: "unknown",
      preserved: undefined,
      stripped: undefined,
      status: error instanceof Error ? error.message : String(error)
    })
  }
}

console.log("\nprompt tokens the provider counted on the turn after the tool call\n")
for (const reading of readings) {
  const carried =
    reading.preserved !== undefined &&
    reading.stripped !== undefined &&
    reading.preserved > reading.stripped
  const detail =
    reading.preserved === undefined || reading.stripped === undefined
      ? reading.status
      : `preserved ${reading.preserved}, stripped ${reading.stripped}`
  console.log(`  ${carried ? "CARRIED " : "FLAT    "} ${reading.model.padEnd(32)} ${detail}`)
}

// A model that reads the same either way is telling us the state never reached it. That is worth a
// failing exit, because it is the condition this command exists to notice.
const carried = readings.filter(
  (reading) =>
    reading.preserved !== undefined &&
    reading.stripped !== undefined &&
    reading.preserved > reading.stripped
)
console.log(
  `\n${carried.length} of ${readings.length} models read more when their state was preserved.`
)
if (carried.length === 0) {
  console.error("No model carried its state. The round trip is not reaching any provider.")
  process.exit(1)
}

// This command imports nothing, and a file that neither imports nor exports is a script rather than
// a module. The awaits above are only legal in a module, so it says it is one.
export {}
