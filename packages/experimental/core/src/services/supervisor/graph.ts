import { Effect, Schema } from "effect"
import { act } from "../../atoms/act"
import { effectAtom } from "../../atoms/effect"
import { ChildPlacement, ThreadDepth, ThreadCoordinate } from "../../actor/thread"
import { defineActor } from "../../actor/definition"
import { InitialState } from "../../initial-state"
import { durableAtom } from "../../atoms/durable"


const Allocation = Schema.Struct({
  coordinate: ThreadCoordinate,
  name: Schema.NonEmptyString,
  parent: Schema.NullOr(Schema.NonEmptyString),
  depth: ThreadDepth,
  placement: ChildPlacement,
  initialState: Schema.optionalKey(InitialState),
})
export type ThreadAllocation = typeof Allocation.Type
const Thread = Schema.Struct({ ...Allocation.fields, status: Schema.Literals(["requested", "registered", "failed"]), reason: Schema.optionalKey(Schema.String) })
export const SupervisorEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ThreadRequested"), allocation: Allocation }),
  Schema.Struct({ type: Schema.Literal("ThreadRegistered"), coordinate: ThreadCoordinate }),
  Schema.Struct({ type: Schema.Literal("ThreadFailed"), coordinate: ThreadCoordinate, reason: Schema.String }),
])
export type SupervisorEvent = typeof SupervisorEvent.Type

// threads projects allocation state; provisioning must tolerate repetition after interrupted registration.
export const threads = durableAtom({ name: "host.supervisor.threads",
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
    return state.map(entry => entry === current ? event.type === "ThreadFailed" ? { ...entry, status: "failed" as const, reason: event.reason } : { ...entry, status: "registered" as const } : entry)
  },
})

export const Provision = act({ name: "host.thread.provision", input: Allocation, success: Schema.Null, failure: Schema.String })

export const supervisorActor = defineActor("supervisor", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Provision.request>>()
  const supervisor = effectAtom(get => {
    const directory = get(threads)
    const acts = Object.fromEntries(directory.filter(entry => entry.status === "requested").map(allocation => {
      const tag = allocation.coordinate.thread
      let request = requests.get(tag)
      if (!request) {
        request = Provision.request({ tag, input: allocation, onSettled: result => {
          if (result.status === "rejected") return [{ type: "ThreadFailed", coordinate: allocation.coordinate, reason: typeof result.reason === "string" ? result.reason : JSON.stringify(result.reason) } satisfies SupervisorEvent]
          return [{ type: "ThreadRegistered", coordinate: allocation.coordinate } satisfies SupervisorEvent]
        } })
        requests.set(tag, request)
      }
      return [tag, request]
    }))
    return { view: { threads: directory }, events: {}, acts }
  })
  return { atom: supervisor, schema: SupervisorEvent }
}))
