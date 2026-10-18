import { Schema } from "effect"
import type { Json, Path } from "@tardie/grove"
import * as Grove from "@tardie/grove"

export const StateReference = Grove.EncodedReference
const InputPath = Schema.Array(Schema.Union([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]))
export const InputSelection = Schema.Struct({ reference: StateReference, target: InputPath })
export type InputSelection = typeof InputSelection.Type
export const DocumentState = Schema.TaggedStruct("DocumentState", { reference: StateReference })
export type { Selection as ValueSelection, MerkleTree } from "@tardie/grove"
export interface DocumentChanges { readonly references: readonly { readonly name: string; readonly reference: string }[] }
export type SelectedInput<Value> = Value | Grove.Selection<Value> | (Value extends readonly (infer A)[] ? readonly SelectedInput<A>[] : Value extends object ? { readonly [K in keyof Value]: SelectedInput<Value[K]> } : never)
export const prepareDocumentInput = (value: unknown) => {
  const refs: InputSelection[] = []
  const visit = (value: unknown, target: Path): Json => {
    const reference = Grove.selectionValueReference(value)
    if (reference) { refs.push({ reference: Grove.encodeReference(reference), target }); return null }
    if (Array.isArray(value)) return value.map((value, index) => visit(value, [...target, index]))
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, visit((value as Readonly<Record<string, unknown>>)[key], [...target, key])]))
    return value as Json
  }
  const input = visit(value, [])
  return { input, ...(refs.length ? { selections: refs } : {}) }
}

// documentSession binds Grove snapshots to projection and accepted-operation lifetimes.
export function documentSession(storage: Omit<Grove.Storage, "scope"> & { readonly scope?: string }) {
  const grove = Grove.make({ ...storage, scope: storage.scope ?? "tardigrade/memory" })
  const bind = <State extends Json>(schema: Schema.Decoder<State>) => {
    const binding = grove.bind(schema)
    return { initial: binding.initial, check: binding.check, open: (encoded: string) => binding.open(Grove.decodeReference(encoded)) }
  }
  const readReference = (encoded: string): Json => grove.view(Grove.decodeReference(encoded), Schema.Json).materialize()
  const session = {
    ...grove, bind,
    hold: (holder: object, name: string, encoded: string) => grove.hold(holder, name, Grove.decodeReference(encoded)),
    held: () => grove.held().map(Grove.encodeReference),
    capture: (value: Json) => Grove.encodeReference(grove.capture(value)),
    bytes: (encoded: string) => grove.bytes(Grove.decodeReference(encoded)),
    read: readReference,
    readReference,
    resolve: (request: { readonly input: Json; readonly selections?: readonly InputSelection[] }): Json => resolveInput(request, readReference),
  }
  return session satisfies DocumentSession
}

// DocumentSession provides synchronous document access and retention for projections (properties/durable-state.test.ts; platform/test/bun/stored-journal.test.ts).
export interface DocumentSession {
  readonly bind: <State extends Json>(schema: Schema.Decoder<State>) => {
    readonly initial: (value: unknown) => Grove.MerkleTree<State>
    readonly check: (document: Grove.MerkleTree<State>) => Grove.MerkleTree<State>
    readonly open: (reference: string) => Grove.MerkleTree<State>
  }
  readonly capture: (value: Json) => string
  readonly bytes: (reference: string) => number
  readonly read: (reference: string) => Json
  readonly readReference: (reference: string) => Json
  readonly hold: (holder: object, name: string, reference: string) => void
  readonly release: (holder: object) => void
  readonly resolve: (request: { readonly input: Json; readonly selections?: readonly InputSelection[] }) => Json
  readonly stats: Grove.Instance["stats"]
}

// resolveInput fills each selection target with its recorded values.
export function resolveInput(request: { readonly input: Json; readonly selections?: readonly InputSelection[] }, readValue: ((reference: string) => Json) | undefined): Json {
  if (!request.selections?.length) return request.input
  let input = structuredClone(request.input)
  for (const ref of request.selections) {
    if (!readValue) throw new Error("Value selections require synchronous document storage")
    const value = readValue(ref.reference)
    if (!ref.target.length) { if (input !== null) throw new Error("Invalid selected input target"); input = value; continue }
    let parent: Json = input
    for (const key of ref.target.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error("Invalid selected input target")
      parent = (parent as Readonly<Record<string, Json>>)[key]!
    }
    const key = ref.target.at(-1)!
    if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key) || (parent as Readonly<Record<string, Json>>)[key] !== null) throw new Error("Invalid selected input target")
    Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return input
}
