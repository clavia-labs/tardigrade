import { Exit, Schema } from "effect"
import { makeSync } from "./sqlite"
import type { Json, Reference, Version } from "./state"
import type { Sqlite, Transaction } from "./storage"
import { transactions } from "../storage/transaction"
import { localOwners } from "../session/ownership"
import { storedValues, encodeReference, referenceLocator, type ValueReference, type ValueRange } from "../value"
import type { Path } from "../storage/nodes"
import type { Selection } from "../document"

export interface PlainVersion<State extends Json, Event, Metadata> {
  readonly value: State
  readonly reference: ValueReference<State>
  readonly apply: (event: Event, metadata: Metadata, sequence: number) => PlainVersion<State, Event, Metadata>
  readonly update: (next: unknown) => PlainVersion<State, Event, Metadata>
  readonly selectEach: (path: Path, each: Path, range?: ValueRange) => Selection<never>
}
export interface PlainOptions<State extends Json, Event, Metadata> {
  readonly schema: Schema.Decoder<State>
  readonly migrate?: (stored: unknown) => unknown
  readonly reduce: (state: State, event: Event, metadata: Metadata, sequence: number) => State
}
export interface PlainBinding<State extends Json, Event, Metadata> {
  readonly initial: (value: unknown) => PlainVersion<State, Event, Metadata>
  readonly open: (reference: ValueReference<unknown>) => PlainVersion<State, Event, Metadata>
  readonly check: (version: PlainVersion<State, Event, Metadata>) => PlainVersion<State, Event, Metadata>
}
const selections = new WeakMap<object, (path: Path, each: Path, range?: ValueRange) => Selection<never>>()
// rememberState associates a state value with its selective reader (test/reducer/integration.test.ts).
export function rememberState(state: Json, select: (path: Path, each: Path, range?: ValueRange) => Selection<never>) {
  if (state !== null && typeof state === "object") selections.set(state, select)
}
// selectEach captures a selection from the version that produced this state (test/reducer/integration.test.ts).
export function selectEach(state: object, path: Path, each: Path, range?: ValueRange) {
  const select = selections.get(state)
  if (!select) throw new Error("State has no Grove version")
  return select(path, each, range)
}

