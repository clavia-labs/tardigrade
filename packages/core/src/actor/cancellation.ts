import { event } from "./event"
import { Schema } from "effect"
import { InvocationRef } from "./method"

// AbortRequested identifies an accepted method invocation whose domain work should stop.
export const AbortRequested = event({ type: "AbortRequested", ref: InvocationRef, reason: Schema.String })
export type AbortRequested = typeof AbortRequested.Type

// abortRequested constructs an invocation-scoped stop request.
export const abortRequested = (input: { readonly ref: InvocationRef; readonly reason: string }) => AbortRequested.make(input)
