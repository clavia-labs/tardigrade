import type { Envelope } from "@flamecast/core"

declare const SignalValue: unique symbol

export interface Signal<Id extends string, Value> {
  readonly id: Id
  readonly [SignalValue]?: Value
}

export type AnySignal = Signal<string, unknown>

export type ValueOf<S extends AnySignal> = S extends Signal<string, infer Value> ? Value : never

export interface Announcement<S extends AnySignal> {
  readonly signal: S
  readonly read: (log: ReadonlyArray<Envelope>) => ValueOf<S>
}

export const signal = <const Id extends string, Value>(id: Id): Signal<Id, Value> => ({ id })

export const announce = <S extends AnySignal>(
  signal: S,
  read: (log: ReadonlyArray<Envelope>) => ValueOf<S>
): Announcement<S> => ({ signal, read })

export interface ModuleContext<Requires extends readonly AnySignal[]> {
  readonly read: <S extends Requires[number]>(
    signal: S,
    log: ReadonlyArray<Envelope>
  ) => ValueOf<S>
}
