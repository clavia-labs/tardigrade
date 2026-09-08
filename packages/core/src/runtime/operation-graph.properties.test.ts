import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import { component, composeComponents, transitionProjectionOf, type TransitionContext } from "../component"
import type { Event } from "../event"
import { sameInvocation, type InvocationRef } from "../interaction/invocation"
import { EventLog, withWatermark } from "../log"
import { createActorReconciler, enabled, EffectInterruptions, effectInterruptionRegistry } from "./reconciler"

type Defect = "none" | "any-prerequisite" | "provider-id" | "dependency-cancellation" | "reanchor"
type Crash = "before-effect" | "after-effect" | "after-commit"
interface Node { readonly id: number; readonly root: number; readonly tag: string; readonly owner: number; readonly needs: ReadonlyArray<number> }
interface Interleave { readonly point: "before-start" | "during-effect" | "before-append"; readonly kind: "noise" | "own-cancel" | "other-cancel" }
interface Command { readonly action: "attempt" | "cancel" | "replay" | "noise"; readonly choice: number; readonly point: Crash; readonly reverse: boolean; readonly owner: number }
interface Operation { readonly scope: string; readonly id: number; readonly value: number }
interface Model { readonly completed: Map<string, number>; readonly cancelled: Set<string> }
const idOf = (scope: string, id: number): string => `${scope}/${id}`
const invocation = (scope: string, epoch: number): InvocationRef => ({ method: "run", id: scope, epoch })
const ownerKey = (scope: string, epoch: number): string => `${scope}/${epoch}`

const graphArbitrary = fc.tuple(
  fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 7, maxLength: 7 }),
  fc.array(fc.record({ root: fc.integer({ min: 0, max: 1 }), owner: fc.integer({ min: 0, max: 1 }), needs: fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }) }), { minLength: 4, maxLength: 7 })
).map(([tags, nodes]): Node[] => nodes.map((node, id) => ({
  id, tag: tags[id]!,
  root: id < 3 ? 0 : id === 3 ? 1 : node.root,
  owner: id < 4 ? id % 2 : node.owner,
  needs: id === 2 ? [0, 1] : id < 4 ? [] : node.needs.flatMap((included, dependency) => included && dependency < id ? [dependency] : [])
})))

const oracle = (nodes: ReadonlyArray<Node>, scopes: ReadonlyArray<string>, model: Model): Operation[] =>
  scopes.flatMap((scope) => nodes.flatMap((node) => {
    if (model.completed.has(idOf(scope, node.id)) || model.cancelled.has(ownerKey(scope, node.owner)) ||
      node.needs.some((dependency) => !model.completed.has(idOf(scope, dependency)))) return []
    return [{ scope, id: node.id, value: node.id + 1 + node.needs.reduce((sum, dependency) => sum + model.completed.get(idOf(scope, dependency))!, 0) }]
  }))

