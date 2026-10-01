import { styleText, stripVTControlCharacters } from "node:util"
import { Effect, Option, Queue, Terminal } from "effect"
import { Prompt } from "effect/unstable/cli"
import { type ChatMessage } from "@clavia/tardigrade-experimental-agent/atoms/messages"

import type { PermissionNotice } from "./permissions"

export type PromptMessage = ChatMessage | PermissionNotice

const clean = (text: string) => Array.from(stripVTControlCharacters(text), character => {
  const code = character.codePointAt(0)!
  return (code < 32 && character !== "\n" && character !== "\t") || (code >= 127 && code <= 159) ? "" : character
}).join("")

function formatMessage(message: PromptMessage, color = !!process.stdout.isTTY): string {
  if (message.kind === "assistant") return `\n${clean(message.text)}\n\n`
  const label = message.kind === "permission" ? "Permission required" : message.kind === "agent" ? "Child agent" : message.kind === "tool" ? "Tool result" : "Error"
  const text = `${label}\n${clean(message.text).split("\n").map(line => `  ${line}`).join("\n")}`
  return `\n${color ? styleText(message.kind === "error" ? "red" : "magenta", text) : text}\n\n`
}

type State = { readonly text: readonly string[]; readonly cursor: number; readonly message?: PromptMessage }
const segments = (text: string) => Array.from(new Intl.Segmenter().segment(text), segment => segment.segment)

// chatPrompt redraws a single input row when inbox messages arrive while preserving the draft and cursor.
export const chatPrompt = (events: Queue.Dequeue<PromptMessage>) => Prompt.Custom<State, string, PromptMessage>({ text: [], cursor: 0 }, events, {
  render: (state, action) => Effect.gen(function* () {
    if (action._tag === "Submit") return `You › ${state.text.join("")}\n`
    const terminal = yield* Terminal.Terminal
    const columns = yield* terminal.columns
    const label = "You › "
    const available = Math.max(1, columns - Bun.stringWidth(label) - 1)
    let start = state.cursor
    let used = 0
    while (start > 0 && used + Bun.stringWidth(state.text[start - 1]!) < available) used += Bun.stringWidth(state.text[--start]!)
    let end = start
    let width = 0
    while (end < state.text.length && width + Bun.stringWidth(state.text[end]!) <= available) width += Bun.stringWidth(state.text[end++]!)
    const cursor = Bun.stringWidth(label) + Bun.stringWidth(state.text.slice(start, state.cursor).join(""))
    return `${state.message ? formatMessage(state.message) : ""}${label}${state.text.slice(start, end).join("")}\r\u001b[${cursor}C`
  }),
  clear: () => Effect.succeed("\r\u001b[2K"),
  process: (event, previous) => Effect.sync(() => {
    if (event._tag === "Event") return { _tag: "NextFrame", state: { ...previous, message: event.value } }
    const state: State = { text: previous.text, cursor: previous.cursor }
    const { key, input } = event.input
    if (key.name === "return" || key.name === "enter") return { _tag: "Submit", value: state.text.join("") }
    let text = [...state.text]
    let cursor = state.cursor
    if (key.name === "left") cursor = Math.max(0, cursor - 1)
    else if (key.name === "right") cursor = Math.min(text.length, cursor + 1)
    else if (key.name === "home" || (key.ctrl && key.name === "a")) cursor = 0
    else if (key.name === "end" || (key.ctrl && key.name === "e")) cursor = text.length
    else if (key.name === "backspace" && cursor > 0) text.splice(--cursor, 1)
    else if (key.name === "delete") text.splice(cursor, 1)
    else if (key.ctrl && key.name === "u") { text = text.slice(cursor); cursor = 0 }
    else if (key.ctrl && key.name === "k") text = text.slice(0, cursor)
    else if (!key.ctrl && !key.meta && Option.isSome(input)) {
      const inserted = segments(clean(input.value).replace(/[\n\t]/g, " "))
      text.splice(cursor, 0, ...inserted)
      cursor += inserted.length
    }
    return { _tag: "NextFrame", state: { text, cursor } }
  }),
})
