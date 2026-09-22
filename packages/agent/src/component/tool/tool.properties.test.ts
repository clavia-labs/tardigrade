import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect, Layer } from "effect"
import { actor, component } from "@clavia/tardigrade-core/actor"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayState } from "@clavia/tardigrade-core/projection"
import { testMachineOf } from "../../../fixtures/component"
import { AGENT_VIEW_ALGEBRA, type ToolOffer } from "../view"
import { toolCallOf, toolComponent } from "./machine"

import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { tools } from "./index"
import { agentKeys } from "../../log/events"
import { toolResultPosition } from "../../log/tool"

type Mode = "allow" | "hold" | "reject"
type Call = { turn: string; callId: string; binding: number; value: number }
type Completion = { call: Call; result: unknown; events: ReadonlyArray<Event> }
const identity = (call: { turn?: string; callId: string }) => `${call.turn}/${call.callId}`
const resultOf = (call: Call) => ({ binding: call.binding, value: call.value })

const command = fc.oneof(
  fc.record({ kind: fc.constant("request"), turn: fc.nat(2), id: fc.nat(3), value: fc.integer() }),
  fc.record({ kind: fc.constant("offer"), turn: fc.nat(2), binding: fc.nat(4) }),
  fc.record({ kind: fc.constant("policy"), mode: fc.constantFrom<Mode>("allow", "hold", "reject") }),
  fc.record({ kind: fc.constant("perform"), index: fc.nat(8) }),
  fc.record({ kind: fc.constant("commit"), index: fc.nat(8) }),
  fc.record({ kind: fc.constant("cancel"), turn: fc.nat(2) }),
  fc.record({ kind: fc.constant("restart") }),
  fc.record({ kind: fc.constant("unrelated") })
)