const harness = (nodes: ReadonlyArray<Node>, scopes: ReadonlyArray<string>, defect: Defect) => {
  const events: Event[] = []
  const roots = new Map<number, number>()
  const attempts: Operation[] = []
  const performed: Operation[] = []
  let crash: Crash = "after-commit"
  const stop = () => { throw new Error("simulated pause") }
  const registry = effectInterruptionRegistry()
  let interleave: Interleave | undefined
  const inject = (point: Interleave["point"]): void => {
    if (interleave?.point !== point) return
    const event: Event = interleave.kind === "noise" ? { type: "Unrelated" } : {
      type: "CancellationRequested", request: "interleaved", cause: "requested",
      invocation: invocation(scopes[0]!, interleave.kind === "own-cancel" ? 0 : 1)
    }
    interleave = undefined
    events.push(event)
    registry.interrupt([event])
  }
  for (const scope of scopes) for (const epoch of [0, 1]) {
    events.push({ type: "Accepted", call: { invocation: invocation(scope, epoch), deadlineAt: 1000 } })
  }
  for (const root of [0, 1]) {
    events.push({ type: "Unrelated" }, { type: "Requested", root, callId: "7" })
    roots.set(root, events.length)
  }
  const makeActor = (members = scopes, order = nodes, grouped = false) => {
    const components = members.map((scope) => component({
      name: scope,
      initial: () => ({ roots: new Map<number, TransitionContext>(), history: [] as ReadonlyArray<{ event: Event; ctx: TransitionContext }> }),
      step: (state, event, ctx) => ({
        roots: event.type === "Requested" ? new Map(state.roots).set(event.root as number, ctx) : state.roots,
        history: [...state.history, { event, ctx }]
      }),
      output: (state) => {
        const receipts = new Map<number, { event: Event; ctx: TransitionContext }>()
        for (const node of nodes) {
          const ctx = state.roots.get(node.root)
          const receipt = ctx === undefined ? undefined : state.history.find(({ event }) => defect === "provider-id"
            ? event.type === "Completed" && event.callId === "7" : ctx.matches(node.tag, event))
          if (receipt !== undefined) receipts.set(node.id, receipt)
        }
        return {
          view: undefined,
          transitions: order.flatMap((node) => {
            const original = state.roots.get(node.root)
            if (original === undefined || receipts.has(node.id)) return []
            const ready = node.needs.length === 0 || (defect === "any-prerequisite"
              ? node.needs.some((dependency) => receipts.has(dependency))
              : node.needs.every((dependency) => receipts.has(dependency)))
            if (!ready) return []
            if (defect === "dependency-cancellation" && node.needs.some((dependency) =>
              state.history.some(({ event }) => event.type === "CancellationRequested" &&
                sameInvocation(event.invocation as InvocationRef, invocation(scope, nodes[dependency]!.owner))))) return []
            const ctx = defect === "reanchor" && node.needs.length > 0 ? receipts.get(node.needs[0]!)!.ctx : original
            const input = { scope, id: node.id, value: node.id + 1 + node.needs.reduce((sum, dependency) => sum + Number(receipts.get(dependency)?.event.value ?? 0), 0) }
            return [ctx.effect(node.tag, {
              invocation: invocation(scope, node.owner), input,
              act: (operation) => Effect.sync(() => {
                attempts.push(operation)
                if (crash === "before-effect") stop()
                performed.push(operation)
                inject("during-effect")
                if (crash === "after-effect") stop()
                return { type: "Completed", ...operation, callId: "7" }
              })
            })]
          })
        }
      }
    }))
    const mounted = grouped ? [composeComponents("group", { empty: undefined, combine: () => undefined }, components)] : components
    return { projections: mounted.map(transitionProjectionOf), keyOf: () => undefined, cancellationOf: () => "running" as const }
  }
  const log = Layer.succeed(EventLog, {
    ...withWatermark({
      read: Effect.sync(() => [...events]),
      append: (tail) => Effect.sync(() => { inject("before-append"); events.push(...tail); stop() })
    }),
    head: Effect.sync(() => { inject("before-start"); return events.length })
  })
  return {
    events, roots, attempts, performed, makeActor,
    restart: () => {
      const restored: Event[] = JSON.parse(JSON.stringify(events))
      events.splice(0, events.length, ...restored)
    },
    attempt: async (operation: Operation, point: Crash, reverse: boolean) => {
      crash = point
      const members = [...scopes].sort((a, b) => Number(b === operation.scope) - Number(a === operation.scope))
      const order = (reverse ? [...nodes].reverse() : [...nodes]).sort((a, b) => Number(b.id === operation.id) - Number(a.id === operation.id))
      await expect(Effect.runPromise(createActorReconciler(makeActor(members, order)).settle.pipe(Effect.provide(log))))
        .rejects.toThrow("simulated pause")
    },
    settle: () => Effect.runPromise(createActorReconciler(makeActor()).settle.pipe(Effect.provide(log))),
    interleaved: async (change: Interleave) => {
      interleave = change
      crash = "after-commit"
      try {
        await Effect.runPromise(createActorReconciler(makeActor()).settle.pipe(
          Effect.provide(log), Effect.provideService(EffectInterruptions, registry)
        ))
      } catch (error) {
        if (!String(error).includes("simulated pause")) throw error
      }
    }
  }
}
type Harness = ReturnType<typeof harness>

