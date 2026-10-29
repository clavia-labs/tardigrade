import { Context, Effect, Schema } from "effect"
import { atom } from "../atoms/atom"
import { EventLog, eventLogContext } from "./event-log"
import type { EffectRef } from "../runtime/effects"
import { RuntimeError } from "../runtime/effects"
import type { ExecutionHandle } from "../runtime/effects"

// ExternalCancellationError records a final cleanup rejection without retrying it.
export class ExternalCancellationError extends RuntimeError {}

export interface ExternalSubmission { readonly key: string; readonly attempt: number; readonly submission: number; readonly deadlineAt: number }

// ExternalExecution retains accepted handles across local-producer recovery and passes terminal failures to the enclosing native retry.
export const ExternalExecution = Context.Reference<{
  readonly submit: <Services>(work: (submission: ExternalSubmission) => Effect.Effect<ExecutionHandle, Error, Services>, options: { readonly deadlineAt: number; readonly cancel?: (handle: ExecutionHandle) => Effect.Effect<void, Error, Services> }) => Effect.Effect<Schema.Json, Error, Services>
}>("tardie/ExternalExecution", { defaultValue: () => ({ submit: () => Effect.fail(new RuntimeError("External execution requires a native act")) }) })

// externalAttempts exposes retained handles to the owning act's cancellation implementation.
export const externalAttempts = (ref: EffectRef) => atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new Error("Missing EventLog service")
  const service = Context.get(context, EventLog)
  get(service.events)
  return service.effect?.(ref)?.execution.external ?? []
})
