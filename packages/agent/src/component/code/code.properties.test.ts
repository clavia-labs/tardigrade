import { expect, test } from "bun:test"
import fc from "fast-check"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { testMachineOf } from "../../../fixtures/component"
import { executionRefOf } from "@clavia/tardigrade-code/execution/events"
import { codeMode } from "./index"

const outcome = fc.oneof(
  fc.record({ result: fc.jsonValue() }),
  fc.record({ error: fc.string() }),
  fc.record({ tmp: fc.string(), size: fc.nat(), preview: fc.string(), note: fc.string() })
)

test("code settlements answer the matching tool call and preserve results and logs", () => {
  fc.assert(fc.property(fc.array(fc.record({ outcome, logs: fc.array(fc.string(), { maxLength: 3 }) }), { minLength: 1, maxLength: 5 }), cases => {
    const machine = testMachineOf(codeMode())
    const log: Event[] = []
    const append = (events: ReadonlyArray<Event>) => {
      for (const event of events) log.push(eventAt(event, log.length + 1))
    }
    for (const [index, { outcome, logs }] of cases.entries()) {
      const turn = `turn-${index}`
      append([
        { type: "MessageReceived", id: turn, text: "run", at: log.length },
        { type: "ModelCalled", turn, callId: `model-${index}` },
        { type: "ToolCalled", turn, callId: "reused", name: "execute", arguments: { code: `return ${index}` } }
      ])
      const offered = replayProjection(machine, log)
      const dispatch = offered.transitions[0]
      expect(dispatch?.kind).toBe("intent")
      if (dispatch?.kind !== "intent") throw new Error("Expected code dispatch")
      const events = dispatch.events(dispatch.input, log.length)
      expect(events).toMatchObject([{ type: "CodeDispatched", code: `return ${index}`, turn }])
      append(events)
      const dispatched = log.at(-1)!
      const pending = replayProjection(machine, log)
      expect(pending.transitions.map(work => work.kind)).toEqual(["effect"])
      append([{ type: "CodeSettled", execId: "unrelated", result: "wrong" }])
      expect(replayProjection(machine, log).transitions.map(work => work.kind)).toEqual(["effect"])
      append([{ type: "CodeSettled", execId: dispatched.execId, executionRef: executionRefOf(dispatched), turn, ...outcome, logs }])
      const answered = replayProjection(machine, log).transitions
      expect(answered).toHaveLength(1)
      const answer = answered[0]!
      if (answer.kind !== "intent") throw new Error("Expected tool completion")
      const result = "tmp" in outcome ? { result: outcome } : outcome
      const completed = answer.events(answer.input, log.length)
      expect(completed).toMatchObject([{ type: "ToolReturned", callId: "reused", turn, result: { ...result, ...(logs.length === 0 ? {} : { logs }) } }])
      append(completed)
      expect(replayProjection(machine, log).transitions).toEqual([])
      append([{ type: "TurnCompleted", turn, output: "done" }])
    }
  }), { numRuns: 100 })
})

test("cancellation drains only unsettled executions in the matching invocation", () => {
  fc.assert(fc.property(
    fc.array(fc.record({ turn: fc.nat(2), epoch: fc.nat(2), settled: fc.boolean() }), { maxLength: 15 }),
    fc.nat(2), fc.nat(2),
    (executions, turn, epoch) => {
      const machine = testMachineOf(codeMode())
      let state = machine.initial()
      let position = 0
      const append = (event: Event) => { state = machine.step(state, eventAt(event, ++position)) }
      for (const [index, execution] of executions.entries()) {
        append({ type: "CodeDispatched", execId: `exec-${index}`, code: "return 1", turn: `turn-${execution.turn}`, epoch: execution.epoch })
        if (execution.settled) append({ type: "CodeSettled", execId: `exec-${index}`, result: 1 })
      }
      const expected = executions.flatMap((execution, index) => execution.turn === turn && execution.epoch === epoch && !execution.settled ? [`exec-${index}`] : [])
      const cancellation = { request: "cancel", invocation: { method: "message", id: `turn-${turn}`, epoch }, cause: "requested" as const }
      expect(machine.output(state).interactions?.cancel?.({ ...cancellation, invocation: { ...cancellation.invocation, method: "other" } })).toEqual([])
      for (const execId of expected) {
        const work = machine.output(state).interactions?.cancel?.(cancellation) ?? []
        expect(work).toHaveLength(1)
        const intent = work[0]!
        if (intent.kind !== "intent") throw new Error("Expected cancellation intent")
        const events = intent.events(intent.input, position)
        expect(events).toMatchObject([{ type: "CodeSettled", execId, turn: `turn-${turn}`, error: "cancelled" }])
        for (const event of events) append(event)
      }
      expect(machine.output(state).interactions?.cancel?.(cancellation)).toEqual([])
    }
  ), { numRuns: 100 })
})
