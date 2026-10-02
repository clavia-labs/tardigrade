import { Context, Effect, type Schema } from "effect"

export interface IsolateCall {
  readonly ordinal: number
  readonly package: string
  readonly method: string
  readonly input: Schema.Json
}

export interface IsolateInput {
  readonly code: string
  readonly packages: Readonly<Record<string, readonly string[]>>
  readonly ambient: { readonly at: number; readonly seed: string }
}

export interface IsolateResult {
  readonly result: Schema.Json
  readonly error?: string
  readonly logs: readonly string[]
}

// Isolate executes JavaScript with package capabilities whose RPC responses resume the calling code.
export class Isolate extends Context.Service<Isolate, {
  readonly run: <Services>(input: IsolateInput, onCall: (call: IsolateCall) => Effect.Effect<Schema.Json, string, Services>) => Effect.Effect<IsolateResult, string, Services>
}>()("experimental/Isolate") {}
