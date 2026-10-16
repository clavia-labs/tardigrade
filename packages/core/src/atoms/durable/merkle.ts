import { Schema } from "effect"
import type { Json } from "@tardie/grove"
import { treeSchema } from "@tardie/grove"
import { durableProjection } from "./projection"
import { TreeState, type MerkleTree, type TreeSession } from "../../services/tree-state"
import { EventLog } from "../../services/event-log"
import type { RecordMetadata } from "../../services/journal"

export type CheckpointReader = <Value extends Json>(name: string, schema: Schema.Decoder<Value>) => Value | undefined

// durableMerkleAtom folds structured edits into lazy JSON snapshots; storage must support synchronous tree reads.
export function durableMerkleAtom<State extends Json, Event>({ schema, initial, initialize, restore, migrate, ...options }: {
  readonly name: string
  readonly schema: Schema.Decoder<State>
  readonly input: Schema.Schema<Event>
  readonly initialize?: (read: CheckpointReader) => State
  readonly restore?: (state: MerkleTree<State>, read: CheckpointReader) => MerkleTree<State>
  // migrate prepares inline checkpoint state before validation; stored tree roots reopen directly (platform/test/bun/agent-compaction.test.ts).
  readonly migrate?: (stored: unknown) => unknown
  readonly initial: State
  readonly reduce: (state: MerkleTree<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => MerkleTree<State>
}) {
  const prepare = (value: unknown) => migrate ? migrate(value) : value
  treeSchema(schema.ast)
  const makeBound = (session: TreeSession) => session.bind(schema)
  const bindings = new WeakMap<TreeSession, ReturnType<typeof makeBound>>()
  const binding = (session?: TreeSession) => {
    if (!session) throw new Error("Tree-backed atoms require synchronous tree storage")
    let bound = bindings.get(session)
    if (!bound) { bound = makeBound(session); bindings.set(session, bound) }
    return bound
  }
  const readCheckpoint = (service: typeof EventLog.Service) => {
    const configured = service.initialState
    const seed = typeof configured === "function" ? configured() : configured
    const read: CheckpointReader = (name, schema) => {
      const stored = seed?.state.get(name)
      return stored === undefined ? undefined : Schema.is(TreeState)(stored)
        ? Schema.decodeSync(schema)(service.trees!.read(stored.root))
        : Schema.decodeSync(schema)(stored)
    }
    return read
  }
  return durableProjection(options, {
    initial: service => binding(service.trees).initial(initialize ? initialize(readCheckpoint(service)) : initial),
    restore: (value, service) => {
      const bound = binding(service.trees)
      const view = Schema.is(TreeState)(value) ? bound.open(value.root) : bound.initial(prepare(value))
      return restore ? bound.check(restore(view, readCheckpoint(service))) : view
    },
    check: (view, service) => binding(service.trees).check(view),
    hold: (view, service) => service.trees?.hold(service, options.name, view.root),
    state: {
      name: options.name,
      decode: value => Schema.decodeUnknownSync(schema)(prepare(value)),
      encode: value => ({ _tag: "TreeState", root: (value as MerkleTree<State>).root }),
      tree: value => (value as MerkleTree<State>).root,
    },
  })
}
