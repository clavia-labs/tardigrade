import type { Envelope } from "@flamecast/core"

declare const TokenValue: unique symbol

export type Projection<Value> = (log: ReadonlyArray<Envelope>) => Value

export interface Token<Id extends string, Value> {
  readonly id: Id
  readonly [TokenValue]?: Value
}

export type AnyToken = Token<string, unknown>

export type ValueOf<T extends AnyToken> = T extends Token<string, infer Value> ? Value : never

export interface Binding<T extends AnyToken> {
  readonly token: T
  readonly project: Projection<ValueOf<T>>
}

export const token = <const Id extends string, Value>(id: Id): Token<Id, Value> => ({ id })

export const provide = <T extends AnyToken>(
  token: T,
  project: Projection<ValueOf<T>>
): Binding<T> => ({ token, project })

export interface ModuleContext<Requires extends readonly AnyToken[]> {
  readonly resolve: <T extends Requires[number]>(
    token: T,
    log: ReadonlyArray<Envelope>
  ) => ValueOf<T>
}
