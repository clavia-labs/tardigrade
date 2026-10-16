import { LogRange, logSelectionReference, type LogRegistry, type LogSelection } from "./log-state"
import { Schema } from "effect"
import type { Json, Path } from "@tardie/grove"
import * as Grove from "@tardie/grove"
import { frozenPlainData } from "../atoms/incremental/frozen"

const TreeInputSelection = Schema.Struct({ ...Grove.Reference.fields, target: Grove.Reference.fields.path })
const LogInputSelection = Schema.Struct({ ...LogRange.fields, target: Grove.Reference.fields.path })
export const InputSelection = Schema.Union([TreeInputSelection, LogInputSelection])
export type InputSelection = typeof InputSelection.Type
export const TreeState = Schema.TaggedStruct("TreeState", { root: Grove.Reference.fields.root })
export type { Selection as TreeSelection, MerkleTree, Storage as TreeStorage } from "@tardie/grove"
export interface TreeChanges { readonly nodes: Grove.StagedNodes; readonly roots: readonly { readonly name: string; readonly root: string }[]; readonly held?: readonly string[] }
export type SelectedInput<Value> = Value | Grove.Selection<Value> | LogSelection<Value> | (Value extends readonly (infer A)[] ? readonly SelectedInput<A>[] : Value extends object ? { readonly [K in keyof Value]: SelectedInput<Value[K]> } : never)
export const prepareTreeInput = (value: unknown) => {
  const refs: InputSelection[] = []
  const visit = (value: unknown, target: Path): Json => {
    const range = logSelectionReference(value)
    if (range) { refs.push({ ...range, target }); return null }
    const ref = Grove.selectionReference(value)
    if (ref) { refs.push({ ...ref, target }); return null }
    if (Array.isArray(value)) return value.map((value, index) => visit(value, [...target, index]))
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, visit((value as Readonly<Record<string, unknown>>)[key], [...target, key])]))
    return value as Json
  }
  const input = visit(value, [])
  return { input, ...(refs.length ? { selections: refs } : {}) }
}

// recognizeFrozen records Grove's deep-frozen decoded payloads in frozenPlainData so act input decoding reuses them across resolutions; containers the reader assembles stay mutable and unrecorded, and act schemas still decode every resolved input.
const recognizeFrozen = (value: Json): boolean => {
  if (value === null || typeof value !== "object") return true
  if (frozenPlainData.has(value)) return true
  const prototype = Object.getPrototypeOf(value)
  let deep = Array.isArray(value) || prototype === Object.prototype || prototype === null
  for (const child of Object.values(value)) deep = recognizeFrozen(child) && deep
  if (!deep || !Object.isFrozen(value)) return false
  frozenPlainData.add(value)
  return true
}
// treeSession binds Grove snapshots to projection and accepted-operation lifetimes.
export function treeSession(storage: Grove.Storage) {
  const grove = Grove.make(storage)
  const holders = new Map<object, Map<string, string>>()
  return {
    ...grove,
    hold: (holder: object, name: string, root: string) => {
      let roots = holders.get(holder)
      if (!roots) { roots = new Map(); holders.set(holder, roots) }
      roots.set(name, root)
    },
    release: (holder: object) => { holders.delete(holder) },
    held: (): readonly string[] => [...new Set([...holders.values()].flatMap(roots => [...roots.values()]))],
    resolve: (request: { readonly input: Json; readonly selections?: readonly InputSelection[] }, logs?: LogRegistry): Json => resolveInput(request, ref => grove.readReference(ref), logs),
  }
}
export type TreeSession = ReturnType<typeof treeSession>

// resolveInput fills each selection target with its recorded tree values or log entries.
export function resolveInput(request: { readonly input: Json; readonly selections?: readonly InputSelection[] }, readTree: ((ref: typeof Grove.Reference.Type) => Json) | undefined, logs: LogRegistry | undefined): Json {
  if (!request.selections?.length) return request.input
  let input = structuredClone(request.input)
  for (const ref of request.selections) {
    let value: Json
    if ("root" in ref) {
      if (!readTree) throw new Error("Tree selections require synchronous tree storage")
      value = readTree(ref)
    } else {
      if (!logs) throw new Error("Log selections require a log registry")
      value = logs.read(ref) as Json
    }
    recognizeFrozen(value)
    if (!ref.target.length) { if (input !== null) throw new Error("Invalid tree input target"); input = value; continue }
    let parent: Json = input
    for (const key of ref.target.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key)) throw new Error("Invalid tree input target")
      parent = (parent as Readonly<Record<string, Json>>)[key]!
    }
    const key = ref.target.at(-1)!
    if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, key) || (parent as Readonly<Record<string, Json>>)[key] !== null) throw new Error("Invalid tree input target")
    Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return input
}
