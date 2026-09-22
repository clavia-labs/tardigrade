import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect, Layer, Ref } from "effect"
import { eventAt, type Event } from "../../event"
import type { Intent } from "../../intent"
import { EventLog, withWatermark } from "../../log"
import { replayState } from "../../projection/projection"
import { actorFromProjections, settleActor } from "../../runtime"
import { bindTransitionContext, type TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import type { Component } from "../component"
import { withResponse, type ComponentWork, type ComponentOutput } from "../output"
import { machineOf, transitionProjectionOf } from "../runtime"

type Result = { readonly value: number }
type View = { readonly phase: "idle" | "offered" | "admitted" | "finished"; readonly value: number }
type State = View & { readonly request?: TransitionContext }
type Interactions = { readonly inspect: () => View["phase"] }
type Child = Component<View, never, Result, Interactions>
const idle = (): State => ({ phase: "idle", value: 0 })
const invocation = { method: "message", id: "turn", epoch: 0 }
const cancellation = { request: "cancel", invocation, cause: "requested" as const }

const completion = (state: State, value: number) => state.request!.intent("run", { type: "Finished", value })
const pending = (state: State) => state.phase === "offered" || state.phase === "admitted"
const cleanup = (state: State) => pending(state) ? [completion(state, -1)] : []

const output = (state: State, executed: number[], wrongResponse = false): ComponentOutput<View, never, Result, Interactions> => {
  const view = { phase: state.phase, value: state.value }
  const work = !pending(state) ? [] : [withResponse(state.phase === "offered"
    ? state.request!.intent("admit", { type: "Admitted" })
    : state.request!.effect("run", { input: 0, act: () => Effect.sync(() => {
      executed.push(0)
      return { type: "Finished", value: 0 }
    }) }), (result: Result) => completion(state, wrongResponse ? 999 : result.value))]
  return { view, transitions: work, interactions: { inspect: () => state.phase, cancel: () => cleanup(state) } }
}

// incremental retains the current protocol state; historyDerived reconstructs it from recorded occurrences.
const incremental = (executed: number[], wrongResponse = false): Child => component({
  name: "subject",
  initial: idle,
  step: (state, event, context): State => {
    if (event.type === "Requested") return { phase: "offered", value: 0, request: context }
    if (pending(state) && event.type === "Finished" && state.request!.matches("run", event)) return { ...state, phase: "finished", value: Number(event.value) }
    if (state.phase === "offered" && event.type === "Admitted" && state.request!.matches("admit", event)) return { ...state, phase: "admitted" }
    // Fresh snapshots preserve the same admission provenance lifetime as the history implementation.
    return { ...state }
  },
  output: state => output(state, executed, wrongResponse)
})

const stateFrom = (history: ReadonlyArray<Event>): State => {
  const index = history.findLastIndex(event => event.type === "Requested")
  if (index === -1) return idle()
  const request = bindTransitionContext(history[index]!, "subject")
  const subsequent = history.slice(index + 1)
  const finished = subsequent.find(event => event.type === "Finished" && request.matches("run", event))
  if (finished !== undefined) return { phase: "finished", value: Number(finished.value), request }
  return { phase: subsequent.some(event => event.type === "Admitted" && request.matches("admit", event)) ? "admitted" : "offered", value: 0, request }
}
const historyDerived = (executed: number[]): Child => component({
  name: "subject",
  initial: (): ReadonlyArray<Event> => [],
  step: (history, event) => [...history, event],
  output: history => output(stateFrom(history), executed)
})

type Mode = "allow" | "wait" | "reject"
type Wrapper = { readonly kind: "forward" | "map" | "preview" | "policy" | "retain" | "cancel"; readonly value: number }
const modes = fc.constantFrom<Mode>("allow", "wait", "reject")
const wrapper = fc.record({ kind: fc.constantFrom<Wrapper["kind"]>("forward", "map", "preview", "policy", "retain", "cancel"), value: fc.integer({ min: -3, max: 3 }) })

const wrap = (child: Child, spec: Wrapper, index: number): Child => component({
  name: `parent-${index}`,
  children: child,
  initial: (): { readonly mode: Mode; readonly saved?: Intent<never>; readonly published: boolean; readonly cancel: boolean } => ({ mode: "allow", published: false, cancel: false }),
  step: (state, event, _context, bound) => {
    if (event.type === "Policy") return { ...state, mode: event.mode as Mode }
    if (event.type === "Capture") {
      const saved = bound.output().transitions.find(work => work.respond !== undefined)?.respond!({ value: Number(event.value) })
      return saved === undefined ? state : { ...state, saved, published: false }
    }
    if (event.type === "Publish") return { ...state, published: true }
    if (event.type === "Withhold") return { ...state, published: false }
    if (event.type === "Cancel") return { ...state, cancel: true }
    if (event.type === "Requested") return { ...state, cancel: false }
    return state
  },

  output: (state, bound) => {
    const child = bound.output()
    const phase = child.interactions!.inspect()
    switch (spec.kind) {
      case "map": return { ...child, view: { ...child.view, value: child.view.value + spec.value } }
      case "policy": return { ...child, transitions: state.mode === "wait" ? [] : state.mode === "allow" ? child.transitions : child.transitions.flatMap((work): ReadonlyArray<ComponentWork<never, Result>> => work.respond === undefined ? [work] : [work.respond({ value: spec.value })]) }
      case "retain": return state.saved === undefined ? child : { ...child, transitions: state.published ? [state.saved] : [] }
      case "cancel": return state.cancel ? { ...child, transitions: child.interactions?.cancel?.(cancellation) ?? [] } : child
      case "preview": {
        let cursor = bound.admission()
        const transitions = child.transitions.filter(work => {
          if (work.kind !== "intent") return true
          const next = cursor.preview(work)
          const accepted = next.output().view.phase !== phase || next.output().view.value === child.view.value
          if (accepted) cursor = next
          return accepted
        })
        return { ...child, transitions }
      }
      default: return child
    }
  }
})

const context = (child: Child, wrappers: ReadonlyArray<Wrapper>) => {
  const wrapped = wrappers.reduce((child, spec, index) => wrap(child, spec, index), child)
  const witness = component({ name: "witness", initial: () => 0, step: (count, event) => count + Number(event.type === "Finished"), output: count => ({ view: count, transitions: [] }) })
  return component({
    name: "context", children: [wrapped, witness] as const,
    initial: () => undefined, step: state => state,

    output: (_state, children) => ({
    view: { child: children[0].output().view, sibling: children[1].output().view },
    transitions: children[0].output().transitions,
    interactions: {
        ...children[0].output().interactions!,
        cancel: (value) => children[0].output().interactions?.cancel?.(value) ?? []
    }
})
  })
}

const describe = <V>(value: ComponentOutput<V, never, Result, Interactions>) => ({
  view: value.view,
  interaction: value.interactions!.inspect(),
  proposals: value.transitions.map(work => {
    const response = work.respond?.({ value: 17 })
    return ({
    key: work.key, kind: work.kind, invocation: work.invocation,
    events: work.kind === "intent" ? work.events(work.input, 5) : undefined,
    response: response?.events(response.input, 5)
  }) })
})

const command = fc.oneof(
  fc.constantFrom("Requested", "Publish", "Withhold", "Cancel", "Noise", "Settle", "Restart").map(type => ({ type })),
  modes.map(mode => ({ type: "Policy", mode })),
  fc.integer({ min: -9, max: 9 }).map(value => ({ type: "Capture", value }))
)

const run = async (child: Child, wrappers: ReadonlyArray<Wrapper>, commands: ReadonlyArray<Event>) => {
  const parent = context(child, wrappers)
  const machine = machineOf(parent)
  const runtime = actorFromProjections({ transitions: [transitionProjectionOf(parent)], keyOf: () => undefined })
  const storage = Layer.effect(EventLog, Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<Event>>([])
    return withWatermark({ read: Ref.get(events), append: tail => Ref.update(events, events => [...events, ...tail]) })
  }))
  return Effect.runPromise(Effect.gen(function* () {
    const log = yield* EventLog
    const observed: unknown[] = []
    let state = machine.initial()
    let position = 0
    for (const action of commands) {
      if (action.type === "Settle") yield* settleActor(runtime)
      else if (action.type === "Restart") { state = machine.initial(); position = 0 }
      else yield* log.append([action])
      const history = yield* log.read
      for (; position < history.length; position++) state = machine.step(state, eventAt(history[position]!, position + 1))
      const current = machine.output(state)
      expect(describe(current)).toEqual(describe(machine.output(replayState(machine, history))))
      observed.push({ log: [...history], output: describe(current), cleanup: (machine.output(state).interactions?.cancel?.(cancellation) ?? []).map(work => work.kind === "intent" ? work.events(work.input, 5) : work.key) })
    }
    return observed
  }).pipe(Effect.provide(storage)))
}