// assertGraph compares operation eligibility, data, refs, and lifetime against an independent graph oracle (tla/runtime/OperationGraph.tla).
const assertGraph = (nodes: ReadonlyArray<Node>, scopes: ReadonlyArray<string>, model: Model, real: Harness): void => {
  const expected = oracle(nodes, scopes, model)
  const variants = [real.makeActor(), real.makeActor([...scopes].reverse(), [...nodes].reverse(), true)]
  for (const actor of variants) {
    const transitions = enabled(actor, real.events)
    const actual = transitions.map((transition) => idOf((transition.input as Operation).scope, (transition.input as Operation).id)).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected.map((operation) => idOf(operation.scope, operation.id)).sort())) {
      throw new Error("operation graph eligibility mismatch")
    }
    for (const transition of transitions) {
      const input = transition.input as Operation
      const node = nodes[input.id]!
      expect(input).toEqual(expected.find((operation) => operation.scope === input.scope && operation.id === input.id)!)
      if (transition.key !== JSON.stringify([real.roots.get(node.root), input.scope, node.tag])) throw new Error("operation graph identity changed")
      expect(transition.invocation).toEqual(invocation(input.scope, node.owner))
    }
  }
  const alone = enabled(real.makeActor([scopes[0]!]), real.events).map((transition) => transition.key).sort()
  const together = enabled(real.makeActor(), real.events).filter((transition) => (transition.input as Operation).scope === scopes[0]).map((transition) => transition.key).sort()
  expect(alone).toEqual(together)
}

const cancel = (scope: string, owner: number, model: Model, real: Harness): void => {
  real.events.push({ type: "CancellationRequested", request: `stop/${scope}/${owner}`, invocation: invocation(scope, owner), cause: "requested" })
  model.cancelled.add(ownerKey(scope, owner))
}

const advance = async (nodes: ReadonlyArray<Node>, scopes: ReadonlyArray<string>, model: Model, real: Harness, selected: Operation, point: Crash, reverse: boolean): Promise<void> => {
  const before = { log: real.events.length, attempts: real.attempts.length, performed: real.performed.length }
  await real.attempt(selected, point, reverse)
  expect(real.attempts).toHaveLength(before.attempts + 1)
  expect(real.attempts.at(-1)).toEqual(selected)
  expect(real.performed).toHaveLength(before.performed + (point === "before-effect" ? 0 : 1))
  expect(real.events).toHaveLength(before.log + (point === "after-commit" ? 1 : 0))
  if (point === "after-commit") {
    const node = nodes[selected.id]!
    expect(real.events.at(-1)).toEqual({
      type: "Completed", ...selected, callId: "7",
      transitionRef: { seq: real.roots.get(node.root)!, component: selected.scope, tag: node.tag },
      invocationRef: invocation(selected.scope, node.owner)
    })
    expect(model.completed.has(idOf(selected.scope, selected.id))).toBe(false)
    model.completed.set(idOf(selected.scope, selected.id), selected.value)
  }
  assertGraph(nodes, scopes, model, real)
}

const traceArbitrary = fc.array(fc.record({
  action: fc.constantFrom<Command["action"]>("attempt", "cancel", "replay", "noise"), choice: fc.nat({ max: 20 }),
  point: fc.constantFrom<Crash>("before-effect", "after-effect", "after-commit"), reverse: fc.boolean(), owner: fc.integer({ min: 0, max: 1 })
}), { maxLength: 12 })

