import { eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { transitionKeyOf, type TransitionRef } from "@clavia/tardigrade-core/transition/transition"

// toolCallPosition identifies a committed ToolCalled occurrence (../component/tool/tool.properties.test.ts).
export const toolCallPosition = (event: Event): number => {
  const position = eventPositionOf(event)
  if (position === undefined) throw new Error("ToolCalled requires a committed event position")
  return position
}

// toolResultPosition identifies the request answered by a stamped tool result (../component/tool/tool.properties.test.ts).
export const toolResultPosition = (event: Event): number | undefined =>
  transitionKeyOf(event) === undefined ? undefined : (event.transitionRef as TransitionRef).seq
