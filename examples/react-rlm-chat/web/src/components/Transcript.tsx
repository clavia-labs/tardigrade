import { Button } from "@base-ui/react/button"
import { CaretRight, CircleNotch, Code, Package as PackageIcon } from "@phosphor-icons/react"
import { Worm } from "lucide-react"
import type { ReactElement } from "react"
import type { Event, EventRow } from "@clavia/tardigrade-client"

import { childThread, pendingChildCount, toolContent, toolTitle, value, waitingForResponse } from "../events"
import { MarkdownMessage } from "./MarkdownMessage"

export const Transcript = ({ empty, onOpenThread, rows, streamingText }: {
  readonly empty: string
  readonly onOpenThread: (id: string) => void
  readonly rows: ReadonlyArray<EventRow>
  readonly streamingText: string
}): ReactElement => {
  const messages = rows.filter(({ event }) =>
    event.type === "MessageReceived" || event.type === "ToolCalled" || event.type === "ChildCreated" ||
    (event.type === "PackageCalled" && !value(event, "name")?.startsWith("agents.")) ||
    event.type === "TurnCompleted" || event.type === "TurnFailed"
  )
  const toolsReturned = new Set(rows
    .filter(({ event }) => event.type === "ToolReturned")
    .map(({ event }) => value(event, "callId")))
  const packagesReturned = new Set(rows
    .filter(({ event }) => event.type === "PackageReturned")
    .map(({ event }) => value(event, "callId")))
  const isAgentResultCollector = (event: Event): boolean => {
    const id = value(event, "callId")
    if (event.type !== "ToolCalled" || id === undefined) return false
    const calls = rows.filter(({ event: row }) =>
      row.type === "PackageCalled" && value(row, "callId")?.startsWith(`${id}.`))
    return calls.length > 0 && calls.every(({ event: row }) => value(row, "name") === "agents.result")
  }
  return (
    <section className="messages" aria-live="polite">
      {messages.length === 0 ? <p className="empty">{empty}</p> : null}
      {messages.map(({ event, seq }, index) => {
        if (event.type === "ChildCreated") {
          if (messages[index - 1]?.event.type === "ChildCreated") return null
          const group: Array<EventRow> = []
          for (const row of messages.slice(index)) {
            if (row.event.type !== "ChildCreated") break
            group.push(row)
          }
          const pending = pendingChildCount(group, rows)
          if (group.length === 1) {
            const id = childThread(group[0]!.event)
            return id === undefined ? null : (
              <Button className="subagent-single" key={seq} onClick={() => onOpenThread(id)}>
                <Worm />
                <span>Subagent</span>
                {pending === 0 ? null : <CircleNotch className="spin tree-spinner" aria-label="Subagent is running" />}
              </Button>
            )
          }
          return (
            <details className="subagent-tree" key={seq}>
              <summary>
                <CaretRight className="tree-caret" />
                <Worm />
                <span>x{group.length} {group.length === 1 ? "subagent" : "subagents"}</span>
                {pending === 0 ? null : (
                  <>
                    <CircleNotch className="spin tree-spinner" aria-hidden="true" />
                    <span className="sr-only">{pending} still running</span>
                  </>
                )}
              </summary>
              <div className="tree-children">
                {group.map((child, childIndex) => {
                  const id = childThread(child.event)
                  return id === undefined ? null : (
                    <Button className="subagent-link" key={child.seq} onClick={() => onOpenThread(id)}>
                      <Worm />
                      Subagent {childIndex + 1}
                    </Button>
                  )
                })}
              </div>
            </details>
          )
        }
        if (event.type === "ToolCalled" || event.type === "PackageCalled") {
          if (isAgentResultCollector(event)) return null
          const complete = event.type === "ToolCalled"
            ? toolsReturned.has(value(event, "callId"))
            : packagesReturned.has(value(event, "callId"))
          const execute = value(event, "name") === "execute"
          return (
            <details className={`tool-call${event.type === "PackageCalled" ? " package-call" : ""}`} key={seq}>
              <summary>
                <CaretRight className="tool-caret" />
                {execute ? <Code /> : <PackageIcon />}
                <span>{toolTitle(event, complete)}</span>
                {complete ? null : <CircleNotch className="spin tool-spinner" />}
              </summary>
              <pre><code>{toolContent(event)}</code></pre>
            </details>
          )
        }
        return (
          <article
            className={event.type === "MessageReceived" ? "user" : event.type === "TurnFailed" ? "assistant failed" : "assistant"}
            key={seq}
          >
            {event.type === "TurnCompleted"
              ? <MarkdownMessage>{value(event, "output") ?? ""}</MarkdownMessage>
              : value(event, event.type === "MessageReceived" ? "text" : "error")}
          </article>
        )
      })}
      {streamingText.length > 0 ? (
        <article className="assistant streaming"><MarkdownMessage>{streamingText}</MarkdownMessage></article>
      ) : waitingForResponse(rows) ? (
        <article className="assistant loading" aria-label="Assistant is responding"><span /><span /><span /></article>
      ) : null}
    </section>
  )
}
