import type { Event } from "@clavia/tardigrade-core/event"
import { checkpointOf, contextPolicyOf, keepFromIndex, type ContextPolicy } from "./components/compaction"
import { contractOf, correctionText, NATIVE_OUTPUT, type OutputContract, type OutputImplementation } from "./output"
import { budgetSpent, canRequestBudget } from "./components/budget"

// The model request, decided from the trajectory: system prompt, tool surface, message
// projection. Domain policy lives with the agent; the platform maps these provider-agnostic
// types to one provider's wire, so prompting is testable without a provider and one policy
// serves every provider.

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

export interface AgentToolCall {
  readonly id: string
  readonly name: string // the real tool name; the platform sanitizes for its wire alphabet
  readonly arguments: string // JSON string
}

export interface AgentMessage {
  readonly role: "user" | "assistant" | "tool"
  readonly content: string | null
  readonly toolCalls?: ReadonlyArray<AgentToolCall>
  readonly toolCallId?: string
}

// OutputRequest is the turn's declared final response: the contract, and the implementation
// that must obtain it. It rides the request as itself rather than as a tool, so a binding maps
// it onto the provider's own response-format surface (platform/model/src/output.ts,
// outputSchemaFor).
export interface OutputRequest {
  readonly contract: OutputContract
  readonly implementation: OutputImplementation
}

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolSpec>
  // Present when the turn declared a contract. Absent turns end in prose.
  readonly output?: OutputRequest
}

// REQUEST_BUDGET_TOOL is offered only at the wall, and only when the brief made the turn
// escalatable. The model calls it to ask its parent for more tool calls instead of answering.
// The call parks the turn until the parent grants or denies; a grant reopens the work tools.
const REQUEST_BUDGET_TOOL: ToolSpec = {
  name: "request_budget",
  description:
    "Ask for more tool-call budget when the work is not done and the budget is spent. State why the extra spend is worth it and how many more calls you need. The parent decides; a grant lets you keep working, a denial means finish with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why more budget is worth it: what is still missing and what you will do with the calls." },
      amount: { type: "number", description: "How many more tool calls you need." }
    },
    required: ["reason", "amount"],
    additionalProperties: false
  }
}

// SYSTEM frames the turn around whatever surface is in play: the surface states how the model
// acts, and the frame states how a turn ends. The two are separate so a surface swap rewrites
// only its own half. The frame says nothing about the shape of the answer: a turn that declares
// an output contract gets that shape from the provider's own response format, and a framework
// sentence about it would be one more instruction to disagree with the schema
// (request.test.ts, "the frame never mentions the contract, declared or not").
const SYSTEM = (surface: string): string =>
  `You are an agent. ${surface}\nWhen the work is done, reply directly: that reply is your final answer and ends the turn. Reply without calling a tool when no action is needed.`

const BUDGET_NUDGE =
  "Your tool budget for this turn is spent, so the work tools are gone. Finish now: answer with your best result from what you have already gathered."

const ESCALATE_NUDGE =
  "If the work genuinely needs more and the extra spend is worth it, you may call request_budget with a reason and an amount instead of answering. Ask only when it changes the result; otherwise answer now."

// A truncation names the cap it cut at as well as the size it cut from: the model reads why the
// text stops, and a consumer who moved the cap sees the new number in the request itself
// (request.test.ts, "the truncation caps are the consumer's").
const userMessageOf = (e: Event, policy: ContextPolicy): AgentMessage => {
  const v = e as Record<string, unknown>
  const text = String(v.text ?? "")
  return {
    role: "user",
    content:
      text.length > policy.messageRenderCap
        ? `${text.slice(0, policy.messageRenderCap)}…[truncated at ${policy.messageRenderCap} of ${text.length} chars; read the full message with logs.events on this facet, id ${String(v.id)}]`
        : text
  }
}

