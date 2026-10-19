import { Schema } from "effect"
import { RuntimeError, durableAtom } from "@clavia/tardigrade-core"
import { Trajectory, CompactionFailed, type Conversation } from "../../contracts/events"
import { CompactionState, compactState, initialCompaction } from "./compaction"
import { TrajectoryState, TrajectoryEvent, trajectoryChange, findTrajectoryTool } from "./trajectory"

type Message = typeof Conversation.Type[number]

export const DEFAULT_COMPACTION_POLICY = {
  triggerRatio: 0.8, retainRatio: 0.5, charsPerToken: 4,
  toolOutputTokenLimit: 10_000, userMessageTokenLimit: 262_144,
  imageTokenEstimate: 1_200,
} as const

const TRUNCATION_MARKER = "\n[truncated]\n"

export interface CompactionOptions {
  readonly triggerRatio?: number
  readonly retainRatio?: number
  readonly charsPerToken?: number
  // imageTokenEstimate adds estimated tokens per image in user and tool content.
  readonly imageTokenEstimate?: number
  // toolOutputTokenLimit bounds rendered tool text using charsPerToken, including the truncation marker.
  readonly toolOutputTokenLimit?: number
  // userMessageTokenLimit bounds rendered user text using charsPerToken, including the truncation marker.
  readonly userMessageTokenLimit?: number
}

export function compactionRendering(options: CompactionOptions) {
  const policy = { ...DEFAULT_COMPACTION_POLICY, ...options }
  if (!Number.isSafeInteger(policy.imageTokenEstimate) || policy.imageTokenEstimate < 0) {
    throw new RuntimeError("Compaction imageTokenEstimate must be a non-negative safe integer")
  }
  if (!Number.isFinite(policy.charsPerToken) || policy.charsPerToken <= 0
    || !(policy.retainRatio > 0 && policy.retainRatio < policy.triggerRatio && policy.triggerRatio < 1)) {
    throw new RuntimeError("Compaction requires positive charsPerToken, and 0 < retainRatio < triggerRatio < 1")
  }
  const charLimit = (tokens: number) => {
    const chars = Math.floor(tokens * policy.charsPerToken)
    if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(chars) || chars < TRUNCATION_MARKER.length) {
      throw new RuntimeError(`Compaction token limits must be positive safe integers and allow at least ${TRUNCATION_MARKER.length} characters for a truncation marker`)
    }
    return chars
  }
  const toolCharLimit = charLimit(policy.toolOutputTokenLimit)
  const userCharLimit = charLimit(policy.userMessageTokenLimit)
  const clip = (text: string, limit: number) => {
    if (text.length <= limit) return text
    const retained = limit - TRUNCATION_MARKER.length
    const head = Math.ceil(retained / 2)
    const tail = retained - head
    const prefix = text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "")
    const suffix = tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, "") : ""
    return prefix + TRUNCATION_MARKER + suffix
  }
  const render = (messages: typeof Conversation.Type): typeof Conversation.Type => messages.map(message => {
    if (message.role === "assistant") return message
    if ("content" in message && message.content !== undefined) {
      const limit = message.role === "tool" ? toolCharLimit : userCharLimit
      const content = message.content.map(part => {
        if (part.type !== "text") return part
        const text = clip(part.text, limit)
        return text === part.text ? part : { ...part, text }
      })
      if (content.every((part, index) => part === message.content![index])) return message
      return message.role === "tool" ? { ...message, content, text: content.filter(part => part.type === "text").map(part => part.text).join("\n") } : { ...message, content }
    }
    if (!("text" in message)) return message
    const text = clip(message.text, message.role === "tool" ? toolCharLimit : userCharLimit)
    return text === message.text ? message : { ...message, text }
  })
  // sizeOf includes serialized content and estimated image cost in character units; durable state is deep-frozen (core/src/atoms/incremental/validate.ts).
  const sizes = new WeakMap<object, number>()
  const sizeOf = (message: typeof Conversation.Type[number]) => {
    const cached = sizes.get(message)
    if (cached !== undefined) return cached
    const images = "content" in message && message.content !== undefined
      ? message.content.filter(part => part.type === "file" && part.mediaType.startsWith("image/")).length : 0
    const size = JSON.stringify(message).length + images * policy.imageTokenEstimate * policy.charsPerToken
    if (Object.isFrozen(message)) sizes.set(message, size)
    return size
  }
  return { policy, render, sizeOf }
}

export const ContextState = Schema.Struct({
  ...TrajectoryState.fields,
  totals: Schema.Array(Schema.Finite),
  compaction: CompactionState,
  policy: Schema.String,
})

// createContextState preserves the active rendered tail separately from the full archive (packages/platform/test/bun/agent-compaction.test.ts).
export function createContextState(options: CompactionOptions = {}) {
  const { policy: configured, render: renderAll, sizeOf } = compactionRendering(options)
  const policy = JSON.stringify(configured)
  const render = (message: Message) => renderAll([message])[0]!
  const summarized = (summary: string): typeof Trajectory.Type => summary ? [{ turnId: "", message: render({ role: "user", text: `Earlier conversation summary (compaction applied):\n${summary}` }) }] : []
  const totalsOf = (entries: typeof Trajectory.Type) => {
    const totals = [0]
    for (const entry of entries) totals.push(totals.at(-1)! + sizeOf(entry.message))
    return totals
  }
  const initial = (archive: typeof TrajectoryState.Type | undefined, compaction = initialCompaction): typeof ContextState.Type => {
    const entries = [...summarized(compaction.summary), ...(archive?.entries.slice(compaction.through) ?? []).map(entry => ({ ...entry, message: render(entry.message) }))]
    return { entries, models: archive?.models ?? [], totals: totalsOf(entries), compaction, policy }
  }
  return durableAtom({
    name: "agent.context", schema: ContextState, input: Schema.Union([TrajectoryEvent, CompactionFailed]), initial: initial(undefined),
    initialize: read => initial(read("agent.trajectory", TrajectoryState), read("agent.compaction.state", CompactionState)),
    restore: (state, read) => state.policy === policy ? state : initial(read("agent.trajectory", TrajectoryState), state.compaction),
    reduce: (state, event, metadata, position) => {
      const before = state.compaction, after = compactState(before, event, metadata, position)
      if (event.type === "ModelReturned" && event.purpose === "compaction") {
        const removed = after.through - before.through + Number(before.summary !== "")
        const entries = [...summarized(after.summary), ...state.entries.slice(removed)]
        state = { ...state, entries, totals: totalsOf(entries) }
      }
      const change = trajectoryChange(event, state.models, callId => findTrajectoryTool(state.entries.length, index => state.entries[index]!, callId))
      if (change.entry) {
        const entry = { ...change.entry, message: render(change.entry.message) }
        state = { ...state, entries: [...state.entries, entry], totals: [...state.totals, state.totals.at(-1)! + sizeOf(entry.message)] }
      }
      if (change.models) state = { ...state, models: change.models }
      return after === before ? state : { ...state, compaction: after }

    },
  })
}

export const contextState = createContextState()
