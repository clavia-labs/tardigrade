import type { DurableObjectStorage } from "@cloudflare/workers-types"
import type { WatchdogStorage } from "@clavia/tardigrade-core"
import type { CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import { cloudflareNativeRecovery } from "./native-recovery"

// cloudflareWatchdogStorage commits SQL recovery before flushing and synchronizing the alarm (test/workerd/watchdog.workers.ts).
export function cloudflareWatchdogStorage(storage: DurableObjectStorage, alarms?: CloudflareAlarmOptions): WatchdogStorage {
  const recovery = cloudflareNativeRecovery(storage, alarms)
  return { transaction: work => recovery.transaction(tx => work(tx.watchdog)) }
}
