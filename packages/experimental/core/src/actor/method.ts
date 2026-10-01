import { Schema } from "effect"
import { RuntimeError } from "../runtime/effects"
import type { Getter } from "../atoms/atom"

export const MethodInvocation = Schema.Struct({ method: Schema.NonEmptyString, input: Schema.Json })
export type MethodInvocation = typeof MethodInvocation.Type
export const MethodCancellation = Schema.Struct({ method: Schema.NonEmptyString, cancel: Schema.Struct({ id: Schema.NonEmptyString, reason: Schema.String }) })
export type MethodCancellation = typeof MethodCancellation.Type
export interface MethodContext { readonly id: string }

export type MethodResult<Output> =
  | { readonly status: "completed"; readonly output: Output }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason: string }

export const methodResult = <Output extends Schema.Json>(output: Schema.Schema<Output>) => Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.toType(output) }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled"), reason: Schema.String }),
])

export class MethodFailed extends RuntimeError {}
export class MethodCancelled extends RuntimeError {}

export interface ActorMethod<Event extends object, Input extends Schema.Json = Schema.Json, Output extends Schema.Json = Schema.Json> {
  readonly inputSchema: Schema.Schema<Input>
  readonly outputSchema: Schema.Schema<Output>
  readonly onReceive: (input: unknown, context: MethodContext) => Event
  readonly result: (input: unknown, get: Getter, context: MethodContext) => MethodResult<Output> | undefined
  readonly onCancel?: (input: unknown, context: MethodContext & { readonly reason: string }) => Event
}
export type ActorMethods<Event extends object> = Readonly<Record<string, ActorMethod<Event>>>
export type MethodInput<Method extends ActorMethod<object>> = Method["inputSchema"]["Type"]
export type MethodOutput<Method extends ActorMethod<object>> = Method["outputSchema"]["Type"]

// actorMethod binds input, output, and invocation-scoped domain behavior; undefined replies remain pending.
export function actorMethod<Input extends Schema.Json, Output extends Schema.Json, Event extends object, CancellationEvent extends object = never>(definition: {
  readonly inputSchema: Schema.Schema<Input>
  readonly outputSchema: Schema.Schema<Output>
  readonly onReceive: (input: Input, context: MethodContext) => Event
  readonly result: (input: Input, get: Getter, context: MethodContext) => MethodResult<Output> | undefined
  readonly onCancel?: (input: Input, context: MethodContext & { readonly reason: string }) => CancellationEvent
}): ActorMethod<Event | CancellationEvent, Input, Output> {
  const decodeInput = Schema.decodeUnknownSync(Schema.toType(definition.inputSchema), { onExcessProperty: "error" })
  const decodeOutput = Schema.decodeSync(methodResult(definition.outputSchema), { onExcessProperty: "error" })
  return {
    inputSchema: definition.inputSchema, outputSchema: definition.outputSchema,
    onReceive: (input, context) => definition.onReceive(decodeInput(input), context),
    result: (input, get, context) => {
      const output = definition.result(decodeInput(input), get, context)
      return output === undefined ? undefined : decodeOutput(output)
    },
    ...(definition.onCancel ? { onCancel: (input: unknown, context: MethodContext & { readonly reason: string }) => definition.onCancel!(decodeInput(input), context) } : {}),
  }
}