// plainStorage binds ordinary reducers to scoped references and local view lifetimes (test/reducer/integration.test.ts).
export function plainStorage(sqlite: Sqlite, options: { readonly scope: string; readonly chunkBytes: number; readonly packBytes?: number }) {
  const native = makeSync(sqlite, options), scope = options.scope, coordinator = transactions(sqlite)
  let seed: Json = null
  const pending = new Map<string, Version<Json>>(), live = new Map<string, WeakRef<Version<Json>>>()
  const materialization = native.materialize<Json, (state: Json) => Json, unknown>({ name: "state", schema: Schema.Unknown as Schema.Decoder<Json>, input: Schema.Unknown as Schema.Decoder<(state: Json) => Json>, get initial() { return seed }, reduce: (state, work) => work(state) })
  const ownership = localOwners<ValueReference<unknown>>(encodeReference)
  const nativeReference = (ref: ValueReference<unknown>): Reference => {
    const locator = referenceLocator(ref, scope), root = locator.root
    if (locator.backend !== "reducer" || root.slice(32) !== "0".repeat(32)) throw new Error("Invalid reducer reference")
    return `${root.slice(0, 8)}-${root.slice(8, 12)}-${root.slice(12, 16)}-${root.slice(16, 20)}-${root.slice(20, 32)}` as Reference
  }
  const exists = (reference: string) => sqlite.execute("SELECT 1 FROM grove_state_versions WHERE scope=? AND reference=?", [scope, reference]).length > 0
  const open = (root: string) => {
    const reference = `${root.slice(0, 8)}-${root.slice(8, 12)}-${root.slice(12, 16)}-${root.slice(16, 20)}-${root.slice(20, 32)}` as Reference
    const staged = pending.get(reference)
    if (staged) return staged
    if (!exists(reference)) throw new Error("Snapshot expired or missing")
    return live.get(reference)?.deref() ?? materialization.open(reference)
  }
  const at = (value: Json, path: Path): Json => {
    for (const key of path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Missing JSON path")
      value = (value as Readonly<Record<string, Json>>)[key]!
    }
    return value
  }
  const values = storedValues(scope, {
    read: (root, path) => at(open(root).value, path),
    length: (root, path) => { const value = at(open(root).value, path); if (!Array.isArray(value)) throw new Error("Length requires array"); return value.length },
    scan: function* (root, path, range, each) {
      const value = at(open(root).value, path)
      if (!Array.isArray(value)) throw new Error("Scan requires array")
      const { start, end } = range ?? { start: 0, end: value.length }
      if (start < 0 || end < start || end > value.length) throw new Error("Invalid selection range")
      for (let i = start; i < end; i++) yield each ? at(value[i]!, each) : value[i]!
    },
  })
  const refFor = (version: Version<Json>, path: Path = [], each?: Path, range?: ValueRange) => {
    const reference = version.reference
    if (!exists(reference)) pending.set(reference, version)
    live.set(reference, new WeakRef(version))
    const token = Object.freeze({}) as Selection<Json>
    values.register(token, { backend: "reducer", root: reference.replaceAll("-", "") + "0".repeat(32), path, ...(each === undefined ? {} : { each }), ...(range === undefined ? {} : { range }) })
    return { token, reference: values.reference(token) }
  }
  const initial = (value: Json) => { seed = value; try { return materialization.initial() } finally { seed = null } }
  const materialize = <State extends Json, Event, Metadata>(options: PlainOptions<State, Event, Metadata>): PlainBinding<State, Event, Metadata> => {
    const schema = Schema.toType(options.schema), valid = Schema.decodeUnknownExit(schema, { onExcessProperty: "error" }), owned = new WeakSet<object>()
    const check = (value: unknown): State => { if (Exit.isFailure(valid(value))) { Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value); throw new Error("Invalid durable state") }; return value as State }
    const wrap = (source: Version<Json>, checked = false): PlainVersion<State, Event, Metadata> => {
      const value = checked ? source.value as State : check(source.value)
      let reference: ValueReference<State> | undefined
      const version: PlainVersion<State, Event, Metadata> = Object.freeze({ value, get reference() { return reference ??= refFor(source).reference as ValueReference<State> },
        apply: (event: Event, metadata: Metadata, sequence: number) => {
          const next = materialization.apply(source, { sequence, metadata, event: state => { const next = options.reduce(state as State, event, metadata, sequence); return Object.is(next, state) ? state : check(next) } })
          return Object.is(next.value, value) ? version : wrap(next, true)
        },
        update: (next: unknown) => Object.is(next, value) ? version : wrap(initial(check(next)), true),
        selectEach: (path: Path, each: Path, range?: ValueRange) => refFor(source, path, each, range).token as Selection<never>,
      })
      owned.add(version)
      rememberState(value, version.selectEach)
      return version
    }
    return {
      initial: value => wrap(initial(check(value)), true),
      open: ref => { const location = referenceLocator(ref, scope); nativeReference(ref); if (location.path.length || location.each !== undefined || location.range !== undefined) throw new Error("State requires whole-document reference"); return wrap(open(location.root)) },
      check: version => { if (!owned.has(version)) throw new Error("Foreign materializer"); return version },
    }
  }
  const retained = () => ownership.held().map(nativeReference)
  return {
    materialize, capture: (value: Json) => refFor(initial(value)).reference, reference: values.reference, view: ((...args: Parameters<typeof values.view>) => { nativeReference(args[0]); return values.view(...args) }) as typeof values.view, nativeReference,
    hold: (holder: object, name: string, ref: ValueReference<unknown>) => { nativeReference(ref); ownership.hold(holder, name, ref) },
    release: ownership.release, held: ownership.held, drainHeld: ownership.drain, holderCount: () => ownership.size,
    retain: (tx: Transaction, owner: string, ref: ValueReference<unknown>) => {
      const reference = nativeReference(ref)
      native.retain(tx, owner, reference)
      coordinator.guard(tx).committed.push(() => { pending.delete(reference) })
    },
    releaseOwner: (tx: Transaction, owner: string, ref: ValueReference<unknown>) => native.release(tx, owner, { expected: nativeReference(ref) }),
    collect: () => { native.collect(retained()); for (const reference of live.keys()) if (!pending.has(reference) && !exists(reference)) live.delete(reference) },
    discard: () => { const keep = new Set(retained()); native.discard([...keep]); for (const reference of pending.keys()) if (!keep.has(reference as Reference)) pending.delete(reference) },
    stats: native.stats,
  }
}