// renderMessages rebuilds the trajectory as a conversation: reactions as assistant messages,
// tool returns as tool messages, terminals as assistant text. Rendering starts from the last
// checkpoint's summary plus the kept suffix, resolved by the checkpoint's identity so the same
// event anchors the render and the reactor whatever the projection reordered
// (request.test.ts, "a checkpoint survives the projection"). The open turn's head renders
// verbatim ahead of the summary when the checkpoint passed it: the live task never shrinks to a
// summary paragraph mid-turn. Unknown event types fall through: tolerant reads.
//
// `policy` sets the truncation caps. It must be the policy the compaction reactor took, or the
// guard fires against a size this render never sends (compaction.ts, ContextPolicy).
//
// `output` is the turn's output implementation, and decides one thing here: whether a corrected
// exchange still renders. Under `projectHistory` a rejection whose turn went on to complete is
// dropped, so later inference reads the corrected value as the answer the model gave, while the
// rejection and its reasons stay in the log for the operator (request.test.ts, "a corrected
// exchange compacts out of the render, and stays in the log"). A rejection in an unfinished or
// failed turn always renders: it is what the model must read to correct, or what explains the
// failure.
export const renderMessages = (
  trajectory: ReadonlyArray<Event>,
  policy: Partial<ContextPolicy> = {},
  output: OutputImplementation = NATIVE_OUTPUT
): ReadonlyArray<AgentMessage> => {
  const resolved = contextPolicyOf(policy)
  const messages: AgentMessage[] = []
  const checkpoint = checkpointOf(trajectory)
  const from = keepFromIndex(trajectory, checkpoint.keepFrom)
  const terminated = new Set(
    trajectory
      .filter((e) => e.type === "TurnCompleted" || e.type === "TurnFailed")
      .map((e) => String((e as { turn?: unknown }).turn))
  )
  const corrected = new Set(
    trajectory.filter((e) => e.type === "TurnCompleted").map((e) => String((e as { turn?: unknown }).turn))
  )
  const openHead = trajectory.findIndex(
    (e) => e.type === "MessageReceived" && !terminated.has(String((e as { id?: unknown }).id))
  )
  if (openHead !== -1 && openHead < from) messages.push(userMessageOf(trajectory[openHead]!, resolved))
  if (checkpoint.summary !== "") messages.push({ role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` })
  let pendingText: string | null = null
  for (const e of trajectory.slice(from)) {
    const v = e as Record<string, unknown>
    switch (e.type) {
      case "MessageReceived": {
        messages.push(userMessageOf(e, resolved))
        break
      }
      case "TextReturned": {
        pendingText = String(v.text ?? "")
        break
      }
      case "ToolCalled": {
        messages.push({
          role: "assistant",
          content: pendingText,
          toolCalls: [{ id: String(v.callId), name: String(v.name), arguments: JSON.stringify(v.arguments ?? {}) }]
        })
        pendingText = null
        break
      }
      case "ToolReturned": {
        const body = JSON.stringify(v.result ?? null)
        messages.push({
          role: "tool",
          toolCallId: String(v.callId),
          content:
            body.length > resolved.resultRenderCap
              ? `${body.slice(0, resolved.resultRenderCap)}…[truncated at ${resolved.resultRenderCap} of ${body.length} chars]`
              : body
        })
        break
      }
      case "OutputRejected": {
        if (output.projectHistory === true && corrected.has(String(v.turn))) break
        messages.push({ role: "assistant", content: String(v.text ?? "") })
        messages.push({ role: "user", content: correctionText((v.errors ?? []) as ReadonlyArray<string>) })
        break
      }
      case "TurnCompleted": {
        messages.push({ role: "assistant", content: String(v.output ?? "") })
        break
      }
      case "TurnFailed": {
        messages.push({ role: "assistant", content: `the turn failed: ${String(v.error ?? "")}` })
        break
      }
      default:
        break
    }
  }
  return messages
}

// modelRequest folds the turn's policies over the surface's tool table. A spent budget drops the
// work tools and adds the budget nudge, so the model can only answer. A declared output contract
// rides the request as itself: it adds no tool, no tool choice, and no sentence to the prompt,
// because the binding sends it on the provider's own response-format surface
// (request.test.ts, "a contract is never a tool, a tool choice, or a sentence in the prompt").
//
// `context` sets what the render truncates. It rides the same rule the surface does: the actor's
// compaction reactor must hold the same policy, so the caller that states one here states it
// there too (compaction.ts, ContextPolicy).
export const modelRequest = (
  trajectory: ReadonlyArray<Event>,
  render: {
    readonly system: string
    readonly tools: ReadonlyArray<ToolSpec>
    readonly output?: OutputImplementation
  },
  context: Partial<ContextPolicy> = {}
): ModelRequest => {
  const contract = contractOf(trajectory)
  const implementation = render.output ?? NATIVE_OUTPUT
  const spent = budgetSpent(trajectory)
  const canRequest = canRequestBudget(trajectory)
  const work = spent ? [] : render.tools
  const tools = canRequest ? [...work, REQUEST_BUDGET_TOOL] : work
  const base = SYSTEM(render.system)
  const budgetLine = canRequest ? `${BUDGET_NUDGE}\n${ESCALATE_NUDGE}` : BUDGET_NUDGE
  return {
    system: spent ? `${base}\n${budgetLine}` : base,
    messages: renderMessages(trajectory, context, implementation),
    tools,
    ...(contract === undefined ? {} : { output: { contract, implementation } })
  }
}
