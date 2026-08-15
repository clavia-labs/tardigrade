import type { NativeToolSpec } from "./infer"

// A tool's input, declared once. The value carries the JSON Schema the model reads and the
// TypeScript type the handler receives, so the two can not drift: the schema says `orderId` and
// the handler reads `input.orderId`, checked by the compiler.
//
// Writing them separately is the older shape, and it is still legal: `NativeToolSpec` takes any
// `inputSchema` and a handler can cast. The cast is where drift lives, and a drifted field reads
// as `undefined` at runtime rather than failing, so the typed door exists to make the compiler
// hold both halves at once.
//
// The subset is the one a tool input actually uses: strings, numbers, booleans, enums, arrays,
// objects, and optional fields. It is the same subset `answerErrors` validates, so the schema this
// builds is checkable at dispatch by the checker that already exists.

declare const carried: unique symbol

export interface Spec<Value> {
  readonly json: Record<string, unknown>
  // The type this spec describes. It is never present at runtime; it carries `Value` through
  // inference so a handler's input type is the schema's type. It is a value position rather than a
  // parameter position so that a `Spec<string>` is a `Spec<unknown>`, which is what lets one
  // object shape hold specs of different types.
  readonly [carried]?: Value
}

const of = <Value>(json: Record<string, unknown>): Spec<Value> => ({ json })

export const string = (description?: string): Spec<string> =>
  of({ type: "string", ...(description === undefined ? {} : { description }) })

export const number = (description?: string): Spec<number> =>
  of({ type: "number", ...(description === undefined ? {} : { description }) })

export const integer = (description?: string): Spec<number> =>
  of({ type: "integer", ...(description === undefined ? {} : { description }) })

export const boolean = (description?: string): Spec<boolean> =>
  of({ type: "boolean", ...(description === undefined ? {} : { description }) })

export const literal = <const Values extends ReadonlyArray<string>>(
  ...values: Values
): Spec<Values[number]> => of({ type: "string", enum: [...values] })

export const array = <Value>(items: Spec<Value>, description?: string): Spec<ReadonlyArray<Value>> =>
  of({
    type: "array",
    items: items.json,
    ...(description === undefined ? {} : { description })
  })

// A field the caller may leave out. The object builder reads it to decide what `required` lists.
const optionalMark: unique symbol = Symbol.for("flamecast/spec/optional")

export interface Optional<Value> extends Spec<Value | undefined> {
  readonly [optionalMark]: true
}

export const optional = <Value>(spec: Spec<Value>): Optional<Value> => ({
  json: spec.json,
  [optionalMark]: true
})

const isOptional = (spec: Spec<unknown>): boolean =>
  (spec as Partial<Optional<unknown>>)[optionalMark] === true

type Fields<Shape extends Record<string, Spec<unknown>>> = {
  readonly [Key in keyof Shape as Shape[Key] extends Optional<unknown> ? never : Key]: Carried<
    Shape[Key]
  >
} & {
  readonly [Key in keyof Shape as Shape[Key] extends Optional<unknown> ? Key : never]?: Carried<
    Shape[Key]
  >
}

type Carried<One> = One extends Optional<infer Value>
  ? Value
  : One extends Spec<infer Value>
    ? Value
    : never

// An object input. `additionalProperties` is false because a model that invents a field is
// guessing, and a guess that lands silently is the failure this whole file exists to prevent.
export const object = <const Shape extends Record<string, Spec<unknown>>>(
  shape: Shape
): Spec<{ [Key in keyof Fields<Shape>]: Fields<Shape>[Key] }> => {
  const required = Object.entries(shape)
    .filter(([, spec]) => !isOptional(spec))
    .map(([name]) => name)
  return of({
    type: "object",
    properties: Object.fromEntries(Object.entries(shape).map(([name, spec]) => [name, spec.json])),
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  })
}

// The type a spec describes, for a caller that wants to name it.
export type Input<One> = One extends Spec<infer Value> ? Value : never

export const specOf = <Value>(
  name: string,
  description: string,
  input: Spec<Value>
): NativeToolSpec => ({ name, description, inputSchema: input.json })