test("distinct child representations substitute through generated public-boundary contexts", async () => {
  await fc.assert(fc.asyncProperty(fc.array(wrapper, { maxLength: 4 }), fc.array(command, { maxLength: 25 }), async (wrappers, generated) => {
    const left: number[] = [], right: number[] = []
    const commands = [
      { type: "Requested" }, { type: "Capture", value: 7 }, { type: "Withhold" }, { type: "Settle" },
      { type: "Requested" }, { type: "Publish" }, { type: "Settle" }, { type: "Restart" },
      ...generated, { type: "Policy", mode: "allow" }, { type: "Settle" }
    ]
    expect(await run(incremental(left), wrappers, commands)).toEqual(await run(historyDerived(right), wrappers, commands))
    expect(left).toEqual(right)
  }), { numRuns: 100 })
}, 15_000)

test("matching declarations do not permit substituting a changed response", async () => {
  const commands = [{ type: "Requested" }, { type: "Capture", value: 7 }, { type: "Publish" }, { type: "Settle" }]
  const left = incremental([]), right = incremental([], true)
  const read = (child: Child) => {
    const machine = machineOf(child)
    const value = machine.output(replayState(machine, commands.slice(0, 1)))
    return { view: value.view, proposals: value.transitions.map(({ key, kind }) => ({ key, kind })) }
  }
  expect(read(left)).toEqual(read(right))
  const wrappers: Wrapper[] = [{ kind: "retain", value: 0 }]
  expect(await run(left, wrappers, commands)).not.toEqual(await run(right, wrappers, commands))
})

test("reference inspection lies outside admissible parent contexts", () => {
  const first = (value: number) => value + 1
  const second = (value: number) => 1 + value
  const parent = (callback: (value: number) => number) => callback === first
  expect(first(4)).toBe(second(4))
  expect(parent(first)).not.toBe(parent(second))
})
