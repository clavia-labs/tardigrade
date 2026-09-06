import type { ActorDO } from "./actor"
import type { ThreadDO } from "./thread"

export interface Env {
  readonly ACTORS: DurableObjectNamespace<ActorDO>
  readonly THREADS: DurableObjectNamespace<ThreadDO>
  readonly CATALOG_DB: D1Database
  readonly LOADER: WorkerLoader
  readonly TARDIGRADE_CONFIG?: unknown
  readonly TARDIGRADE_BACKGROUND_TASK_OWNER?: string
  readonly TARDIGRADE_TOKEN?: string
  readonly TARDIGRADE_MODEL_CATALOG_URL?: string
  readonly TARDIGRADE_MODEL_CATALOG_LOAD_POLICY?: string
  readonly TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS?: string
  readonly TARDIGRADE_ALARM_DELAY_MILLIS?: string
  readonly TARDIGRADE_COMPACTION_FIRE_RATIO?: string
  readonly TARDIGRADE_COMPACTION_KEEP_RATIO?: string
  readonly TARDIGRADE_SANDBOX_LOG_CAP_BYTES?: string
  readonly TARDIGRADE_SANDBOX_CPU_MILLIS?: string
  readonly TARDIGRADE_SANDBOX_SUBREQUESTS?: string
  readonly TARDIGRADE_SANDBOX_TRANSPORT?: string
}
