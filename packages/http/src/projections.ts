import type { TreeBounds } from "@clavia/tardigrade-client/contract"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { formatThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
export type ThreadStatus = "settled" | "running" | "blocked" | "failed"

export type ThreadStatusOf = (events: ReadonlyArray<Event>) => ThreadStatus

const numberAt = (event: Event): number | undefined => {
  const at = (event as { at?: unknown }).at
  return typeof at === "number" ? at : undefined
}

// ThreadSummary is one row of GET /v1/threads: what a thread is, without its events. `parent` is absent
// for a root, and `lastAt` for a thread whose events carry no timestamp.
export interface ThreadSummary {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly events: number
  readonly lastAt?: number
  readonly status: ThreadStatus
}

// summaryOf projects one created thread log into its row. The child's creation event supplies depth, while treeOf resolves its parent address to the API id in this listing.
export const summaryOf = (id: string, events: ReadonlyArray<Event>, statusOf: ThreadStatusOf, parent?: string): ThreadSummary => {
  const created = threadCreatedOf(events)
  if (created === undefined) throw new Error(`thread ${JSON.stringify(id)} has no ThreadCreated first event`)
  let lastAt: number | undefined
  for (const event of events) {
    const at = numberAt(event)
    if (at !== undefined) lastAt = at
  }
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    depth: created.depth,
    events: events.length,
    ...(lastAt === undefined ? {} : { lastAt }),
    status: statusOf(events)
  }
}

// ThreadNode is a summary with the threads it spawned, the shape GET /v1/threads/:id/tree serves.
export interface ThreadNode extends ThreadSummary {
  readonly children: ReadonlyArray<ThreadNode>
}

// firstAt is the log's own start, the order the forest is listed in. A log with no timestamp sorts
// last rather than first, so an untimed thread never displaces a real one.
const firstAt = (events: ReadonlyArray<Event>): number => {
  for (const event of events) {
    const at = numberAt(event)
    if (at !== undefined) return at
  }
  return Number.POSITIVE_INFINITY
}

// treeOf builds a forest within the requested bounds; an unknown root returns undefined (apps/server/src/projections.test.ts).
export const treeOf = (
  logs: ReadonlyMap<string, ReadonlyArray<Event>>,
  statusOf: ThreadStatusOf,
  bounds: TreeBounds = {}
): ReadonlyArray<ThreadNode> | undefined => {
  const createdLogs = new Map([...logs].filter(([, events]) => events.length > 0))
  const idsByAddress = new Map<string, string>()
  for (const [id, events] of createdLogs) {
    const created = threadCreatedOf(events)
    if (created === undefined) throw new Error(`thread ${JSON.stringify(id)} has no ThreadCreated first event`)
    const address = formatThreadAddress(created.address)
    if (idsByAddress.has(address)) throw new Error(`thread address ${JSON.stringify(address)} appears in more than one log`)
    idsByAddress.set(address, id)
  }
  const parents = new Map<string, string>()
  for (const [parent, events] of createdLogs) {
    for (const event of events) {
      if (event.type !== "ChildCreated") continue
      const address = (event as { readonly address?: unknown }).address
      if (typeof address !== "object" || address === null) continue
      const value = address as { readonly actor?: unknown; readonly instance?: unknown; readonly thread?: unknown }
      if (typeof value.actor !== "string" || typeof value.instance !== "string" || typeof value.thread !== "string") continue
      const child = idsByAddress.get(formatThreadAddress({ actor: value.actor, instance: value.instance, thread: value.thread }))
      if (child !== undefined && child !== parent) parents.set(child, parent)
    }
  }
  const order = (a: string, b: string): number =>
    (firstAt(createdLogs.get(a) ?? []) - firstAt(createdLogs.get(b) ?? [])) || (a < b ? -1 : a > b ? 1 : 0)
  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of parents) {
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [child])
    else siblings.push(child)
  }
  const root = bounds.root
  if (root !== undefined && !createdLogs.has(root)) return undefined
  const walked = new Set<string>()
  let remaining = bounds.maxNodes
  const node = (id: string, parent: string | undefined, level: number): ThreadNode | undefined => {
    if (remaining !== undefined && remaining <= 0) return undefined
    walked.add(id)
    if (remaining !== undefined) remaining -= 1
    const events = createdLogs.get(id) ?? []
    const children: ThreadNode[] = []
    if ((bounds.maxDepth === undefined || level < bounds.maxDepth) && remaining !== 0) {
      for (const child of (childrenOf.get(id) ?? []).filter((child) => !walked.has(child)).sort(order)) {
        const built = node(child, id, level + 1)
        if (built === undefined) break
        children.push(built)
      }
    }
    return { ...summaryOf(id, events, statusOf, parent), children }
  }
  const starts = root === undefined
    ? [...createdLogs.keys()].filter((id) => !parents.has(id)).sort(order)
    : [root]
  const tree: ThreadNode[] = []
  for (const id of starts) {
    const built = node(id, parents.get(id), 0)
    if (built === undefined) break
    tree.push(built)
  }
  return tree
}
