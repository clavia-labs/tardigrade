import type { DurableObjectStorage } from "@cloudflare/workers-types"
import type { SchedulerStorage } from "@clavia/tardigrade-core"
import type { CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import { cloudflareNativeRecovery } from "../../../src/cloudflare/native-recovery"

// cloudflareSchedulerStorage commits SQL recovery before flushing and synchronizing the alarm (test/workerd/watchdog.workers.ts).
export function cloudflareSchedulerStorage(storage: DurableObjectStorage, alarms?: CloudflareAlarmOptions): SchedulerStorage {
  const recovery = cloudflareNativeRecovery(storage, alarms)
  return { transaction: work => recovery.transaction(tx => work(tx.scheduler)) }
}
