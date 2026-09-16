import { Clock, Context, Effect, Schema } from "effect"
import { actor, type Actor } from "./definition"
import { actorMethod } from "./method"
import { ThreadCoordinate } from "./coordinate"
import { ThreadAllocation } from "./allocation"
import type { ThreadRequested, ThreadRegistered } from "./events"
import { threadRequestOf } from "./log/upcast"
export { threadRequestOf } from "./log/upcast"
import type { ActorMethodState } from "../interaction/state"
import { type ChildPlacement, childLineageFor, threadCreated, type ThreadCreated } from "../interaction/relations"
import { component } from "../component/machine"
import type { TransitionContext } from "../transition/transition"
import { Self } from "../runtime/context"
import type { Router } from "../transport/router"

export const ThreadRequest = Schema.Struct({
  target: ThreadCoordinate,
  request: ThreadAllocation
})
export type ThreadRequest = typeof ThreadRequest.Type

export const threadAllocationKey = (request: ThreadAllocation): string => {
  const target = request.kind === "root" ? request.coordinate : request.parent
  return JSON.stringify([
    request.kind, target.actor, target.instance,
    ...(request.kind === "child" ? [target.thread] : []),
    request.key === undefined ? ["name", request.kind === "root" ? target.thread : request.child] : ["key", request.key]
  ])
}

// requestThreadMethod records allocation and completes after provisioning and application setup (supervisor.test.ts).
export const requestThreadMethod = (options: { readonly timeoutMs?: number } = {}) => actorMethod({
  ...options,
  input: ThreadRequest,
  output: Schema.String,
  event: ({ invocation, input, at }): ThreadRequested => ({
    type: "ThreadRequested", id: invocation.id, thread: input.target.thread, allocationRequest: input.request, allocationKey: threadAllocationKey(input.request),
    at
  }),
  projection: {
    initial: () => new Map<string, ActorMethodState<string>>(),
    step: (states, event) => {
      if (event.type === "ThreadRequested") return new Map(states).set(String(event.id ?? event.thread), { status: "pending" })
      if (event.type === "ThreadRegistered") return new Map(states).set(String(event.id ?? event.thread), { status: "completed", output: String(event.thread) })
      return states
    },
    output: (states) => ({ currentEpoch: () => 0, invocationState: (invocation) => states.get(invocation.id) })
  }
})

// threadCreationFor preserves inherited lineage when the supervisor creates a thread before its first message (supervisor.test.ts).
export const threadCreationFor = (input: ThreadRequest, parent: ThreadCreated | undefined, placement: ChildPlacement | undefined, at: number): ThreadCreated => {
  if (input.request.kind === "root") return threadCreated(input.target, undefined, at)
  if (parent === undefined) throw new Error("a child thread requires a created parent")
  const resolvedPlacement = input.request.placement ?? placement
  return threadCreated(input.target, childLineageFor(parent, {
    ...(resolvedPlacement === undefined ? {} : { placement: resolvedPlacement }),
    ...(input.request.maxDepth === undefined ? {} : { maxDepth: input.request.maxDepth })
  }), at)
}

// ThreadProvisioner owns idempotent creation and registration within the supervisor effect (supervisor.test.ts).
export class ThreadProvisioner extends Context.Service<ThreadProvisioner, {
  readonly create: (input: ThreadRequest) => Effect.Effect<ThreadCreated>
  readonly register: (created: ThreadCreated) => Effect.Effect<void>
}>()("tardigrade/ThreadProvisioner") {}

export type ThreadSupervisor = Actor<Router | Self | ThreadProvisioner, { readonly requestThread: ReturnType<typeof requestThreadMethod> }>

// threadSupervisor retries idempotent creation and setup until ThreadRegistered commits (supervisor.test.ts).
export const threadSupervisor = <E = never>(options: {
  readonly setup?: (input: ThreadRequest) => Effect.Effect<void, E, Router | Self>
  readonly timeoutMs?: number
} = {}): ThreadSupervisor => actor({
  name: "thread-supervisor",
  methods: { requestThread: requestThreadMethod(options) },
  components: [component({
    name: "threads",
    initial: () => new Map<string, { readonly request: ThreadRequested; readonly context: TransitionContext }>(),
    step: (pending, event, context) => {
      if (event.type === "ThreadRequested") {
        return new Map(pending).set(String(event.thread), { request: event as ThreadRequested, context })
      }
      const current = pending.get(String(event.thread))
      if (current === undefined) return pending
      if (event.type === "ThreadRegistered") {
        const next = new Map(pending)
        next.delete(String(event.thread))
        return next
      }
      return pending
    },
    output: (pending) => ({
      view: undefined,
      transitions: [...pending.values()].map(({ request, context }) => context.effect("register", {
        input: request,
        act: (input) => Effect.gen(function* () {
          const self = yield* Self
          const target = { actor: self.actor, instance: self.instance, thread: input.thread }
          const request = { target, request: threadRequestOf(target, input) }
          const provisioner = yield* ThreadProvisioner
          const created = yield* provisioner.create(request)
          if (options.setup !== undefined) yield* options.setup(request).pipe(Effect.orDie)
          yield* provisioner.register(created)
          return {
            type: "ThreadRegistered", id: String(input.id ?? input.thread), thread: input.thread,
            ...(created.placement === undefined ? {} : { placement: created.placement }),
            at: yield* Clock.currentTimeMillis
          } satisfies ThreadRegistered
        })
      }))
    })
  })]
})
