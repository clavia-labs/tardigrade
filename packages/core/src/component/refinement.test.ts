import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { component as defineComponent } from "./machine"
import { componentRefinementTrace } from "./refinement"
import { bindTransitionContext, type TransitionContext } from "../transition/transition"

describe("component refinement trace", () => {
  test("pairs complete replay, incremental output, and cancellation at every prefix", () => {
    const complete = {
      derive: (log: ReadonlyArray<Event>) => ({
        view: log.filter((event) => event.type === "Counted").length,
        transitions: []
      }),
      cancel: (log: ReadonlyArray<Event>) => log.length === 0 ? [] : [
        bindTransitionContext(log.at(-1)!, "count").intent("cancel", { type: "Cancelled" })
      ]
    }
    const component = defineComponent({
      name: "count",
      initial: () => ({ count: 0, ctx: undefined as TransitionContext | undefined }),
      step: (state, event, ctx) => ({ count: state.count + (event.type === "Counted" ? 1 : 0), ctx }),
      output: (state) => ({ view: state.count, transitions: [] }),
      cancelState: (state) => state.ctx === undefined ? [] : [state.ctx.intent("cancel", { type: "Cancelled" })]
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
      undefined,
      JSON.stringify([1, "count", "cancel"]),
      JSON.stringify([2, "count", "cancel"]),
      JSON.stringify([3, "count", "cancel"])
    ])
    expect(trace.map((step) => step.cancellations[0]?.incremental[0]?.key)).toEqual([
      undefined,
      JSON.stringify([1, "count", "cancel"]),
      JSON.stringify([2, "count", "cancel"]),
      JSON.stringify([3, "count", "cancel"])
    ])
  })
})
