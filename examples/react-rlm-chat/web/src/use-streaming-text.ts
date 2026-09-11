import { useEffect, useState } from "react"
import type { EventRow, InferDelta } from "@clavia/tardigrade-client"

import { actor, client } from "./chat-client"
import { endsResponse } from "./events"

import { appendAnswerDelta, type StreamingText } from "./streaming-text"

export const useStreamingText = (id: string | undefined, rows: ReadonlyArray<EventRow>): string => {
  const [streaming, setStreaming] = useState<StreamingText | undefined>()
  const terminal = rows.findLast(({ event }) => endsResponse(event))?.seq

  useEffect(() => {
    if (id === undefined || rows.length === 0) return
    setStreaming(undefined)
    return client.followInference(actor, id, {
      onDelta: (delta: InferDelta) => setStreaming((current) => appendAnswerDelta(current, delta))
    })
  }, [id, rows.length > 0])

  useEffect(() => setStreaming(undefined), [terminal])
  return streaming?.text ?? ""
}