test("tool requests preserve routing and settlement through policy changes and replay", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(command, { maxLength: 50 }), async (commands) => {
      const executions: string[] = []
      const expectedExecutions: string[] = []
      const offers = new Map<string, number>()
      const pending = new Map<string, Call>()
      const requested = new Set<string>()
      const completions = new Map<string, Completion>()
      const finished = new Map<string, unknown>()
      const log: Event[] = []
      let mode: Mode = "allow"
      const source = component({
        name: "offers",
        initial: () => 0,
        step: (binding, event) => (event.type === "OfferChanged" ? Number(event.binding) : binding),
        output: (binding) => {
          const offer: ToolOffer = {
            spec: { name: "read", description: `binding ${binding}`, inputSchema: {} },
            serve: (call) => [
              call.context.effect("run", {
                input: undefined,
                act: () =>
                  Effect.sync(() => {
                    executions.push(identity(call))
                    const result = { binding, value: call.arguments }
                    return [{ type: "ToolReturned", turn: call.turn, callId: call.callId, result }]
                  })
              })
            ]
          }
          return {
            view: { ...AGENT_VIEW_ALGEBRA.empty, tools: [{ spec: offer.spec }] },
            interactions: { tools: () => [offer] },
            transitions: []
          }
        }
      })
      const governed = component({
        name: "policy",
        children: toolComponent(source),
        initial: (): Mode => "allow",
        step: (state, event) => (event.type === "PolicyChanged" ? (event.mode as Mode) : state),
        output: (state, child) => {
          const output = child.output()
          return {
            ...output,
            transitions: state === "hold"
              ? []
              : state === "allow"
                ? output.transitions
                : output.transitions.map((work) => work.respond!({ error: "denied" }))
          }
        },

      })
      const machine = testMachineOf(governed)
      let state = machine.initial()
      const append = (event: Event) => {
        log.push(event)
        state = machine.step(state, eventAt(event, log.length))
      }
      const offer = (turn: number, binding: number) => {
        const id = `turn-${turn}`
        append({ type: "OfferChanged", binding })
        append({ type: "ModelCalled", turn: id, callId: `model-${log.length}` })
        offers.set(id, binding)
      }
      const request = (turn: number, id: number, value: number) => {
        const call = { turn: `turn-${turn}`, callId: `call-${id}`, binding: offers.get(`turn-${turn}`)!, value }
        const key = identity(call)
        if (requested.has(key)) return
        requested.add(key)
        pending.set(key, call)
        append({ type: "ToolCalled", turn: call.turn, callId: call.callId, name: "read", arguments: value })
      }
      const policy = (next: Mode) => {
        mode = next
        append({ type: "PolicyChanged", mode })
      }
      const perform = async (index: number) => {
        const eligible = [...pending.values()].filter((call) => !completions.has(identity(call)))
        if (mode === "hold" || eligible.length === 0) return
        const call = eligible[index % eligible.length]!
        const output = machine.output(state)
        const work = output.transitions.find((work) => {
          if (work.kind === "intent")
            return work.events(work.input, 0).some((event) => event.turn === call.turn && event.callId === call.callId)
          const target = toolCallOf(work)
          return target !== undefined && identity(target) === identity(call)
        })
        expect(work).toBeDefined()
        if (work === undefined) throw new Error("missing proposed work")
        const result = mode === "reject" ? { error: "denied" } : resultOf(call)
        if (mode === "allow") expectedExecutions.push(identity(call))
        const events =
          work.kind === "intent"
            ? work.events(work.input, 0)
            : await Effect.runPromise(
                work.act(work.input, new AbortController().signal).pipe(
                  Effect.provideService(
                    EventLog,
                    withWatermark({
                      read: Effect.succeed(log),
                      append: () => Effect.die("fixture effects must return their completion")
                    })
                  )
                )
              )
        expect(events).toMatchObject([{ type: "ToolReturned", turn: call.turn, callId: call.callId, result }])
        completions.set(identity(call), { call, result, events })
        expect(machine.output(state)).toBe(output)
      }
      const commit = (index: number) => {
        const candidates = [...completions.values()]
        if (candidates.length === 0) return
        const completion = candidates[index % candidates.length]!
        const key = identity(completion.call)
        completion.events.forEach(append)
        pending.delete(key)
        completions.delete(key)
        finished.set(key, completion.result)
      }
      const cancel = (turn: number) => {
        const id = `turn-${turn}`
        const calls = [...pending.values()].filter((call) => call.turn === id)
        const before = machine.output(state)
        const work = machine.output(state).interactions!.cancel!({
          request: `cancel-${log.length}`,
          invocation: { method: "message", id, epoch: 0 },
          cause: "requested"
        })
        const events = work.flatMap((work) => {
          if (work.kind !== "intent") throw new Error("cleanup must propose completion")
          return work.events(work.input, 0)
        })
        expect(events.map((event) => event.callId).sort()).toEqual(calls.map((call) => call.callId).sort())
        expect(machine.output(state)).toBe(before)
        events.forEach(append)
        for (const call of calls) {
          pending.delete(identity(call))
          completions.delete(identity(call))
          finished.set(identity(call), { error: "cancelled" })
        }
      }
      const check = () => {
        const output = machine.output(state)
        expect(output.view.pendingCalls.map(identity).sort()).toEqual([...pending.keys()].sort())
        expect(output.transitions).toHaveLength(mode === "hold" ? 0 : pending.size)
        expect(executions).toEqual(expectedExecutions)
        const actualResults = log
          .filter((event) => event.type === "ToolReturned" && event.turn !== "foreign")
          .map((event): [string, unknown] => [
            identity({ turn: String(event.turn), callId: String(event.callId) }),
            event.result
          ])
        const byIdentity = ([left]: [string, unknown], [right]: [string, unknown]) => left.localeCompare(right)
        expect(actualResults.sort(byIdentity)).toEqual([...finished.entries()].sort(byIdentity))
        const replayed = machine.output(replayState(machine, log))
        expect(replayed.view).toEqual(output.view)
        expect(replayed.transitions.map((work) => [work.key, work.kind])).toEqual(
          output.transitions.map((work) => [work.key, work.kind])
        )
      }
      for (let turn = 0; turn < 3; turn++) {
        append({ type: "MessageReceived", id: `turn-${turn}`, text: "read" })
        offer(turn, turn)
      }
      request(0, 0, 7)
      request(1, 0, 8)
      offer(0, 4)
      offer(1, 4)
      policy("hold")
      await perform(0)
      check()
      policy("reject")
      await perform(0)
      check()
      commit(0)
      policy("allow")
      await perform(0)
      check()
      commit(0)
      for (const action of commands) {
        switch (action.kind) {
          case "request":
            request(action.turn, action.id, action.value)
            break
          case "offer":
            offer(action.turn, action.binding)
            break
          case "policy":
            policy(action.mode)
            break
          case "perform":
            await perform(action.index)
            break
          case "commit":
            commit(action.index)
            break
          case "cancel":
            cancel(action.turn)
            break
          case "restart":
            state = replayState(machine, log)
            break
          case "unrelated":
            append({ type: "ToolReturned", turn: "foreign", callId: "call-0", result: "unrelated" })
            break
        }
        check()
      }
      policy("allow")
      while (pending.size > 0) {
        await perform(0)
        commit(0)
        check()
      }
      state = replayState(machine, log)
      check()
      expect(finished.size).toBe(requested.size)
      expect(machine.output(state).transitions).toEqual([])
    }),
    { numRuns: 100 }
  )
}, 30_000)

