import { Context, Effect, Layer, Schema } from "effect"
import { act } from "../../atoms/act"
import { durableAtom } from "../../atoms/durable/atom"
import { effectAtom } from "../../atoms/effect"
import { defineActor } from "../../actor/definition"
import { Allocation, Provision, SupervisorEvent } from "./graph"

export const RegistrationResult = Schema.Struct({ allocation: Allocation, status: Schema.Literals(["registered", "failed"]), reason: Schema.optionalKey(Schema.String) })
export type RegistrationResult = typeof RegistrationResult.Type
export const ReportRegistration = act({ name: "host.thread.reportRegistration", input: Schema.Struct({ ...RegistrationResult.fields, generation: Schema.Int }), success: Schema.Null, failure: Schema.String })
export type RegistrationEvent = typeof RegistrationEvent.Type
const Reported = Schema.Struct({ type: Schema.Literal("RegistrationReported") })
export const RegistrationEvent = Schema.Union([Schema.Struct({ type: Schema.Literal("ThreadRequested"), allocation: Allocation, generation: Schema.Int }), SupervisorEvent.members[1], SupervisorEvent.members[2], Reported])
const Event = RegistrationEvent
const State = Schema.NullOr(Schema.Struct({ allocation: Allocation, origin: Schema.Finite, generation: Schema.Int, reported: Schema.Boolean, status: Schema.Literals(["requested", "registered", "failed"]), reason: Schema.optionalKey(Schema.String) }))

// registrationActor retains one allocation and durably reports its provisioning result (platform/test/workerd/thread-layout.workers.ts).
export const registrationActor = defineActor("registration", Effect.sync(() => {
  const state = durableAtom({ name: "host.registration", input: Event, schema: State, initial: null, reduce: (state, event, _metadata, position) => {
    if (event.type === "ThreadRequested") {
      if (state && !state.reported) throw new Error("Registration is already pending")
      return { allocation: event.allocation, origin: position, generation: event.generation, reported: false, status: "requested" as const }
    }
    if (!state) throw new Error("Registration has no allocation")
    if (event.type === "RegistrationReported") return { ...state, reported: true }
    if (event.coordinate.thread !== state.allocation.coordinate.thread || state.status !== "requested") throw new Error("Registration identity mismatch")
    return { ...state, status: event.type === "ThreadRegistered" ? "registered" as const : "failed" as const, ...(event.type === "ThreadFailed" ? { reason: event.reason } : {}) }
  } })
  let provision: ReturnType<typeof Provision.request> | undefined
  let report: ReturnType<typeof ReportRegistration.request> | undefined
  return { schema: Event, atom: effectAtom(get => {
    const current = get(state)
    if (!current || current.reported) return { view: current, events: {}, acts: {} }
    if (current.status === "requested") {
      if (!provision || provision.origin !== current.origin) provision = Provision.request({ origin: current.origin, input: current.allocation, onSettled: result => result.status === "fulfilled"
        ? [{ type: "ThreadRegistered", coordinate: current.allocation.coordinate }]
        : [{ type: "ThreadFailed", coordinate: current.allocation.coordinate, reason: String(result.reason) }] })
      return { view: current, events: {}, acts: { provision } }
    }
    if (!report || report.origin !== current.origin) report = ReportRegistration.request({ origin: current.origin, input: { allocation: current.allocation, generation: current.generation, status: current.status, ...(current.reason === undefined ? {} : { reason: current.reason }) }, onSettled: result => {
      if (result.status !== "fulfilled") throw new Error(`Registration reporting failed: ${String(result.reason)}`)
      return [{ type: "RegistrationReported" }]
    } })
    return { view: current, events: {}, acts: { report } }
  }) }
}))

import { createActorStore } from "../../runtime/execution"
import type { ActorRuntime } from "../../runtime/contracts"
import type { Journal } from "../journal"
import { EffectExecution, type RetryOptions } from "../effect-execution"
import { DEFAULT_PROVISION_RETRY } from "../supervisor"
import type { ThreadAllocation } from "./graph"

// createRegistration runs provisioning and acknowledgement through durable native effects (platform/test/workerd/thread-layout.workers.ts).
export function createRegistration(options: {
  readonly canDrive?: () => Effect.Effect<boolean, Error>
  readonly journal: Journal<RegistrationEvent>
  readonly attemptTimeoutMs?: number | null
  readonly retry?: RetryOptions<Error>
  readonly provision: (allocation: ThreadAllocation) => Effect.Effect<void, Error>
  readonly report: (result: RegistrationResult, generation: number) => Effect.Effect<void, Error>
}) {
  return Effect.gen(function* () {
    let runtime!: ActorRuntime<RegistrationEvent>
    const store = yield* createActorStore({ actor: registrationActor, journal: options.journal,
      ...(options.canDrive ? { canDrive: options.canDrive() } : {}),
      ...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
      checkpoint: { mode: "manual" }, actorContext: () => Context.empty(),
      services: current => {
        runtime = current
        return Layer.merge(
          Provision.layer(input => EffectExecution.use(execution => execution.retry(options.provision(input), options.retry ?? DEFAULT_PROVISION_RETRY).pipe(Effect.as(null), Effect.mapError(String)))),
          ReportRegistration.layer(result => EffectExecution.use(execution => execution.retry(options.report(result, result.generation), options.retry ?? DEFAULT_PROVISION_RETRY).pipe(Effect.as(null), Effect.mapError(String)))),
        )
      },
    })
    return { ...store, send: runtime.send }
  })
}
