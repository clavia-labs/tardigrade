import { Schema, SchemaAST } from "effect"
import { encodeReference, tree, type Json, type ValueReference } from "@tardie/grove"
import { rememberState, type PlainVersion } from "@tardie/grove/reducer"
import * as migrations from "@tardie/grove/migrations"
import { DocumentState, type DocumentSession } from "../../services/tree-state"
import { durableProjection } from "./projection"
import { incrementalDecoder } from "../incremental/decode"
import { frozenPlainData } from "../incremental/frozen"
import { incrementalValidator, invalid } from "../incremental/validate"
import type { RecordMetadata } from "../../services/journal"
import type { CheckpointReader } from "./merkle"
import type { EventLog } from "../../services/event-log"
export { selectEach } from "@tardie/grove/reducer"

// plainAtom exposes JSON reducers while storage owns incremental materialisation (properties/durable-state.test.ts).
export function plainAtom<State extends Json, Event>(options: {
  readonly name: string
  readonly schema: Schema.Decoder<State>
  readonly input: Schema.Schema<Event>
  readonly initial: State
  readonly reduce: (state: State, event: Event, metadata: RecordMetadata, position: number) => State
  readonly initialize?: (read: CheckpointReader) => State
  readonly restore?: (state: State, read: CheckpointReader) => State
  readonly migrate?: (stored: unknown) => unknown
}) {
  type Version = PlainVersion<State, Event, RecordMetadata>
  const memoryVersions = new WeakSet<object>()
  const fast = incrementalValidator(options.schema)
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const check = (value: unknown): State => {
    const parsed = fast.parse(value)
    if (parsed !== invalid) return parsed as State
    validate(value)
    return value as State
  }
  const memory = (session: DocumentSession) => {
    const bound = session.bind(tree(Schema.suspend(() => Schema.Json))), owned = new WeakSet<object>()
    const wrap = (source: ReturnType<typeof bound.initial>): Version => {
      const value = source.read([] as never) as State
      const version: Version = { value, reference: source.reference as ValueReference<State>,
        apply: (event, metadata, position) => version.update(options.reduce(value, event, metadata, position)),
        update: next => Object.is(next, value) ? version : wrap(source.set([] as never, check(next) as never)),
        selectEach: (path, each, range) => {
          const at = (value: Json, keys: readonly (string | number)[]) => keys.reduce<Json>((node, key) => {
            if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) throw new Error("Missing JSON path")
            return (node as Readonly<Record<string, Json>>)[key]!
          }, value)
          const array = at(value, path)
          if (!Array.isArray(array)) throw new Error("Selection target must be an array")
          return session.bind(tree(Schema.Array(Schema.Json))).initial(array.map(item => at(item, each))).selectEach([], [], range) as never
        },
      }
      owned.add(version); memoryVersions.add(version); rememberState(value, version.selectEach); return version
    }
    return {
      initial: (value: unknown) => wrap(bound.initial(check(value))),
      open: (reference: string) => {
        const value = session.read(reference)
        return wrap(bound.initial(check(options.migrate ? options.migrate(value) : value)))
      },
      check: (version: Version) => { if (!owned.has(version)) throw new Error("Foreign materializer"); return version },
    }
  }
  const makeBound = (session: DocumentSession) => session.materialize ? session.materialize(options) : memory(session)
  const bindings = new WeakMap<DocumentSession, ReturnType<typeof makeBound>>()
  const binding = (service: typeof EventLog.Service) => {
    if (!service.documents) throw new Error(`Durable atom "${options.name}" requires synchronous materialisation`)
    let known = bindings.get(service.documents)
    if (!known) { known = makeBound(service.documents); bindings.set(service.documents, known) }
    return known
  }
  const checkpointReader = (service: typeof EventLog.Service): CheckpointReader => (name, schema) => {
    const configured = service.initialState, seed = typeof configured === "function" ? configured() : configured
    const stored = seed?.state.get(name)
    if (stored === undefined) return undefined
    const raw = migrations.read(stored, reference => service.documents!.read(reference))
    return Schema.decodeSync(schema)(raw)
  }
  const prepare = (raw: unknown) => options.migrate ? options.migrate(raw) : raw
  const decodeState = Schema.decodeUnknownSync(options.schema, { onExcessProperty: "error" })
  const decode = (raw: unknown) => fast.trust(decodeState(prepare(raw))) as State
  const encode = (Schema.encodeUnknownSync as unknown as (schema: Schema.Decoder<State>) => (value: unknown) => unknown)(options.schema)
  const encodeFrozen = SchemaAST.flip(options.schema.ast) === options.schema.ast ? incrementalDecoder(options.schema) : undefined
  const encodeState = (value: State) => typeof value === "object" && value !== null && frozenPlainData.has(value) ? encodeFrozen?.(value)?.value ?? encode(value) : encode(value)
  const snapshots = new WeakMap<object, { state: typeof DocumentState.Type; reference: string }>()
  const capture = (version: Version): { readonly state: unknown; readonly reference?: string } => {
    if (memoryVersions.has(version)) return { state: encodeState(version.value) }
    let saved = snapshots.get(version)
    if (!saved) { const reference = encodeReference(version.reference); saved = { state: { _tag: "DocumentState", reference }, reference }; snapshots.set(version, saved) }
    return saved
  }
  return durableProjection<Version, Event, State>({ ...options, reduce: (version, event, metadata, position) => version.apply(event, metadata, position) }, {
    initial: service => binding(service).initial(options.initialize ? options.initialize(checkpointReader(service)) : options.initial),
    restore: (stored, service) => {
      const bound = binding(service)
      const version = migrations.open(stored, { initial: bound.initial, reference: bound.open, decode: decodeState, migrate: options.migrate })
      return options.restore ? version.update(options.restore(version.value, checkpointReader(service))) : version
    },
    check: (version, service) => binding(service).check(version),
    hold: (version, service) => service.documents!.hold(service, options.name, encodeReference(version.reference)),
    view: version => version.value,
    capture,
    state: { name: options.name, decode, encode: value => encodeState(value as State) },
  })
}
