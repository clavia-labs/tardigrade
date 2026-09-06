import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { childKeyOf, type ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { invocationCoordinateKey, invocationIdForKey } from "@clavia/tardigrade-core/interaction/invocation"
import { memoryThreadDirectory, registeredThreadAllocator } from "./allocation"

type Intent = {
  actor: string
  instance: string
  parent?: number
  mode: "name" | "key"
  local: string
}
type Entry = { intent: Intent; target: ThreadCoordinate }
type Model = { entries: Entry[] }

const createReal = () => {
  const store = memoryThreadDirectory()
  let serial = 0
  const policy = { generate: () => `candidate-${serial++}` }
  return { store, policy, allocator: registeredThreadAllocator(store, policy) }
}
type Real = ReturnType<typeof createReal>

// sameIntent compares logical entities independently of the allocator's encoded key (tla/Identity.tla, Key).
const sameIntent = (a: Intent, b: Intent) => a.actor === b.actor && a.instance === b.instance &&
  a.parent === b.parent && a.mode === b.mode && a.local === b.local

const requestOf = (model: Model, intent: Intent): ThreadAllocation => {
  const key = intent.mode === "key" ? { key: intent.local } : {}
  return intent.parent === undefined
    ? { kind: "root", coordinate: { actor: intent.actor, instance: intent.instance, thread: intent.mode === "name" ? intent.local : "" }, ...key }
    : { kind: "child", parent: model.entries[intent.parent]!.target, child: childKeyOf(intent.mode === "name" ? intent.local : "unnamed"), ...key }
}

const references = (target: ThreadCoordinate) => ["read", "write"].flatMap((method) =>
  ["first", "second"].flatMap((id) => [0, 1].map((epoch) => ({ target, invocation: { method, id, epoch } }))))

// verify checks the identity invariants against actual allocator output (tla/Identity.tla).
const verify = (model: Model) => {
  const addresses = model.entries.map(({ target }) => JSON.stringify([target.actor, target.instance, target.thread]))
  expect(new Set(addresses).size).toBe(addresses.length)
  const invocations = model.entries.flatMap(({ target }) => references(target))
  const refs = invocations.map(invocationCoordinateKey)
  expect(new Set(refs).size).toBe(refs.length)
  const calls = invocations.flatMap((ref) => ["call-0", "call-1"].map((key) => invocationIdForKey(ref, key)))
  expect(new Set(calls).size).toBe(calls.length)
  for (const { intent, target } of model.entries) {
    expect([target.actor, target.instance]).toEqual([intent.actor, intent.instance])
    if (intent.parent !== undefined) expect(target.thread).not.toBe(model.entries[intent.parent]!.target.thread)
  }
}

const allocate = async (model: Model, real: Real, intent: Intent) => {
  const expected = model.entries.find((entry) => sameIntent(entry.intent, intent))
  const request = requestOf(model, intent)
  const targets = await Promise.all(Array.from({ length: 3 }, () => Effect.runPromise(real.allocator.allocate(request))))
  for (const target of targets) expect(target).toEqual(expected?.target ?? targets[0]!)
  if (expected === undefined) model.entries.push({ intent, target: targets[0]! })
  verify(model)
}

class Allocate implements fc.AsyncCommand<Model, Real> {
  constructor(readonly intent: Intent, readonly child: boolean, readonly index: number) {}
  check(model: Readonly<Model>) { return !this.child || model.entries.length > 0 }
  async run(model: Model, real: Real) {
    const parent = this.child ? this.index % model.entries.length : undefined
    const owner = parent === undefined ? this.intent : model.entries[parent]!.target
    await allocate(model, real, { ...this.intent, actor: owner.actor, instance: owner.instance, ...(parent === undefined ? {} : { parent }) })
  }
  toString() { return `Allocate(${JSON.stringify(this.intent)}, child=${this.child}, parent=${this.index})` }
}

class Retry implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check(model: Readonly<Model>) { return model.entries.length > 0 }
  async run(model: Model, real: Real) {
    const entry = model.entries[this.index % model.entries.length]!
    const allocator = registeredThreadAllocator(real.store, { generate: () => { throw new Error("retry must recover its assignment") } })
    const result = await Effect.runPromise(allocator.allocate(requestOf(model, entry.intent)))
    expect(result).toEqual(entry.target)
    expect(references(result).map(invocationCoordinateKey)).toEqual(references(entry.target).map(invocationCoordinateKey))
    verify(model)
  }
  toString() { return `Retry(${this.index})` }
}