test.each(["allow", "reject"] as const)(
  "runtime settles a held native tool after %s without duplicate execution",
  async (decision) => {
    let executions = 0
    const child = tools({
      spec: { name: "read", description: "read", inputSchema: {} },
      run: () =>
        Effect.sync(() => {
          executions++
          return { value: 42 }
        })
    })
    const parent = component({
      name: "gate",
      children: child,
      initial: (): Mode => "hold",
      step: (state, event) => (event.type === "Released" ? decision : state),
      output: (state, child) => {
        const output = child.output()
        return {
          ...output,
          transitions:
            state === "hold"
              ? []
              : state === "allow"
                ? output.transitions
                : output.transitions.map((work) => work.respond!({ error: "denied" }))
        }
      }
    })
    const definition = actor({ name: "tools-test", methods: {}, components: [{ ...parent, keys: agentKeys }] })
    const log: Event[] = [
      { type: "MessageReceived", id: "turn", text: "read" },
      { type: "ToolCalled", turn: "turn", callId: "call", name: "read", arguments: {} }
    ]
    const environment = Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          read: Effect.sync(() => [...log]),
          append: (events) =>
            Effect.sync(() => {
              log.push(...events)
            })
        })
      ),
      Layer.succeed(Self, threadAddressOf("tools-test", "main", "root")),
      Layer.succeed(Router, { send: () => Effect.void })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* settleActor(definition)
        expect(executions).toBe(0)
        expect(log).toHaveLength(2)
        log.push({ type: "Released" })
        yield* settleActor(definition)
        expect(executions).toBe(decision === "allow" ? 1 : 0)
        expect(log.filter((event) => event.type === "ToolReturned")).toMatchObject([
          { turn: "turn", callId: "call", result: decision === "allow" ? { value: 42 } : { error: "denied" } }
        ])
        log.push(
          { type: "ToolCalled", turn: "turn", callId: "call", name: "read", arguments: {} },
          { type: "MessageReceived", id: "other", text: "read again" },
          { type: "ToolCalled", turn: "other", callId: "call", name: "read", arguments: {} }
        )
        yield* settleActor(definition)
        expect(log.filter(event => event.type === "ToolReturned")).toHaveLength(3)
        const settled = [...log]
        yield* settleActor(definition)
        expect(log).toEqual(settled)
        expect(executions).toBe(decision === "allow" ? 3 : 0)
      }).pipe(Effect.provide(environment))
    )
  }
)

test("responses settle only their request occurrence despite reused labels, late delivery and replay", () => {
  fc.assert(fc.property(
    fc.array(fc.record({ turn: fc.nat(1), epoch: fc.nat(2) }), { minLength: 2, maxLength: 12 }),
    fc.array(fc.nat(50), { maxLength: 25 }),
    (requests, deliveries) => {
      const machine = testMachineOf(tools({
        spec: { name: "read", description: "Read", inputSchema: {} },
        run: () => Effect.die("responses must not execute the tool")
      }))
      const log: Event[] = []
      let state = machine.initial()
      const append = (event: Event) => {
        const positioned = eventAt(event, log.length + 1)
        log.push(positioned)
        state = machine.step(state, positioned)
      }
      const pending = new Set<number>()
      const callbacks = requests.map(({ turn, epoch }) => {
        append({ type: "ToolCalled", callId: "reused", name: "read", arguments: {}, turn: `turn-${turn}`, epoch })
        const position = log.length
        pending.add(position)
        const proposal = machine.output(state).transitions.find(work => toolCallOf(work)?.position === position)!
        return { position, respond: proposal.respond! }
      })
      const replies = callbacks.map(({ position, respond }) => {
        const before = machine.output(state)
        const response = respond({ source: position })
        expect(machine.output(state)).toBe(before)
        const events = response.events(response.input, 0)
        expect(events.map(toolResultPosition)).toEqual([position])
        return { position, respond, key: response.key, events }
      })
      expect(new Set(replies.map(reply => reply.key)).size).toBe(requests.length)
      const check = () => {
        const output = machine.output(state)
        expect(output.view.pendingCalls.map(call => call.position).sort((a, b) => a - b))
          .toEqual([...pending].sort((a, b) => a - b))
        const replayed = machine.output(replayState(machine, log))
        expect(replayed.view).toEqual(output.view)
        expect(replayed.transitions.map(work => work.key)).toEqual(output.transitions.map(work => work.key))
      }
      append({ type: "ToolReturned", callId: "reused", turn: `turn-${requests[0]!.turn}`, result: "unstamped" })
      check()
      for (const index of [...deliveries, ...replies.map((_, index) => index)]) {
        const reply = replies[index % replies.length]!
        const response = reply.respond({ source: reply.position })
        expect(response.key).toBe(reply.key)
        const events = response.events(response.input, 0)
        expect(events).toEqual(reply.events)
        events.forEach(append)
        pending.delete(reply.position)
        check()
      }
      expect(pending.size).toBe(0)
    }
  ), { numRuns: 100 })
}, 30_000)
