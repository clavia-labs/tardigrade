import { Context, Effect, Schema } from "effect"
import { effectAtom } from "@clavia/tardigrade-experimental-core"
import { defineActor } from "@clavia/tardigrade-experimental-core"
import { durableAtom } from "@clavia/tardigrade-experimental-core"
import type { EffectValue } from "@clavia/tardigrade-experimental-core"

export const ThreadCoordinate = Schema.Struct({ actor: Schema.NonEmptyString, instance: Schema.NonEmptyString, thread: Schema.NonEmptyString })
export type ThreadCoordinate = typeof ThreadCoordinate.Type
const Allocation = Schema.Struct({
  coordinate: ThreadCoordinate,
  name: Schema.NonEmptyString,
  parent: Schema.NullOr(Schema.NonEmptyString),
  depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ThreadAllocation = typeof Allocation.Type
const Thread = Schema.Struct({ ...Allocation.fields, status: Schema.Literals(["requested", "registered"]) })
export const SupervisorEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ThreadRequested"), allocation: Allocation }),
  Schema.Struct({ type: Schema.Literal("ThreadRegistered"), coordinate: ThreadCoordinate }),
])
export type SupervisorEvent = typeof SupervisorEvent.Type

export class ThreadProvisioner extends Context.Service<ThreadProvisioner, {
  readonly provision: (allocation: ThreadAllocation) => Effect.Effect<void, Error>
}>()("experimental/ThreadProvisioner") {}

// threads projects allocation state; provisioning must tolerate repetition after interrupted registration.
export const threads = durableAtom({
  input: SupervisorEvent,
  schema: Schema.Array(Thread),
  initial: [],
  reduce: (state, event: SupervisorEvent) => {
    if (event.type === "ThreadRequested") {
      const next = event.allocation
      if (state.some(entry => entry.coordinate.thread === next.coordinate.thread || (entry.parent === next.parent && entry.name === next.name))) throw new Error("Duplicate thread allocation")
      const parent = next.parent === null ? undefined : state.find(entry => entry.coordinate.thread === next.parent && entry.status === "registered")
      if (next.parent !== null && !parent) throw new Error("Unknown parent thread")
      if (next.depth !== (parent ? parent.depth + 1 : 0)) throw new Error("Invalid thread depth")
      if (state.some(entry => entry.coordinate.actor !== next.coordinate.actor || entry.coordinate.instance !== next.coordinate.instance)) throw new Error("Supervisor instance mismatch")
      return [...state, { ...next, status: "requested" as const }]
    }
    const current = state.find(entry => entry.coordinate.thread === event.coordinate.thread)
    if (!current || current.status !== "requested" || current.coordinate.actor !== event.coordinate.actor || current.coordinate.instance !== event.coordinate.instance) throw new Error("Unknown thread registration")
    return state.map(entry => entry === current ? { ...entry, status: "registered" as const } : entry)
  },
})

const supervisor = Object.assign(effectAtom(get => {
  const directory = get(threads)
  const effects = Object.fromEntries(directory.filter(entry => entry.status === "requested").map(allocation => [
    allocation.coordinate.thread,
    {
      kind: "effect",
      id: allocation.coordinate.thread,
      run: Effect.gen(function* () {
        yield* (yield* ThreadProvisioner).provision(allocation)
        return { type: "ThreadRegistered", coordinate: allocation.coordinate } as const
      }),
    } satisfies EffectValue<SupervisorEvent, Error, ThreadProvisioner>,
  ]))
  return { view: { threads: directory }, effects }
}), { schema: SupervisorEvent })

export const supervisorActor = defineActor("supervisor", Effect.succeed({
  atom: supervisor,
  actions: { requestThread: (allocation: ThreadAllocation): SupervisorEvent => ({ type: "ThreadRequested", allocation }) },
}))
