import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import { testMachineOf } from "../../../fixtures/component"
import { tool } from "../tool/index"
import { toolCallOf } from "../tool/machine"
import { permissions } from "./index"

type Decision = "grant" | "deny" | "fail"
const request = fc.record({
  protected: fc.boolean(),
  decision: fc.constantFrom<Decision>("grant", "deny", "fail"),
  order: fc.nat(20)
})

test("permission decisions govern only matching calls and replay preserves settled outcomes", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(request, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 3 }),
      (rounds) => {
        let executions = 0
        const inspected: string[] = []
        const child = tool({
          spec: { name: "work", description: "work", inputSchema: {} },
          run: () =>
            Effect.sync(() => {
              executions++
              return "done"
            })
        })
        const machine = testMachineOf(
          permissions(child, {
            request: (work) => {
              const call = toolCallOf(work)!
              inspected.push(`${call.turn}/${call.callId}`)
              return call.arguments === "write" ? { action: "write", resource: "/file", reason: "modify" } : undefined
            },
            onDenied: (reason, respond, work) => respond({ refused: toolCallOf(work)!.callId, reason })
          })
        )
        const log: Event[] = []
        let state = machine.initial()
        const append = (event: Event) => {
          log.push(event)
          state = machine.step(state, eventAt(event, log.length))
        }
        for (const [round, requests] of rounds.entries()) {
          const turn = `turn-${round}`
          const pending = new Set(requests.map((_, id) => `call-${id}`))
          const decisions = new Map<string, Decision>()
          const admitted = new Set<string>()
          const check = () => {
            const output = machine.output(state)
            expect(output.view.pendingCalls.map((call) => call.callId).sort()).toEqual([...pending].sort())
            expect(output.view.permissions.filter(permission => permission.invocation?.id === turn && permission.status === "allowed")).toHaveLength(admitted.size)
            const effects = output.transitions.filter((work) => work.kind === "effect")
            const allowed = requests.flatMap((request, id) => {
              const key = `call-${id}`
              return pending.has(key) && (!request.protected || decisions.get(key) === "grant") ? [key] : []
            })
            expect(effects.map((work) => toolCallOf(work)?.callId).sort()).toEqual(allowed.sort())
            const responses = output.transitions.flatMap((work) =>
              work.kind === "intent" ? work.events(work.input, 0) : []
            )
            const denied = requests.flatMap((request, id) => {
              const key = `call-${id}`
              const decision = decisions.get(key)
              if (!pending.has(key) || !request.protected || decision === undefined || decision === "grant") return []
              return [
                {
                  callId: key,
                  result: {
                    refused: key,
                    reason: decision === "deny" ? "private" : "Permission authority failed: unavailable"
                  }
                }
              ]
            })
            expect(
              responses
                .map(({ callId, result }) => ({ callId, result }))
                .sort((a, b) => String(a.callId).localeCompare(String(b.callId)))
            ).toEqual(denied.sort((a, b) => a.callId.localeCompare(b.callId)))
            const replayed = machine.output(replayState(machine, log))
            expect(replayed.view).toEqual(output.view)
            expect(replayed.transitions.map((work) => [work.key, work.kind])).toEqual(
              output.transitions.map((work) => [work.key, work.kind])
            )
            expect(executions).toBe(0)
          }
          append({ type: "MessageReceived", id: turn, text: "work" })
          const positions = new Map<string, number>()
          requests.forEach((request, id) => {
            positions.set(`call-${id}`, log.length + 1)
            append({
              type: "ToolCalled",
              turn,
              callId: `call-${id}`,
              name: "work",
              arguments: request.protected ? "write" : "read"
            })
            if (!request.protected) admitted.add(`call-${id}`)
          })
          check()
          append({ type: "PermissionRequestDecided", callId: `permission/999999`, granted: true })
          check()
          for (const { request, id } of requests
            .map((request, id) => ({ request, id }))
            .sort((a, b) => a.request.order - b.request.order)) {
            if (!request.protected) continue
            const key = `call-${id}`
            decisions.set(key, request.decision)
            append(
              request.decision === "fail"
                ? { type: "PermissionRequestFailed", callId: `permission/${JSON.stringify([positions.get(key), "tools.dispatch", "answer"])}`, error: "unavailable" }
                : {
                    type: "PermissionRequestDecided",
                    callId: `permission/${JSON.stringify([positions.get(key), "tools.dispatch", "answer"])}`,
                    granted: request.decision === "grant",
                    reason: "private"
                  }
            )
            if (request.decision === "grant") admitted.add(key)
            check()
            state = replayState(machine, log)
            check()
          }
          const output = machine.output(state)
          const completions = output.transitions.map((work) => (work.kind === "intent" ? work : work.respond!("done")))
          check()
          for (const completion of completions) {
            const events = completion.events(completion.input, 0)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({ type: "ToolReturned", turn })
            expect(pending.delete(String(events[0]!.callId))).toBe(true)
            events.forEach(append)
            check()
          }
          expect(pending.size).toBe(0)
          expect(machine.output(state).transitions).toEqual([])
          const before = inspected.length
          append({ type: "Unrelated" })
          expect(inspected).toHaveLength(before)
          append({ type: "TurnCompleted", turn, output: "done" })
        }
      }
    ),
    { numRuns: 100, includeErrorInReport: true }
  )
}, 30_000)
