import { useEffect, useState } from "react"
import type { EventRow, InferDelta } from "@clavia/tardigrade-client"

import { actor, client } from "./chat-client"
import { endsResponse } from "./events"

interface StreamingText {
  readonly physicalAttempt: string
  readonly nextSequence: number
  readonly text: string
  readonly complete: boolean
}

export const useStreamingText = (id: string | undefined, rows: ReadonlyArray<EventRow>): string => {
  const [streaming, setStreaming] = useState<StreamingText | undefined>()
  const terminal = rows.findLast(({ event }) => endsResponse(event))?.seq

  useEffect(() => {
    if (id === undefined || rows.length === 0) return
    setStreaming(undefined)
    return client.followInference(actor, id, {
      onDelta: (delta: InferDelta) => setStreaming((current) => {
        if (current?.physicalAttempt !== delta.physicalAttempt) {
          return {
            physicalAttempt: delta.physicalAttempt,
            nextSequence: delta.sequence + 1,
            text: delta.sequence === 0 ? delta.text : "",
            complete: delta.sequence !== 0
          }
        }
        if (current.complete) return current
        if (delta.sequence !== current.nextSequence) return { ...current, text: "", complete: true }
        return { ...current, nextSequence: delta.sequence + 1, text: current.text + delta.text }
      })
    })
  }, [id, rows.length > 0])

  useEffect(() => setStreaming(undefined), [terminal])
  return streaming?.text ?? ""
}
