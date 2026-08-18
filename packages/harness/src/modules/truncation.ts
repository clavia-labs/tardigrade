import type { Event } from "@flamecast/core"
import { nudge } from "./nudge"

// What to say to a model whose answer was cut at the output ceiling. The loop records the fragment
// and continues the turn; the words that ask for the rest are agent design, so they live in a nudge
// the author can reword, replace, or drop rather than in the renderer where nothing could reach
// them. `defaultPack` includes this one, which is what makes a truncated answer resume out of the
// box.
//
// The two cases differ in what the model can do. Prose can be continued from where it stopped. A
// tool call cannot: its arguments stopped mid-JSON, so nothing was dispatched and the call has to
// be made again, smaller. An agent whose tools can append will want to say something else here, and
// that is the point of the seam.

const CONTINUE_TEXT =
  "Your previous answer stopped at the output-token ceiling before you finished it. Continue from " +
  "exactly where it stopped. Do not repeat what you already wrote, and do not start over."

const REISSUE_TEXT =
  "Your previous tool call stopped at the output-token ceiling before its arguments were complete, " +
  "so it was never dispatched. Nothing has changed. Make the call again, sized to finish this time: " +
  "split the work across several smaller calls rather than sending one that will be cut again."

// The last thing the model did, as far as a render is concerned. A truncation matters only while it
// is the most recent act: once a tool runs or a fresh answer lands, there is nothing to continue.
const openTruncation = (log: ReadonlyArray<Event>): Event | undefined => {
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event === undefined) continue
    if (event.type === "AnswerTruncated") return event
    if (
      event.type === "ToolCalled" ||
      event.type === "ToolReturned" ||
      event.type === "TextReturned" ||
      event.type === "TurnCompleted" ||
      event.type === "TurnFailed" ||
      event.type === "MessageReceived"
    ) {
      return undefined
    }
  }
  return undefined
}

export interface TruncationNudgeOptions {
  // What to say when prose was cut. The default asks the model to continue from the fragment.
  readonly continueText?: string
  // What to say when a tool call was cut. The default asks for a smaller call, because the partial
  // arguments never parsed and nothing ran.
  readonly reissueText?: string
}

export const truncationNudge = (options: TruncationNudgeOptions = {}) => {
  const continueText = options.continueText ?? CONTINUE_TEXT
  const reissueText = options.reissueText ?? REISSUE_TEXT
  const cutCall = (log: ReadonlyArray<Event>) => openTruncation(log)?.tool !== undefined
  return [
    nudge({
      id: "answer-truncated",
      version: "1",
      when: (log) => openTruncation(log) !== undefined && !cutCall(log),
      text: continueText
    }),
    nudge({
      id: "tool-call-truncated",
      version: "1",
      when: (log) => cutCall(log),
      text: reissueText
    })
  ] as const
}
