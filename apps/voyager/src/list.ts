import type { ActorThread } from "@clavia/tardigrade-client"

// RootRow describes one root and the family it started.
export interface RootRow {
  readonly id: string
  // family counts descendants at every depth.
  readonly family: number
}

// List describes the root rows in the rail.
export interface List {
  readonly roots: ReadonlyArray<RootRow>
}

export const latestRootOf = (list: List): RootRow | undefined => list.roots.at(-1)

// rootOf resolves a thread to its root and stops at a parent cycle.
const rootOf = (id: string, parents: ReadonlyMap<string, string | undefined>): string => {
  const walked = new Set<string>([id])
  let here = id
  for (;;) {
    const parent = parents.get(here)
    if (parent === undefined || walked.has(parent)) return here
    walked.add(parent)
    here = parent
  }
}

// listOf projects actor threads into roots in registration order.
export const listOf = (threads: ReadonlyArray<ActorThread>): List => {
  const parents = new Map(threads.map((thread) => [thread.id, thread.parent]))
  const family = new Map<string, number>()
  for (const thread of threads) {
    if (thread.parent === undefined) continue
    const root = rootOf(thread.id, parents)
    family.set(root, (family.get(root) ?? 0) + 1)
  }
  return {
    roots: threads
      .filter((thread) => thread.parent === undefined)
      .map((thread) => ({
        id: thread.id,
        family: family.get(thread.id) ?? 0
      }))
  }
}

// matches reports whether an ID contains a case-insensitive query.
export const matches = (id: string, query: string): boolean =>
  id.toLowerCase().includes(query.trim().toLowerCase())
