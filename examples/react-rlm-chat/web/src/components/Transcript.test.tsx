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
  expect(html).toContain("Subagent")
})
