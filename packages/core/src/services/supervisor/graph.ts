import { Effect, Schema } from "effect"
import { act } from "../../atoms/act"
import { effectAtom } from "../../atoms/effect"
import { ChildPlacement, ThreadDepth, ThreadCoordinate } from "../../actor/thread"
import { defineActor } from "../../actor/definition"
import { InitialState } from "../../initialise"
import { durableAtom } from "../../atoms/durable"
import { durableAtomFamily } from "../../experimental/durable-atom-family"
import type { Getter } from "../../atoms/atom"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { DEFAULT_SUPERVISOR_PAGE_SIZE, type SupervisorPageOptions } from "./page"


const Allocation = Schema.Struct({
  coordinate: ThreadCoordinate,
  name: Schema.NonEmptyString,
  parent: Schema.NullOr(Schema.NonEmptyString),
  depth: ThreadDepth,
  placement: ChildPlacement,
  initialState: Schema.optionalKey(InitialState),
})
export type ThreadAllocation = typeof Allocation.Type
const sameAllocation = Schema.toEquivalence(Allocation)
const Thread = Schema.Struct({ ...Allocation.fields, origin: Schema.Finite, status: Schema.Literals(["requested", "registered", "failed"]), reason: Schema.optionalKey(Schema.String) })
export type ThreadMetadata = Omit<typeof Thread.Type, "initialState">
export const SupervisorEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ThreadRequested"), allocation: Allocation }),
  Schema.Struct({ type: Schema.Literal("ThreadRegistered"), coordinate: ThreadCoordinate }),
  Schema.Struct({ type: Schema.Literal("ThreadFailed"), coordinate: ThreadCoordinate, reason: Schema.String }),
])
export type SupervisorEvent = typeof SupervisorEvent.Type

const Requested = SupervisorEvent.members[0]
const Identity = Schema.Struct({ actor: Schema.NonEmptyString, instance: Schema.NonEmptyString })
export const SUPERVISOR_CHECKPOINT_TAG = "host.supervisor.families/1"

export const threadNameKey = (parent: string | null, name: string): string => JSON.stringify([parent, name])

// thread preserves allocation identity and validates per-thread lifecycle transitions (packages/platform/bench/directory/README.md).
export const thread = durableAtomFamily({
  name: "host.supervisor.thread", input: SupervisorEvent, schema: Schema.UndefinedOr(Thread), initial: undefined,
  key: event => event.type === "ThreadRequested" ? event.allocation.coordinate.thread : event.coordinate.thread,
  reduce: (state, event, _metadata, position) => {
    if (event.type === "ThreadRequested") {
      if (state && (state.status !== "failed" || !sameAllocation(state, event.allocation))) throw new Error("Duplicate thread allocation")
      return { ...event.allocation, origin: position, status: "requested" as const }
    }
    if (!state || state.status !== "requested" || state.coordinate.actor !== event.coordinate.actor || state.coordinate.instance !== event.coordinate.instance) throw new Error("Unknown thread registration")
    return event.type === "ThreadRegistered" ? { ...state, status: "registered" as const } : { ...state, status: "failed" as const, reason: event.reason }
  },
})

export const threadByName = durableAtomFamily({
  name: "host.supervisor.threadByName", input: Requested, schema: Schema.UndefinedOr(Schema.String), initial: undefined,
  key: event => threadNameKey(event.allocation.parent, event.allocation.name),
  reduce: (state, event) => {
    const id = event.allocation.coordinate.thread
    if (state !== undefined && state !== id) throw new Error("Duplicate thread allocation")
    return id
  },
})

// threadMetadata exposes thread lifecycle and routing fields without provisioning state.
export const threadMetadata = NativeAtom.family((id: string) => NativeAtom.readable(get => {
  const allocation = get(thread(id))
  if (!allocation) return undefined
  const { initialState: _initialState, ...metadata } = allocation
  return Object.freeze(metadata) satisfies ThreadMetadata
}))

const threadPages = NativeAtom.family((identity: string) => {
  const options = JSON.parse(identity) as SupervisorPageOptions
  const keys = thread.keys(options)
  return NativeAtom.readable(get => {
    const page = get(keys)
    return { threads: page.keys.map(id => {
      const entry = get(threadMetadata(id))
      if (!entry) throw new Error("Indexed thread has no allocation")
      return entry
    }), ...(page.next === undefined ? {} : { next: page.next }) }
  })
})

export const threadPage = (options: SupervisorPageOptions = {}) => threadPages(JSON.stringify({ after: options.after, limit: options.limit ?? DEFAULT_SUPERVISOR_PAGE_SIZE }))

export const pendingThreads = durableAtom({
  name: "host.supervisor.pending", input: SupervisorEvent, schema: Schema.Array(Schema.String), initial: [],
  reduce: (state, event) => event.type === "ThreadRequested"
    ? state.includes(event.allocation.coordinate.thread) ? state : [...state, event.allocation.coordinate.thread]
    : state.filter(id => id !== event.coordinate.thread),
})

const identity = durableAtom({
  name: "host.supervisor.identity", input: Requested, schema: Schema.UndefinedOr(Identity), initial: undefined,
  reduce: (state, event) => {
    const { actor, instance } = event.allocation.coordinate
    if (state && (state.actor !== actor || state.instance !== instance)) throw new Error("Supervisor instance mismatch")
    return state ?? { actor, instance }
  },
})

const latest = durableAtom({
  name: "host.supervisor.latest", input: SupervisorEvent, schema: Schema.UndefinedOr(SupervisorEvent), initial: undefined,
  reduce: (_state, event) => event,
})

