import type { InferDelta } from "@clavia/tardigrade-client"

export interface StreamingText {
  readonly physicalAttempt: string
  readonly nextSequence: number
  readonly text: string
  readonly complete: boolean
}

// appendAnswerDelta tracks the shared sequence while excluding reasoning from answer text (streaming-text.test.ts).
export const appendAnswerDelta = (current: StreamingText | undefined, delta: InferDelta): StreamingText => {
  const text = delta.kind === "reasoning" ? "" : delta.text
  if (current?.physicalAttempt !== delta.physicalAttempt) {
    return { physicalAttempt: delta.physicalAttempt, nextSequence: delta.sequence + 1, text: delta.sequence === 0 ? text : "", complete: delta.sequence !== 0 }
  }
  if (current.complete) return current
  if (delta.sequence !== current.nextSequence) return { ...current, text: "", complete: true }
  return { ...current, nextSequence: delta.sequence + 1, text: current.text + text }
}
