import type { Event } from "@clavia/tardigrade-core/log/event"
import { terminalReportOutcomeOf } from "@clavia/tardigrade-core/communication/message"
import { checkpointOf, keepFromIndex, resolvedContextPolicyOf, type ContextPolicy } from "../components/compaction"
import {
  correctionText,
  declaredOutputOf,
  modeOf,
  projectedOutput,
  type OutputContract,
  type OutputFallback
} from "../output/contract"

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

// OutputRequest is the turn's declared final response: the contract, and the implementation that
// must obtain it. It rides the request as itself rather than as a tool, so a binding maps it onto
// the provider's own response-format surface (platform/model/src/output/contract.ts, outputSchemaFor).
//
// `invalid` is the turn that declared an output no contract can be built from. It is on the
// request rather than absent from it, because a request with no output reads as a turn that
// wanted prose, and this one wanted something nobody can serve (output.ts, DeclaredOutput).
export type OutputRequest =
  | {
      readonly kind: "contract"
      readonly contract: OutputContract
      // What the turn does when native structured output is unavailable for this call, and the
      // prompt that fallback needs. Absent means the assembly selected native output, so a call
      // the provider cannot serve fails before it spends. The binding decides which strategy the
      // attempt runs as, and the fallback's prompt reaches the model only then
      // (platform/model/src/output/contract.ts, outputModeOf).
      readonly fallback?: OutputFallback
      readonly fallbackSystem?: string
    }
  | {
      readonly kind: "invalid"
      readonly errors: ReadonlyArray<string>
      readonly fallback?: OutputFallback
    }

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolSpec>
  // Present when the turn declared a contract. Absent turns end in prose.
  readonly output?: OutputRequest
}

// SYSTEM frames the turn around whatever surface is in play: the surface states how the model
// acts, and the frame states how a turn ends. The two are separate so a surface swap rewrites
// only its own half. The frame says nothing about the shape of the answer: a turn that declares
// an output contract gets that shape from the provider's own response format, and a framework
// sentence about it would be one more instruction to disagree with the schema
// (request.test.ts, "the frame never mentions the contract, declared or not").
const SYSTEM = (surface: string): string =>
  `You are an agent. ${surface}\nWhen the work is done, reply directly: that reply is your final answer and ends the turn. Reply without calling a tool when no action is needed.`

// feedbackFor is what the model reads back after a rejection, and undefined when nobody has
// decided to ask again yet. The framework repair loop's own text is written here because that
// loop is the reactor's; every other implementation supplies its own through
// `OutputRetryRequested`.
const feedbackFor = (
  rejection: Record<string, unknown>,
  decided: ReadonlyMap<string, string>
): string | undefined => {
  const decision = decided.get(String(rejection["attempt"]))
  if (decision !== undefined) return decision
  const mode = modeOf(rejection["mode"])
  if (mode?.kind !== "repair") return undefined
  return correctionText((rejection["errors"] ?? []) as ReadonlyArray<string>)
}

// A truncation names the cap it cut at as well as the size it cut from: the model reads why the
// text stops, and a consumer who moved the cap sees the new number in the request itself
// (request.test.ts, "the truncation caps are the consumer's").
const userMessageOf = (e: Event, policy: ContextPolicy): AgentMessage => {
  const v = e as Record<string, unknown>
  const text = String(v.text ?? "")
  const rendered =
    text.length > policy.messageRenderCap
      ? `${text.slice(0, policy.messageRenderCap)}…[truncated at ${policy.messageRenderCap} of ${text.length} chars; read the full message with logs.events on this facet, id ${String(v.id)}]`
      : text
  const report = terminalReportOutcomeOf(v)
  return {
    role: "user",
    content: report === undefined
      ? rendered
      : `[Terminal report: ${report}. Your answer to this report stays in this thread and is not sent back to its sender.]\n${rendered}`
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
// A repair exchange renders as the reply the model gave and the feedback it was given back. The
// feedback belongs to whoever decided to ask again: the framework loop writes `correctionText`,
// and a delegated implementation writes its own on `OutputRetryRequested`, so the core never speaks for
// a component (output.ts, OutputFallback; request.test.ts, "a delegated implementation
// writes its own feedback"). A rejection nobody has answered renders alone.
//
// The projection runs first, so a corrected exchange whose recorded policy projects history is
// gone before anything here reads the trajectory (output.ts, projectedOutput).
export const renderMessages = (
  trajectory: ReadonlyArray<Event>,
  policy: Partial<ContextPolicy> = {}
): ReadonlyArray<AgentMessage> => {
  const resolved = resolvedContextPolicyOf(policy)
  const messages: AgentMessage[] = []
  const projected = projectedOutput(trajectory)
  const checkpoint = checkpointOf(projected)
  const from = keepFromIndex(projected, checkpoint.keepFrom)
  const terminated = new Set(
    projected
      .filter((e) => e.type === "TurnCompleted" || e.type === "TurnFailed" || e.type === "TurnCancelled")
      .map((e) => String((e as { turn?: unknown }).turn))
  )
  const decided = new Map(
    projected
      .filter((e) => e.type === "OutputRetryRequested")
      .map((e) => [String((e as { rejection?: unknown }).rejection), String((e as { feedback?: unknown }).feedback)])
  )
  const openHead = projected.findIndex(
    (e) => e.type === "MessageReceived" && !terminated.has(String((e as { id?: unknown }).id))
  )
  if (openHead !== -1 && openHead < from) messages.push(userMessageOf(projected[openHead]!, resolved))
  if (checkpoint.summary !== "") messages.push({ role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` })
  let pendingText: string | null = null
  for (const e of projected.slice(from)) {
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
        messages.push({ role: "assistant", content: String(v.text ?? "") })
        const feedback = feedbackFor(v, decided)
        if (feedback !== undefined) messages.push({ role: "user", content: feedback })
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
      case "TurnCancelled": {
        const reason = String(v.reason ?? "")
        messages.push({ role: "assistant", content: reason === "" ? "the turn was cancelled" : `the turn was cancelled: ${reason}` })
        break
      }
      default:
        break
    }
  }
  return messages
}

// modelRequest folds output and context policy over the component-derived surface. A declared output
// contract adds no tool, tool choice, or prompt sentence because the binding uses the provider's format
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
    readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
  },
  context: Partial<ContextPolicy> = {}
): ModelRequest => {
  const declared = declaredOutputOf(trajectory)
  const fallback = render.output
  const base = SYSTEM(render.system)
  return {
    system: base,
    messages: renderMessages(trajectory, context),
    tools: render.tools,
    ...(declared.kind === "none"
      ? {}
      : {
          output:
            declared.kind === "contract"
              ? ({
                  kind: "contract",
                  contract: declared.contract,
                  ...(fallback === undefined ? {} : { fallback: fallback.fallback }),
                  ...(fallback?.system === undefined ? {} : { fallbackSystem: fallback.system })
                } as const)
              : ({
                  kind: "invalid",
                  errors: declared.errors,
                  ...(fallback === undefined ? {} : { fallback: fallback.fallback })
                } as const)
        })
  }
}
