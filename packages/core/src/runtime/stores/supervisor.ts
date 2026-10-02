import { threads } from "../../services/supervisor/graph"
import { select, type ProjectionSource } from "./thread"

// createSupervisorStore observes thread allocations in an existing supervisor runtime without owning its lifetime.
export function createSupervisorStore(source: ProjectionSource) {
  return { threads: select(source, threads) }
}

export type SupervisorStore = ReturnType<typeof createSupervisorStore>
