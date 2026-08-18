import type { Envelope } from "@flamecast/core/envelope"
import { checkpointOf } from "./compaction"
import { outputSchemaOf } from "./contract"
import { budgetSpent, canRequestBudget } from "./budget"

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

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolSpec>
}

// EXECUTE_TOOL is the one work tool: the model acts by writing JavaScript against the packages
// in scope.
const EXECUTE_TOOL: ToolSpec = {
  name: "execute",
  description:
    "Run JavaScript against the connected packages. Packages are objects in scope; await their methods and end with `return <value>`. The returned value comes back as this call's result, and console output comes back beside it as `logs` (capped; return the value you need, print to inspect).",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "The JavaScript body to run." } },
    required: ["code"],
    additionalProperties: false
  }
}

// answerTool renders the turn's declared output schema as a tool. Calling it ends the turn, and
// its arguments are the structured answer, parsed JSON by construction.
const answerTool = (schema: unknown): ToolSpec => ({
  name: "answer",
  description: "Deliver the final answer for this turn. The arguments ARE the answer.",
  inputSchema: schema
})

// REQUEST_BUDGET_TOOL is offered only at the wall, and only when the brief made the turn
// escalatable. The model calls it to ask its parent for more tool calls instead of answering.
// The call parks the turn until the parent grants or denies; a grant reopens `execute`.
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

const SYSTEM = (packages: string): string =>
  `You are an agent. You act on the world by calling the execute tool with JavaScript; the packages in scope are:\n${packages}\nWhen the work is done, reply in plain text: that reply is your final answer and ends the turn. Reply plainly without calling execute when no action is needed.`

const ANSWER_NUDGE =
  "This turn declares an output schema. Finish by calling the answer tool: its arguments are your final answer and MUST conform to its schema. Never answer in prose."

const BUDGET_NUDGE =
  "Your tool budget for this turn is spent, so the execute tool is gone. Finish now: answer with your best result from what you have already gathered."

const ESCALATE_NUDGE =
  "If the work genuinely needs more and the extra spend is worth it, you may call request_budget with a reason and an amount instead of answering. Ask only when it changes the result; otherwise answer now."

// renderMessages rebuilds the trajectory as a conversation: reactions as assistant messages,
// tool returns as tool messages, terminals as assistant text. Rendering starts from the last
// checkpoint's summary plus the live suffix. Unknown event types fall through: tolerant reads.
export const renderMessages = (trajectory: ReadonlyArray<Envelope>): ReadonlyArray<AgentMessage> => {
  const messages: AgentMessage[] = []
  const checkpoint = checkpointOf(trajectory)
  if (checkpoint.summary !== "") messages.push({ role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` })
  let pendingText: string | null = null
  for (const e of trajectory.slice(checkpoint.upTo)) {
    const v = e as Record<string, unknown>
    switch (e.type) {
      case "MessageReceived": {
        const text = String(v.text ?? "")
        messages.push({
          role: "user",
          content:
            text.length > 12000
              ? `${text.slice(0, 12000)}…[truncated ${text.length} chars; read the full message with logs.events on this facet, id ${String(v.id)}]`
              : text
        })
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
          content: body.length > 6000 ? `${body.slice(0, 6000)}…[truncated ${body.length} chars]` : body
        })
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

// modelRequest folds two policies. A declared output schema adds the answer tool and its
// nudge. A spent budget drops execute and adds the budget nudge, so the model can only answer.
// Both are pure projections of the log.
export const modelRequest = (trajectory: ReadonlyArray<Envelope>, packagesInScope: string): ModelRequest => {
  const schema = outputSchemaOf(trajectory)
  const spent = budgetSpent(trajectory)
  const canRequest = canRequestBudget(trajectory)
  const work = spent ? [] : [EXECUTE_TOOL]
  const withAnswer = schema === undefined ? work : [...work, answerTool(schema)]
  const tools = canRequest ? [...withAnswer, REQUEST_BUDGET_TOOL] : withAnswer
  const base = schema === undefined ? SYSTEM(packagesInScope) : `${SYSTEM(packagesInScope)}\n${ANSWER_NUDGE}`
  const budgetLine = canRequest ? `${BUDGET_NUDGE}\n${ESCALATE_NUDGE}` : BUDGET_NUDGE
  return { system: spent ? `${base}\n${budgetLine}` : base, messages: renderMessages(trajectory), tools }
}
