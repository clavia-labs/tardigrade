import type { Atom } from "@clavia/tardigrade-experimental-core"
import type { ThreadCoordinate } from "../supervisor"

export interface Selection<Value> {
  readonly get: () => Value
  readonly subscribe: (listener: (value: Value, previous: Value) => void) => () => void
}

export interface ProjectionSource {
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
}

// select exposes a projection's current value and subsequent changes until unsubscribed.
export function select<Value>(source: ProjectionSource, node: Atom<Value>): Selection<Value> {
  return {
    get: () => source.get(node),
    subscribe: listener => {
      let previous = source.get(node)
      return source.sub(node, () => {
        const value = source.get(node)
        if (Object.is(value, previous)) return
        const before = previous
        previous = value
        listener(value, before)
      })
    },
  }
}

// createThreadStore observes projections in an existing thread runtime without owning its lifetime.
export function createThreadStore(coordinate: ThreadCoordinate, source: ProjectionSource) {
  return {
    coordinate: Object.freeze({ ...coordinate }),
    select: <Value>(node: Atom<Value>): Selection<Value> => select(source, node),
  }
}

export type ThreadStore = ReturnType<typeof createThreadStore>