const exercise = async (nodes: ReadonlyArray<Node>, trace: ReadonlyArray<Command>, defect: Defect): Promise<void> => {
  const scopes = ["files", "observer"]
  const model: Model = { completed: new Map(), cancelled: new Set() }
  const real = harness(nodes, scopes, defect)
  assertGraph(nodes, scopes, model, real)
  for (const id of [0, 1]) {
    const selected = oracle(nodes, scopes, model).find((operation) => operation.scope === "files" && operation.id === id)!
    await advance(nodes, scopes, model, real, selected, "after-effect", false)
    real.restart()
    await advance(nodes, scopes, model, real, selected, "after-commit", true)
  }
  cancel("files", 1, model, real)
  assertGraph(nodes, scopes, model, real)
  for (const command of trace) {
    const ready = oracle(nodes, scopes, model)
    if (command.action === "cancel") cancel(scopes[command.choice % scopes.length]!, command.owner, model, real)
    else if (command.action === "replay") real.restart()
    else if (command.action === "noise") real.events.push({ type: "Unrelated", value: command.choice })
    else if (ready.length > 0) await advance(nodes, scopes, model, real, ready[command.choice % ready.length]!, command.point, command.reverse)
    assertGraph(nodes, scopes, model, real)
  }
  while (oracle(nodes, scopes, model).length > 0) {
    await advance(nodes, scopes, model, real, oracle(nodes, scopes, model)[0]!, "after-commit", false)
  }
  const before = { log: [...real.events], attempts: [...real.attempts] }
  real.restart()
  await real.settle()
  expect(real.events).toEqual(before.log)
  expect(real.attempts).toEqual(before.attempts)
}

test("operation graphs preserve prerequisites, identity, and invocation lifetime through composition and recovery", async () => {
  await fc.assert(fc.asyncProperty(graphArbitrary, traceArbitrary, (nodes, trace) => exercise(nodes, trace, "none")), { numRuns: 60 })
}, 30_000)

test("operation graph controls expose premature work, miscorrelation, dependency cancellation, and reanchoring", async () => {
  for (const defect of ["any-prerequisite", "provider-id", "dependency-cancellation", "reanchor"] as const) {
    const result = await fc.check(fc.asyncProperty(graphArbitrary, (nodes) => exercise(nodes, [], defect)), { numRuns: 1 })
    expect(result.failed).toBe(true)
    expect(String(result.errorInstance)).toContain(defect === "reanchor" ? "operation graph identity changed" : "operation graph eligibility mismatch")
  }
})


test("valid graph schedules preserve domain results when independent components are added", async () => {
  await fc.assert(fc.asyncProperty(graphArbitrary, async (nodes) => {
    const results: Array<ReadonlyArray<[string, number]>> = []
    for (const scopes of [["files"], ["observer", "files"]]) {
      const model: Model = { completed: new Map(), cancelled: new Set() }
      const real = harness(nodes, scopes, "none")
      while (oracle(nodes, scopes, model).length > 0) {
        const ready = oracle(nodes, scopes, model)
        const selected = scopes.length === 1 ? ready[0]! : ready.at(-1)!
        await advance(nodes, scopes, model, real, selected, "after-commit", scopes.length > 1)
        real.restart()
      }
      results.push([...model.completed].filter(([id]) => id.startsWith("files/")).sort(([a], [b]) => a.localeCompare(b)))
    }
    expect(results[0]).toEqual(results[1]!)
  }), { numRuns: 30 })
}, 30_000)

test("cancellation publication follows the observed result check while unrelated appends remain compatible", async () => {
  for (const point of ["before-start", "during-effect", "before-append"] as const) {
    for (const kind of ["noise", "own-cancel", "other-cancel"] as const) {
      const nodes: Node[] = [{ id: 0, root: 0, owner: 0, tag: "execute", needs: [] }]
      const real = harness(nodes, ["files"], "none")
      await real.interleaved({ point, kind })
      const starts = kind === "own-cancel" && point === "before-start" ? 0 : 1
      const commits = kind === "own-cancel" && point !== "before-append" ? 0 : 1
      expect(real.attempts).toHaveLength(starts)
      expect(real.events.filter((event) => event.type === "Completed")).toHaveLength(commits)
      const before = { events: [...real.events], attempts: [...real.attempts] }
      real.restart()
      await real.settle()
      expect(real.events).toEqual(before.events)
      expect(real.attempts).toEqual(before.attempts)
    }
  }
})
