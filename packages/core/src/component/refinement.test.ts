import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { component as defineComponent } from "./machine"
import { componentRefinementTrace } from "./refinement"
import { intent } from "@clavia/tardigrade-core/intent"

describe("component refinement trace", () => {
  test("pairs complete replay, incremental output, and cancellation at every prefix", () => {
    const complete = {
      derive: (log: ReadonlyArray<Event>) => ({
        view: log.filter((event) => event.type === "Counted").length,
        transitions: []
      }),
      cancel: (log: ReadonlyArray<Event>) => [intent({
        key: `cancel:${log.length}`,
        input: undefined,
        events: () => []
      })]
    }
    const component = defineComponent({
      name: "count",
      initial: () => 0,
      step: (count: number, event: Event) => count + (event.type === "Counted" ? 1 : 0),
      output: (count: number) => ({ view: count, transitions: [] }),
      cancelState: (_count, cancellation) => [intent({
        key: `cancel:${cancellation.request}`,
        input: undefined,
        events: () => []
      })]
    })
    const log: ReadonlyArray<Event> = [{ type: "Counted" }, { type: "Ignored" }, { type: "Counted" }]
    const trace = componentRefinementTrace(complete, component, log, (prefix) => [{
      request: String(prefix.length),
      invocation: { method: "work", id: "w1", epoch: 0 },
      cause: "requested"
    }])

    expect(trace.map((step) => step.replay.view)).toEqual([0, 1, 1, 2])
    expect(trace.map((step) => step.incremental.view)).toEqual([0, 1, 1, 2])
    expect(trace.map((step) => step.cancellations[0]?.replay[0]?.key)).toEqual([
      "cancel:0",
      "cancel:1",
      "cancel:2",
      "cancel:3"
    ])
    expect(trace.map((step) => step.cancellations[0]?.incremental[0]?.key)).toEqual([
      "cancel:0",
      "cancel:1",
      "cancel:2",
      "cancel:3"
    ])
  })
})
