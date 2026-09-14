import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Event, EventRow } from "@clavia/tardigrade-client"
import { Transcript } from "./Transcript"

test("a recorded opaque child renders a subagent control", () => {
  const rows: EventRow[] = [{
    seq: 1,
    event: {
      type: "ChildCreated", callId: "run.0",
      address: { actor: "chat", instance: "main", thread: "a".repeat(64) }
    } as Event
  }]
  const html = renderToStaticMarkup(<Transcript empty="Empty" rows={rows} streamingText="" onOpenThread={() => {}} />)
  expect(html).toContain('class="subagent-single"')
  expect(html).toContain("a".repeat(64))
})

test("tool groups preserve child and answer boundaries and report pending work", () => {
  const events: Event[] = [
    { type: "ToolCalled", callId: "first", name: "execute", arguments: { code: "return 1" } },
    { type: "PackageCalled", callId: "read", name: "workspace.read", arguments: { path: "notes" } },
    { type: "ToolReturned", callId: "first" },
    { type: "PackageReturned", callId: "read" },
    { type: "ChildCreated", callId: "child", address: { actor: "chat", instance: "main", thread: "research" } },
    { type: "ToolCalled", callId: "second", name: "execute", arguments: { code: "return 2" } },
    { type: "ToolCalled", callId: "third", name: "execute", arguments: { code: "return 3" } },
    { type: "ToolReturned", callId: "second" },
    { type: "TurnCompleted", output: "Answer boundary" },
    { type: "ToolCalled", callId: "fourth", name: "execute", arguments: { code: "return 4" } }
  ] as Event[]
  const render = () => renderToStaticMarkup(<Transcript empty="Empty" rows={events.map((event, seq) => ({ event, seq }))} streamingText="" onOpenThread={() => {}} />)
  const html = render()
  expect(html.match(/class="tool-call tool-activity"/g)).toHaveLength(2)
  expect(html).toContain("2 steps completed")
  expect(html).toContain("1 of 2 steps completed")
  expect(html.indexOf("2 steps completed")).toBeLessThan(html.indexOf('title="research"'))
  expect(html.indexOf('title="research"')).toBeLessThan(html.indexOf("1 of 2 steps completed"))
  expect(html.indexOf("Answer boundary")).toBeLessThan(html.indexOf("return 4"))
  expect(html).not.toContain(" open=")
  events.push({ type: "ToolReturned", callId: "third" } as Event)
  expect(render()).not.toContain("1 of 2 steps completed")
})

test("replayed reasoning stays collapsed and separate from answers and opaque data", () => {
  const rows: EventRow[] = JSON.parse(JSON.stringify([
    { seq: 1, event: { type: "ModelReturned", reasoning: "Compare **both** sources", continuation: { payload: [{ signature: "opaque-secret" }] } } },
    { seq: 2, event: { type: "TurnCompleted", output: "Final answer" } },
    { seq: 3, event: { type: "ModelReturned", reasoning: " ", continuation: { payload: [{ encrypted_content: "opaque-only" }] } } }
  ]))
  const html = renderToStaticMarkup(<Transcript empty="Empty" rows={rows} streamingText="Partial answer" onOpenThread={() => {}} />)
  expect(html.match(/class="tool-call reasoning"/g)).toHaveLength(1)
  expect(html).toContain("<strong>both</strong>")
  expect(html).toContain("Final answer")
  expect(html).toContain("Partial answer")
  expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("Final answer"))
  expect(html).not.toContain("opaque-secret")
  expect(html).not.toContain("opaque-only")
  expect(html).not.toContain(" open=")
})