const validateParent = (allocation: ThreadAllocation, get: Getter) => {
  const parent = allocation.parent === null ? undefined : get(thread(allocation.parent))
  if (allocation.parent !== null && parent?.status !== "registered") throw new Error("Unknown parent thread")
  if (allocation.depth !== (parent ? parent.depth + 1 : 0)) throw new Error("Invalid thread depth")
}

// threads preserves allocation identity across failed re-requests (packages/platform/test/workerd/thread-layout.workers.ts). Provisioning must tolerate repetition after interrupted registration.
export const threads = durableAtom({ name: "host.supervisor.threads",
  input: SupervisorEvent,
  schema: Schema.Array(Thread),
  initial: [],
  reduce: (state, event: SupervisorEvent, _metadata, position) => {
    if (event.type === "ThreadRequested") {
      const next = event.allocation
      const existing = state.find(entry => entry.coordinate.thread === next.coordinate.thread || (entry.parent === next.parent && entry.name === next.name))
      if (existing && (existing.status !== "failed" || !sameAllocation(existing, next))) throw new Error("Duplicate thread allocation")
      const parent = next.parent === null ? undefined : state.find(entry => entry.coordinate.thread === next.parent && entry.status === "registered")
      if (next.parent !== null && !parent) throw new Error("Unknown parent thread")
      if (next.depth !== (parent ? parent.depth + 1 : 0)) throw new Error("Invalid thread depth")
      if (state.some(entry => entry.coordinate.actor !== next.coordinate.actor || entry.coordinate.instance !== next.coordinate.instance)) throw new Error("Supervisor instance mismatch")
      const requested = { ...next, origin: position, status: "requested" as const }
      return existing ? state.map(entry => entry === existing ? requested : entry) : [...state, requested]
    }
    const current = state.find(entry => entry.coordinate.thread === event.coordinate.thread)
    if (!current || current.status !== "requested" || current.coordinate.actor !== event.coordinate.actor || current.coordinate.instance !== event.coordinate.instance) throw new Error("Unknown thread registration")
    return state.map(entry => entry === current ? event.type === "ThreadFailed" ? { ...entry, status: "failed" as const, reason: event.reason } : { ...entry, status: "registered" as const } : entry)
  },
})

export const Provision = act({ name: "host.thread.provision", input: Allocation, success: Schema.Null, failure: Schema.String })

export const familySupervisorActor = defineActor("supervisor", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Provision.request>>()
  const supervisor = effectAtom(get => {
    get(identity)
    const event = get(latest)
    if (event) {
      get(thread(event.type === "ThreadRequested" ? event.allocation.coordinate.thread : event.coordinate.thread))
      if (event.type === "ThreadRequested") {
        get(threadByName(threadNameKey(event.allocation.parent, event.allocation.name)))
        validateParent(event.allocation, get)
      }
    }
    const pending = get(pendingThreads)
    const active = new Set(pending)
    for (const id of requests.keys()) if (!active.has(id)) requests.delete(id)
    const acts = Object.fromEntries(pending.map(id => {
      const allocation = get(thread(id))
      if (!allocation || allocation.status !== "requested") throw new Error(`Pending thread ${id} is ${allocation?.status ?? "missing"}`)
      const key = allocation.coordinate.thread
      let request = requests.get(key)
      if (!request || request.origin !== allocation.origin) {
        request = Provision.request({ origin: allocation.origin, input: allocation, onSettled: result => {
          if (result.status === "rejected") return [{ type: "ThreadFailed", coordinate: allocation.coordinate, reason: typeof result.reason === "string" ? result.reason : JSON.stringify(result.reason) } satisfies SupervisorEvent]
          return [{ type: "ThreadRegistered", coordinate: allocation.coordinate } satisfies SupervisorEvent]
        } })
        requests.set(key, request)
      }
      return [key, request]
    }))
    return { view: { pending }, events: {}, acts }
  }, { input: SupervisorEvent, validate: (event, get) => {
    if (event.type !== "ThreadRequested") return
    const allocation = event.allocation
    validateParent(allocation, get)
    const current = get(thread(allocation.coordinate.thread))
    if (current && (current.status !== "failed" || !sameAllocation(current, allocation))) throw new Error("Duplicate thread allocation")
    const owner = get(threadByName(threadNameKey(allocation.parent, allocation.name)))
    if (owner !== undefined && owner !== allocation.coordinate.thread) throw new Error("Duplicate thread allocation")
    const scope = get(identity)
    if (scope && (scope.actor !== allocation.coordinate.actor || scope.instance !== allocation.coordinate.instance)) throw new Error("Supervisor instance mismatch")
  } })
  return { atom: supervisor, schema: SupervisorEvent }
}))

// supervisorActor retains the full-directory view for explicit actor consumers. Hosted supervisors use familySupervisorActor.
export const supervisorActor = defineActor("supervisor", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Provision.request>>()
  const supervisor = effectAtom(get => {
    const directory = get(threads)
    const acts = Object.fromEntries(directory.filter(entry => entry.status === "requested").map(allocation => {
      const key = allocation.coordinate.thread
      let request = requests.get(key)
      if (!request || request.origin !== allocation.origin) {
        request = Provision.request({ origin: allocation.origin, input: allocation, onSettled: result => {
          if (result.status === "rejected") return [{ type: "ThreadFailed", coordinate: allocation.coordinate, reason: typeof result.reason === "string" ? result.reason : JSON.stringify(result.reason) } satisfies SupervisorEvent]
          return [{ type: "ThreadRegistered", coordinate: allocation.coordinate } satisfies SupervisorEvent]
        } })
        requests.set(key, request)
      }
      return [key, request]
    }))
    return { view: { threads: directory }, events: {}, acts }
  })
  return { atom: supervisor, schema: SupervisorEvent }
}))
