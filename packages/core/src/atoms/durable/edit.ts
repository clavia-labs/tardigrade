import type { Schema } from "effect"
import type { Json, MerkleTree, Mutations } from "@tardie/grove"
export type Editor<State> = Mutations<State, void> & Pick<MerkleTree<State>, "read" | "has" | "length" | "slice">
import { documentAtom, type CheckpointReader } from "./merkle"
import type { RecordMetadata } from "../../services/journal"

// editAtom binds explicit reducers to document views (properties/durable-state.test.ts).
export function editAtom<State extends Json, Event>(options: {
  readonly name: string; readonly schema: Schema.Decoder<State>; readonly input: Schema.Schema<Event>; readonly initial: State
  readonly edit: (editor: Editor<State>, event: Event, metadata: RecordMetadata, position: number) => void
  readonly initialize?: (read: CheckpointReader) => State
  readonly restore?: (state: MerkleTree<State>, read: CheckpointReader) => MerkleTree<State>
}) {
  return documentAtom({ ...options, reduce: (root, event, metadata, position) => {
    let current = root, active = true
    const check = () => { if (!active) throw new Error("Editor expired") }
    const editor: Editor<State> = {
      read: path => { check(); return current.read(path) }, has: path => { check(); return current.has(path) },
      length: path => { check(); return current.length(path) }, slice: (path, start, end) => { check(); return current.slice(path, start, end) },
      set: (path, value) => { check(); current = current.set(path, value) },
      remove: path => { check(); current = (current.remove as (target: typeof path) => MerkleTree<State>)(path) },
      append: (path, values) => { check(); current = current.append(path, values) },
      splice: (path, start, count, values) => { check(); current = current.splice(path, start, count, values) },
    }
    try { const result: unknown = options.edit(editor, event, metadata, position); if (result !== undefined) throw new Error("Edit callbacks must return undefined"); return current }
    finally { active = false }
  } })
}
