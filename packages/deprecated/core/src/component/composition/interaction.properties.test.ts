import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect, Layer, Ref } from "effect"
import { eventAt, type Event } from "../../event"
import type { Intent } from "../../intent"
import { EventLog, withWatermark } from "../../log"
import { replayState } from "../../projection/projection"
import { actorFromProjections, enabled, settleActor } from "../../runtime"
import type { TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import { withResponse } from "../output"
import { machineOf, transitionProjectionOf } from "../runtime"

type Result = { readonly value: number }
type Finished = { readonly id: string; readonly value: number }
type State = {
  readonly pending?: { readonly id: string; readonly context: TransitionContext }
  readonly finished: ReadonlyArray<Finished>
}

// pendingCall accepts completion only for its current request occurrence (the generated lifecycle and stale-response control below).
const pendingCall = (matchOccurrence = true) => component({
  name: "call",
  initial: (): State => ({ finished: [] }),
  step: (state, event, context): State => {
    if (event.type === "Requested") return { ...state, pending: { id: String(event.id), context } }
    if (event.type !== "Finished" || state.pending === undefined || event.id !== state.pending.id) return state
    if (matchOccurrence && !state.pending.context.matches("run", event)) return state
    return { finished: [...state.finished, { id: state.pending.id, value: Number(event.value) }] }
  },
  output: (state) => {
    const pending = state.pending
    const finished = (result: Result) => ({ type: "Finished", id: pending!.id, value: result.value })
    return {
      view: { pending: pending?.id, finished: state.finished },
      transitions: pending === undefined ? [] : [withResponse(pending.context.effect("run", {
        input: pending.id,
        act: () => Effect.succeed(finished({ value: 0 }))
      }), (result: Result) => pending.context.intent("run", finished(result))) ]
    }
  }
})

type Call = ReturnType<typeof pendingCall>
const identity = (child: Call, name: string): Call => component({
  name, children: child, initial: () => undefined, step: () => undefined,
  output: (_state, bound) => bound.output()
})

const command = fc.oneof(
  fc.record({ kind: fc.constant("request" as const), id: fc.constantFrom("a", "b") }),
  fc.record({ kind: fc.constant("respond" as const), index: fc.nat(20), value: fc.integer({ min: -10, max: 10 }) }),
  fc.record({ kind: fc.constant("commit" as const) }),
  fc.record({ kind: fc.constant("restart" as const) }),
  fc.record({ kind: fc.constant("noise" as const) })
)

test("generated completion lifecycles agree with a request-occurrence model through identity wrappers and replay", () => {
  fc.assert(fc.property(fc.array(command, { maxLength: 60 }), fc.integer({ min: 0, max: 4 }), (commands, depth) => {
    const child = pendingCall()
    let wrapped = child
    for (let index = 0; index < depth; index++) wrapped = identity(wrapped, `identity-${index}`)
    const machines = [machineOf(child), machineOf(wrapped)]
    let states = machines.map((machine) => machine.initial())
    const log: Event[] = []
    const captures: Array<{ id: string; seq: number; respond: Array<(result: Result) => Intent<never>> }> = []
    let candidate: { id: string; seq: number; value: number; intents: Intent<never>[] } | undefined
    let pending: { id: string; seq: number } | undefined
    const finished: Finished[] = []
    const append = (event: Event) => {
      log.push(event)
      states = machines.map((machine, index) => machine.step(states[index], eventAt(event, log.length)))
    }
    const describe = (machine: typeof machines[number], state: unknown) => {
      const output = machine.output(state)
      return { view: output.view,
        proposals: output.transitions.map(({ key, kind, input, respond }) => ({ key, kind, input, canRespond: respond !== undefined })) }
    }
    for (const action of commands) {
      switch (action.kind) {
        case "request": {
          append({ type: "Requested", id: action.id })
          pending = { id: action.id, seq: log.length }
          captures.push({ ...pending, respond: machines.map((machine, index) => machine.output(states[index]).transitions[0]!.respond!) })
          break
        }
        case "respond": {
          if (captures.length === 0) break
          const captured = captures[action.index % captures.length]!
          const before = machines.map((machine, index) => machine.output(states[index]))
          const intents = captured.respond.map((respond) => respond({ value: action.value }))
          candidate = { id: captured.id, seq: captured.seq, value: action.value, intents }
          for (const intent of intents) {
            expect(intent.events(intent.input, 0)).toEqual([{
              type: "Finished", id: captured.id, value: action.value,
              transitionRef: { seq: captured.seq, component: "call", tag: "run" }
            }])
          }
          machines.forEach((machine, index) => expect(machine.output(states[index])).toBe(before[index]!))
          break
        }
        case "commit": {
          if (candidate === undefined) break
          // Repeated delivery exercises the child even when runtime key deduplication would suppress it.
          for (const event of candidate.intents[0]!.events(candidate.intents[0]!.input, 0)) append(event)
          if (pending?.seq === candidate.seq && pending.id === candidate.id) {
            finished.push({ id: candidate.id, value: candidate.value })
            pending = undefined
          }
          break
        }
        case "restart":
          states = machines.map((machine) => replayState(machine, log))
          break
        case "noise":
          append({ type: "Ignored" })
      }
      const expected = { pending: pending?.id, finished }
      machines.forEach((machine, index) => {
        const output = machine.output(states[index])
        expect(output.view).toEqual(expected)
        expect(output.transitions.map((proposal) => proposal.key)).toEqual(pending === undefined ? [] : [JSON.stringify([pending.seq, "call", "run"])])
        expect(describe(machine, states[index])).toEqual(describe(machine, replayState(machine, log)))
      })
      expect(describe(machines[0]!, states[0])).toEqual(describe(machines[1]!, states[1]))
      if (pending !== undefined) {
        const result = { value: 42 }
        const completions = machines.map((machine, index) => machine.output(states[index]).transitions[0]!.respond!(result))
        expect(completions[0]!.events(completions[0]!.input, 0)).toEqual(completions[1]!.events(completions[1]!.input, 0))
        const replayed = machineOf(child)
        const completion = replayed.output(replayState(replayed, log)).transitions[0]!.respond!(result)
        expect(completion.events(completion.input, 0)).toEqual(completions[0]!.events(completions[0]!.input, 0))
      }
    }
  }), { numRuns: 300 })
})

const memoryLog = (initial: ReadonlyArray<Event>) => Layer.effect(EventLog, Effect.gen(function* () {
  const events = yield* Ref.make(initial)
  return withWatermark({
    append: (tail: ReadonlyArray<Event>) => Ref.update(events, (current) => [...current, ...tail]),
    read: Ref.get(events)
  })
}))

const publication = (child: Call, intent: Intent<never>, publish: boolean) => {
  const boundary = component({
    name: "boundary", children: child, initial: () => undefined, step: () => undefined,
    output: (_state, bound) => ({ ...bound.output(), transitions: publish ? [intent] : [] })
  })
  return actorFromProjections({ transitions: [transitionProjectionOf(boundary)], keyOf: () => undefined })
}

test("runtime selection and recorded keys govern publication; child correlation governs stale responses", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer(), fc.integer(), async (stale, publish, first, second) => {
    const child = pendingCall()
    const machine = machineOf(child)
    const requested: Event = { type: "Requested", id: "same-id" }
    const proposal = machine.output(replayState(machine, [requested])).transitions[0]!
    const initial = stale ? [requested, requested] : [requested]
    const completion = proposal.respond!({ value: first })
    const runtime = publication(child, completion, publish)
    const log = await Effect.runPromise(Effect.gen(function* () {
      const events = yield* EventLog
      expect(enabled(runtime, yield* events.read)).toHaveLength(publish ? 1 : 0)
      yield* settleActor(runtime)
      const after = yield* events.read
      yield* settleActor(runtime)
      const reconstructed = machine.output(replayState(machine, [requested])).transitions[0]!
      yield* settleActor(publication(child, reconstructed.respond!({ value: second }), publish))
      expect(yield* events.read).toEqual(after)
      return after
    }).pipe(Effect.provide(memoryLog(initial))))
    const completions = log.filter((event) => event.type === "Finished")
    expect(completions).toHaveLength(publish ? 1 : 0)
    if (publish) expect(completions[0]).toMatchObject({ id: "same-id", value: first, transitionRef: { seq: 1, component: "call", tag: "run" } })
    expect(machine.output(replayState(machine, log)).view).toEqual(publish && !stale
      ? { pending: undefined, finished: [{ id: "same-id", value: first }] }
      : { pending: "same-id", finished: [] })
  }), { numRuns: 80 })
})

test("matching only a call ID lets a retained completion settle a newer occurrence", () => {
  for (const guarded of [true, false]) {
    const child = pendingCall(guarded)
    const machine = machineOf(child)
    const requested = { type: "Requested", id: "same-id" }
    const first = replayState(machine, [requested])
    const retained = machine.output(first).transitions[0]!.respond!({ value: 7 })
    const newer = machine.step(first, eventAt(requested, 2))
    const after = machine.step(newer, eventAt(retained.events(retained.input, 0)[0]!, 3))
    expect(machine.output(after).view).toEqual(guarded
      ? { pending: "same-id", finished: [] }
      : { pending: undefined, finished: [{ id: "same-id", value: 7 }] })
  }
})
