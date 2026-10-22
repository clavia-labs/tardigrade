import { threads, threadMetadata, threadByName, threadNameKey, threadPage } from "../../services/supervisor/graph"
import type { SupervisorPageOptions } from "../../services/supervisor/page"
import { select, type ProjectionSource } from "./thread"

// createSupervisorStore observes thread allocations in an existing supervisor runtime without owning its lifetime.
export function createSupervisorStore(source: ProjectionSource) {
  return {
    thread: (id: string) => select(source, threadMetadata(id)),
    threadByName: (parent: string | null, name: string) => select(source, threadByName(threadNameKey(parent, name))),
    page: (options: SupervisorPageOptions = {}) => select(source, threadPage(options)),
    threads: select(source, threads),
  }
}

export type SupervisorStore = ReturnType<typeof createSupervisorStore>
