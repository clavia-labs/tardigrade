import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect, Layer, Ref } from "effect"
import { eventAt, type Event } from "../../event"
import { EventLog, withWatermark } from "../../log"
import { replayState } from "../../projection/projection"
import { actorFromProjections, enabled, settleActor } from "../../runtime"
import { transitionKeyOf, type TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import { withResponse, type ComponentWork } from "../output"
import { machineOf, transitionProjectionOf } from "../runtime"
import { composeComponents } from "./siblings"

type Mode = "allow" | "wait" | "reject"
type Result = { readonly value: number }
type Request = { readonly key: string; readonly owner: string; readonly id: string }
type Finished = Request & Result
const modes = fc.constantFrom<Mode>("allow", "wait", "reject")

const worker = (name: string, executions: string[]) => component({
  name,
  initial: (): { readonly pending: ReadonlyArray<Request & { readonly context: TransitionContext }>; readonly finished: ReadonlyArray<Finished> } => ({ pending: [], finished: [] }),
  step: (state, event, context) => {
    if (event.type === "Requested" && event.owner === name) {
      const key = context.intent("run", { type: "Finished" }).key
      return { ...state, pending: [...state.pending, { key, owner: name, id: String(event.id), context }] }
    }
    const matched = event.type === "Finished" ? state.pending.find((call) => call.context.matches("run", event)) : undefined
    if (matched === undefined) return state
    return {
      pending: state.pending.filter((call) => call !== matched),
      finished: [...state.finished, { key: matched.key, owner: name, id: matched.id, value: Number(event.value) }]
    }
  },
  output: (state) => ({
    view: {
      pending: state.pending.map(({ key, owner, id }) => ({ key, owner, id })),
      finished: state.finished
    },
    transitions: state.pending.map(({ context, key, owner, id }) => {
      const finish = (result: Result) => ({ type: "Finished", owner, id, value: result.value })
      return withResponse(context.effect("run", {
        input: { owner, id },
        act: () => Effect.sync(() => { executions.push(key); return finish({ value: 0 }) })
      }), (result: Result) => context.intent("run", finish(result)))
    })
  })
})
type Work = ReturnType<typeof worker>
const merge = (name: string, children: ReadonlyArray<Work>): Work => composeComponents(name, {
  empty: { pending: [] as Request[], finished: [] as ReadonlyArray<Finished> },
  combine: (a, b) => ({ pending: [...a.pending, ...b.pending], finished: [...a.finished, ...b.finished] })
}, children)

const policy = (name: string, child: Work, initial: Mode, refusal: number): Work => component({
  name, children: child, initial: () => initial,
  step: (mode, event) => event.type === "PolicyChanged" && event.owner === name ? event.mode as Mode : mode,
  output: (mode, bound) => {
    const output = bound.output()
    return { ...output, transitions: output.transitions.flatMap((proposal): ReadonlyArray<ComponentWork<EventLog, Result>> => {
      if (proposal.kind === "intent" || mode === "allow") return [proposal]
      return mode === "wait" ? [] : [proposal.respond!({ value: refusal })]
    }) }
  }
})

const command = fc.oneof(
  fc.record({ kind: fc.constant("request" as const), owner: fc.nat(3), id: fc.constantFrom("same-id", "other-id") }),
  fc.record({ kind: fc.constant("policy" as const), owner: fc.constantFrom("inner", "outer"), mode: modes }),
  fc.record({ kind: fc.constant("settle" as const) }),
  fc.record({ kind: fc.constant("restart" as const) })
)
const sorted = <T extends { readonly key: string }>(values: ReadonlyArray<T>): T[] => [...values].sort((a, b) => a.key.localeCompare(b.key))

test("generated nested policies preserve sibling responses, pending work, and recorded decisions across replay", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 4 }), modes, modes, fc.array(command, { minLength: 8, maxLength: 35 }), async (count, firstInner, firstOuter, commands) => {
    const executed: string[] = []
    const expectedExecuted: string[] = []
    const leaves = Array.from({ length: count }, (_, index) => worker(`worker-${index}`, executed))
    const flat = merge("flat", leaves)
    const grouped = merge("grouped", [leaves[0]!, merge("rest", leaves.slice(1))])
    const wrap = (child: Work) => policy("outer", policy("inner", child, firstInner, 101), firstOuter, 202)
    const flatMachine = machineOf(wrap(flat))
    const nested = wrap(grouped)
    const nestedMachine = machineOf(nested)
    const runtime = actorFromProjections({ transitions: [transitionProjectionOf(nested)], keyOf: () => undefined })
    const pending = new Map<string, Request>()
    const finished: Finished[] = []
    let inner = firstInner
    let outer = firstOuter
    let state = nestedMachine.initial()
    let position = 0
    const storage = Layer.effect(EventLog, Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>([])
      return withWatermark({ append: (events) => Ref.update(ref, (log) => [...log, ...events]), read: Ref.get(ref) })
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const log = yield* EventLog
      const actions = [
        ...leaves.map((_leaf, owner) => ({ kind: "request" as const, owner, id: "same-id" })),
        { kind: "request" as const, owner: 0, id: "same-id" },
        ...commands,
        { kind: "policy" as const, owner: "inner", mode: "allow" as const },
        { kind: "policy" as const, owner: "outer", mode: "allow" as const },
        { kind: "settle" as const }
      ]
      for (const action of actions) {
        if (action.kind === "request") {
          const owner = `worker-${action.owner % count}`
          const seq = (yield* log.read).length + 1
          yield* log.append([{ type: "Requested", owner, id: action.id }])
          const key = JSON.stringify([seq, owner, "run"])
          pending.set(key, { key, owner, id: action.id })
        } else if (action.kind === "policy") {
          yield* log.append([{ type: "PolicyChanged", owner: action.owner, mode: action.mode }])
          if (action.owner === "inner") inner = action.mode
          else outer = action.mode
        } else if (action.kind === "settle") {
          // The oracle distinguishes inner rejection from an outer execution hold.
          const value = inner === "reject" ? 101 : inner === "wait" || outer === "wait" ? undefined : outer === "reject" ? 202 : 0
          if (value !== undefined) {
            for (const request of pending.values()) {
              finished.push({ ...request, value })
              if (value === 0) expectedExecuted.push(request.key)
            }
            pending.clear()
          }
          yield* settleActor(runtime)
        } else {
          state = nestedMachine.initial()
          position = 0
        }
        const history = yield* log.read
        for (; position < history.length; position++) state = nestedMachine.step(state, eventAt(history[position]!, position + 1))
        const actual = nestedMachine.output(state)
        expect(sorted(actual.view.pending)).toEqual(sorted([...pending.values()]))
        expect(sorted(actual.view.finished)).toEqual(sorted(finished))
        expect([...executed].sort()).toEqual([...expectedExecuted].sort())
        expect(history.filter((event) => event.type === "Finished").map(transitionKeyOf).sort()).toEqual(finished.map((call) => call.key).sort())
        const describe = (output: typeof actual) => ({
          view: output.view,
          proposals: output.transitions.map((proposal) => {
            const response = proposal.respond?.({ value: 7 })
            return {
              key: proposal.key, kind: proposal.kind, input: proposal.input,
              events: proposal.kind === "intent" ? proposal.events(proposal.input, 0) : undefined,
              response: response?.events(response.input, 0)
            }
          })
        })
        expect(describe(actual)).toEqual(describe(nestedMachine.output(replayState(nestedMachine, history))))
        expect(describe(actual)).toEqual(describe(flatMachine.output(replayState(flatMachine, history))))
        expect(enabled(runtime, history).map((proposal) => proposal.key)).toEqual(actual.transitions.map((proposal) => proposal.key))
      }
      expect(pending.size).toBe(0)
      const settled = yield* log.read
      yield* settleActor(runtime)
      expect(yield* log.read).toEqual(settled)
    }).pipe(Effect.provide(storage)))
  }), { numRuns: 100 })
})