class Restart implements fc.AsyncCommand<Model, Real> {
  check() { return true }
  async run(model: Model, real: Real) {
    real.allocator = registeredThreadAllocator(real.store, real.policy)
    for (let index = 0; index < model.entries.length; index++) await new Retry(index).run(model, real)
  }
  toString() { return "Restart()" }
}

class Race implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check(model: Readonly<Model>) { return model.entries.length > 0 }
  async run(model: Model, real: Real) {
    const owner = model.entries[this.index % model.entries.length]!.target
    const intents = ["left", "right"].map((side): Intent => {
      const intent: Intent = { actor: owner.actor, instance: owner.instance, mode: "key", local: `race-${side}` }
      while (model.entries.some((entry) => sameIntent(entry.intent, intent))) intent.local += "x"
      return intent
    })
    const candidate = real.policy.generate()
    let attempts = 0
    const allocator = registeredThreadAllocator(real.store, {
      generate: () => attempts++ < 2 ? candidate : real.policy.generate(), maxAttempts: 100
    })
    const targets = await Promise.all(intents.map((intent) => Effect.runPromise(allocator.allocate(requestOf(model, intent)))))
    for (const [index, intent] of intents.entries()) model.entries.push({ intent, target: targets[index]! })
    verify(model)
  }
  toString() { return `Race(${this.index})` }
}

class Collide implements fc.AsyncCommand<Model, Real> {
  constructor(readonly index: number) {}
  check(model: Readonly<Model>) { return model.entries.length > 0 }
  async run(model: Model, real: Real) {
    const parent = this.index % model.entries.length
    const occupied = model.entries[parent]!.target
    const intent: Intent = { actor: occupied.actor, instance: occupied.instance, mode: "key", local: "collision" }
    while (model.entries.some((entry) => sameIntent(entry.intent, intent))) intent.local += "x"
    const request = requestOf(model, intent)
    const failing = registeredThreadAllocator(real.store, { generate: () => occupied.thread, maxAttempts: 2 })
    await expect(Effect.runPromise(failing.allocate(request))).rejects.toThrow("exhausted 2")
    let attempts = 0
    const recovering = registeredThreadAllocator(real.store, {
      generate: () => attempts++ === 0 ? occupied.thread : real.policy.generate(), maxAttempts: 100
    })
    const target = await Effect.runPromise(recovering.allocate(request))
    expect(attempts).toBeGreaterThanOrEqual(2)
    model.entries.push({ intent, target })
    await new Retry(model.entries.length - 1).run(model, real)
  }
  toString() { return `Collide(${this.index})` }
}

const local = fc.oneof(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom("main", "[]", "a:b", "子", "candidate-0"))
const intent = fc.record({ actor: fc.constantFrom("tardie", "other"), instance: fc.constantFrom("rick", "morty"), mode: fc.constantFrom("name" as const, "key" as const), local })
const index = fc.nat({ max: 100 })
const commands = fc.commands([
  fc.tuple(intent, fc.boolean(), index).map(([intent, child, index]) => new Allocate(intent, child, index)),
  index.map((index) => new Retry(index)),
  index.map((index) => new Collide(index)),
  index.map((index) => new Race(index)),
  fc.constant(new Restart())
], { maxCommands: 30 })

test("allocation histories preserve thread and invocation identity across claims, collisions, and restarts", async () => {
  await fc.assert(fc.asyncProperty(commands, async (commands) => {
    const model: Model = { entries: [] }
    const real = createReal()
    const root: Intent = { actor: "tardie", instance: "rick", mode: "name", local: "main" }
    await allocate(model, real, root)
    await allocate(model, real, { ...root, mode: "key" })
    await allocate(model, real, { ...root, parent: 0 })
    await allocate(model, real, { ...root, parent: 1 })
    await allocate(model, real, { ...root, parent: 2 })
    await allocate(model, real, { ...root, instance: "morty" })
    await allocate(model, real, { ...root, actor: "other" })
    await fc.asyncModelRun(() => ({ model, real }), commands)
    await new Race(0).run(model, real)
    await new Collide(0).run(model, real)
    await new Restart().run(model, real)
  }), { numRuns: 100 })
}, 20_000)
