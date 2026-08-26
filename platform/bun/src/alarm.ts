export interface BunAlarmHandle {
  readonly cancel: () => void
}

export interface BunAlarmScheduler {
  // schedule returns before fire can run, so the host can publish the corresponding handle (alarm.test.ts, "returns an overdue alarm handle before firing").
  readonly schedule: (
    deadlineAt: number,
    fire: (at: number) => Promise<void>
  ) => BunAlarmHandle
}

// MAX_BUN_ALARM_DELAY_MS is the longest delay accepted by Bun's timer implementation.
export const MAX_BUN_ALARM_DELAY_MS = 2_147_483_647

// bunAlarmScheduler waits for an absolute deadline and rechecks the wall clock after long waits.
export const bunAlarmScheduler: BunAlarmScheduler = {
  schedule: (deadlineAt, fire) => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (cancelled) return
      const remaining = deadlineAt - Date.now()
      if (remaining > 0) {
        timer = setTimeout(arm, Math.min(remaining, MAX_BUN_ALARM_DELAY_MS))
        return
      }
      timer = setTimeout(() => { void fire(Date.now()) }, 0)
    }
    arm()
    return {
      cancel: () => {
        cancelled = true
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
}
