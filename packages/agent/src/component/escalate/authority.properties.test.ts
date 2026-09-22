import { expect, test } from "bun:test"
import fc from "fast-check"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import { testMachineOf } from "../../../fixtures/component"
import type { AuthorityComponent } from "./authority"
import { escalate } from "./index"

const commands = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant("receive"), id: fc.nat(5) }),
    fc.record({ kind: fc.constant("respond"), id: fc.nat(6), approve: fc.boolean() }),
    fc.record({ kind: fc.constant("commit"), index: fc.nat(5) }),
    fc.record({ kind: fc.constant("restart") })
  ),
  { maxLength: 35 }
)

const lifecycle = <Input, Decision>(
  authority: AuthorityComponent<Input, Decision>,
  manual: boolean,
  request: (id: string) => Event,
  decision: (approve: boolean) => Decision,
  outcome: (id: string, approve: boolean) => object,
  prefix: string
) => {
  fc.assert(
    fc.property(commands, (actions) => {
      const machine = testMachineOf(authority)
      let state = machine.initial()
      const log: Event[] = []
      const pending = new Set<string>()
      const settled = new Set<string>()
      const staged = new Map<string, ReadonlyArray<Event>>()
      const append = (event: Event) => {
        log.push(event)
        state = machine.step(state, eventAt(event, log.length))
      }
      const receive = (id: string) => {
        append(request(id))
        if (!settled.has(id)) pending.add(id)
      }
      const respond = (id: string, approve: boolean) => {
        const output = machine.output(state)
        const selected = manual ? id : [...pending][0]
        const work = manual ? output.interactions!.respond(id, decision(approve)) : output.transitions[0]
        if (selected === undefined || !pending.has(selected)) expect(work).toBeUndefined()
        else {
          if (work?.kind !== "intent") throw new Error("expected decision intent")
          const events = work.events(work.input, 1)
          expect(events).toMatchObject([outcome(selected, manual ? approve : true)])
          expect(authority.keys!.keyOf(events[0]!)).toBe(`${prefix}:${selected}`)
          staged.set(selected, events)
        }
        expect(machine.output(state)).toBe(output)
      }
      const commit = (index: number) => {
        const entries = [...staged.entries()]
        if (entries.length === 0) return
        const [id, events] = entries[index % entries.length]!
        events.forEach(append)
        staged.delete(id)
        pending.delete(id)
        settled.add(id)
      }
      const check = () => {
        const output = machine.output(state)
        expect(output.view.pending.map((request) => request.id)).toEqual([...pending])
        expect(output.transitions).toHaveLength(manual || pending.size === 0 ? 0 : 1)
        for (const id of settled) expect(output.interactions!.respond(id, decision(true))).toBeUndefined()
        const replayed = machine.output(replayState(machine, log))
        expect(replayed.view).toEqual(output.view)
        expect(replayed.transitions.map((work) => work.key)).toEqual(output.transitions.map((work) => work.key))
      }
      receive("0")
      receive("1")
      respond("1", false)
      check()
      for (const action of actions) {
        switch (action.kind) {
          case "receive":
            receive(String(action.id))
            break
          case "respond":
            respond(String(action.id), action.approve)
            break
          case "commit":
            commit(action.index)
            break
          case "restart":
            state = replayState(machine, log)
            break
        }
        check()
      }
      while (pending.size > 0) {
        respond([...pending][0]!, true)
        commit(0)
        check()
      }
      for (const id of settled) receive(id)
      check()
      expect(machine.output(state).view.pending).toEqual([])
      expect(log.filter((event) => event.callId !== undefined)).toHaveLength(settled.size)
    }),
    { numRuns: 100, includeErrorInReport: true }
  )
}

for (const manual of [false, true]) {
  test(`budget authority (${manual ? "manual" : "local"}) preserves request lifecycles`, () =>
    lifecycle(
      escalate.authority("budget", manual ? "manual" : { decide: (request) => request.grant(1) }),
      manual,
      (id) => ({ type: "BudgetRequestReceived", id, request: "call", turn: "turn", amount: 2, reason: "finish" }),
      (approve) => (approve ? { granted: 1 } : { denied: true as const, reason: "enough" }),
      (callId, approve) => ({
        type: "BudgetRequestDecided",
        callId,
        grant: approve ? 1 : 0,
        ...(approve ? {} : { reason: "enough" })
      }),
      "ba"
    ))
  test(`permission authority (${manual ? "manual" : "local"}) preserves request lifecycles`, () =>
    lifecycle(
      escalate.authority("permissions", manual ? "manual" : { decide: (request) => request.grant() }),
      manual,
      (id) => ({
        type: "PermissionRequestReceived",
        id,
        request: "call",
        turn: "turn",
        tool: "write",
        action: "write",
        reason: "finish"
      }),
      (approve) => (approve ? { granted: true as const } : { denied: true as const, reason: "private" }),
      (callId, approve) => ({
        type: "PermissionRequestDecided",
        callId,
        granted: approve,
        ...(approve ? {} : { reason: "private" })
      }),
      "pa"
    ))
}
