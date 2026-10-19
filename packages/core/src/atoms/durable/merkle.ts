import { Schema } from "effect"
import type { Json } from "@tardie/grove"
import { encodeReference, treeSchema } from "@tardie/grove"
import * as migrations from "@tardie/grove/migrations"
import { durableProjection } from "./projection"
import { type MerkleTree, type DocumentSession } from "../../services/tree-state"
import { EventLog } from "../../services/event-log"
import type { RecordMetadata } from "../../services/journal"

export type CheckpointReader = <Value extends Json>(name: string, schema: Schema.Decoder<Value>) => Value | undefined

export interface DocumentOptions<State extends Json, Event> {
  readonly name: string
  readonly schema: Schema.Decoder<State>
  readonly input: Schema.Schema<Event>
  readonly initialize?: (read: CheckpointReader) => State
  readonly restore?: (state: MerkleTree<State>, read: CheckpointReader) => MerkleTree<State>
  // migrate prepares inline checkpoint state before validation; stored references reopen directly (platform/test/bun/agent-compaction.test.ts).
  readonly migrate?: (stored: unknown) => unknown
  readonly initial: State
  readonly reduce: (state: MerkleTree<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => MerkleTree<State>
}

// documentAtom folds collection edits into lazy JSON snapshots (properties/collections.test.ts).
export function documentAtom<State extends Json, Event>({ schema, initial, initialize, restore, migrate, ...options }: DocumentOptions<State, Event>) {
  const snapshot = (view: MerkleTree<State>) => {
    return encodeReference(view.reference)
  }
  const prepare = (value: unknown) => migrate ? migrate(value) : value
  treeSchema(schema.ast)
  const makeBound = (session: DocumentSession) => session.bind(schema)
  const bindings = new WeakMap<DocumentSession, ReturnType<typeof makeBound>>()
  const binding = (session?: DocumentSession) => {
    if (!session) throw new Error(`Durable atom "${options.name}" requires synchronous documents; use createStore or supply EventLog.documents with memoryDocuments() or storedSession(...)`)
    let bound = bindings.get(session)
    if (!bound) { bound = makeBound(session); bindings.set(session, bound) }
    return bound
  }
  const readCheckpoint = (service: typeof EventLog.Service) => {
    const configured = service.initialState
    const seed = typeof configured === "function" ? configured() : configured
    const read: CheckpointReader = (name, schema) => {
      const stored = seed?.state.get(name)
      return stored === undefined ? undefined : Schema.decodeSync(schema)(migrations.read(stored, reference => service.documents!.read(reference)))
    }
    return read
  }
  return durableProjection(options, {
    initial: service => binding(service.documents).initial(initialize ? initialize(readCheckpoint(service)) : initial),
    restore: (value, service) => {
      const bound = binding(service.documents)
      const view = migrations.open(value, { initial: bound.initial, reference: bound.open, decode: state => state, migrate })
      return restore ? bound.check(restore(view, readCheckpoint(service))) : view
    },
    check: (view, service) => binding(service.documents).check(view),
    hold: (view, service) => service.documents?.hold(service, options.name, snapshot(view)),
    state: {
      name: options.name,
      decode: value => Schema.decodeUnknownSync(schema)(prepare(value)),
      encode: value => ({ _tag: "DocumentState", reference: snapshot(value as MerkleTree<State>) }),
      reference: value => snapshot(value as MerkleTree<State>),
    },
  })
}

/**
 * durableMerkleAtom preserves explicit Grove reducer authoring (properties/collections.test.ts).
 * @deprecated Use durableAtom with tree(schema), appendOnly or keyValue declarations.
 */
export function durableMerkleAtom<State extends Json, Event>(options: DocumentOptions<State, Event>) {
  const node = documentAtom(options)
  console.warn(`durableMerkleAtom "${options.name}" is deprecated; use durableAtom with tree(schema), appendOnly or keyValue declarations`)
  return node
}
