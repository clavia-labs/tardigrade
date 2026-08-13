import type { Envelope } from "@flamecast/core"
import { checkpointOf } from "./context"
import type { AgentMessage, ModelRequest, NativeToolSpec } from "./infer"
import {
  WITHDRAW_ALL,
  type AgentProgram,
  type Nudge,
  type RenderPlan
} from "./program"
import { servedLog } from "./turns"

const truncate = (body: string, at: number): string =>
  body.length <= at ? body : `${body.slice(0, at)}…[truncated ${body.length} chars]`

const nudgeTools = (
  nudge: Nudge,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<NativeToolSpec> =>
  typeof nudge.nativeTools === "function"
    ? nudge.nativeTools(log)
    : (nudge.nativeTools ?? [])

const activeNudges = (
  render: RenderPlan,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<Nudge> => render.nudges.filter((nudge) => nudge.when(log))

export const nativeToolSurface = (
  render: RenderPlan,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<NativeToolSpec> => {
  const active = activeNudges(render, log)
  const withdrawn = new Set(active.flatMap((nudge) => nudge.withdrawsNativeTools ?? []))
  const base = withdrawn.has(WITHDRAW_ALL)
    ? []
    : render.nativeTools.filter((tool) => !withdrawn.has(tool.name))
  const offered = active.flatMap((nudge) => nudgeTools(nudge, log))
  const seen = new Set<string>()
  const surface: Array<NativeToolSpec> = []
  for (const tool of [...base, ...offered]) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    surface.push(tool)
  }
  return surface
}

export const systemPrompt = (render: RenderPlan, log: ReadonlyArray<Envelope>): string =>
  [
    ...render.instructions.map((instruction) => instruction.text),
    ...activeNudges(render, log)
      .filter((nudge) => nudge.placement === "system")
      .map((nudge) => nudge.text)
  ]
    .filter((fragment) => fragment !== "")
    .join("\n\n")

const tailNudgeMessages = (
  render: RenderPlan,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<AgentMessage> =>
  activeNudges(render, log)
    .filter((nudge) => nudge.placement !== "system")
    .map((nudge) => ({ role: "system", content: nudge.text }))

export const renderMessages = (
  render: RenderPlan,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<AgentMessage> => {
  const messages: Array<AgentMessage> = []
  let pendingText: string | null = null
  for (const event of log) {
    switch (event.type) {
      case "MessageReceived": {
        messages.push({
          role: "user",
          content: truncate(String(event.text ?? ""), render.messageTruncateAt)
        })
        break
      }
      case "TextReturned": {
        pendingText = String(event.text ?? "")
        break
      }
      case "ToolCalled": {
        messages.push({
          role: "assistant",
          content: pendingText,
          toolCalls: [
            {
              id: String(event.callId ?? ""),
              name: String(event.name ?? ""),
              arguments: JSON.stringify(event.arguments ?? {})
            }
          ]
        })
        pendingText = null
        break
      }
      case "ToolReturned": {
        const body =
          event.error === undefined
            ? JSON.stringify(event.result ?? null)
            : JSON.stringify({ error: String(event.error) })
        messages.push({
          role: "tool",
          toolCallId: String(event.callId ?? ""),
          content: truncate(body, render.resultTruncateAt)
        })
        break
      }
      case "TurnCompleted": {
        messages.push({ role: "assistant", content: String(event.output ?? "") })
        break
      }
      case "TurnFailed": {
        messages.push({ role: "assistant", content: `the turn failed: ${String(event.error ?? "")}` })
        break
      }
      default:
        break
    }
  }
  return messages
}

export const modelRequest = (
  program: Pick<AgentProgram<never>, "render">,
  log: ReadonlyArray<Envelope>
): ModelRequest => {
  const checkpoint = checkpointOf(log)
  const suffix = servedLog(log.slice(checkpoint.upTo))
  const summary: ReadonlyArray<AgentMessage> =
    checkpoint.summary === ""
      ? []
      : [{ role: "user", content: `Summary of earlier work:\n${checkpoint.summary}` }]
  return {
    system: systemPrompt(program.render, log),
    messages: [
      ...summary,
      ...renderMessages(program.render, suffix),
      ...tailNudgeMessages(program.render, log)
    ],
    tools: nativeToolSurface(program.render, log)
  }
}
