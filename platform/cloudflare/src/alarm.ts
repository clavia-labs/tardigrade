// DEFAULT_ALARM_DELAY_MILLIS is the recovery wake delay for work whose immediate drive does not settle.
export const DEFAULT_ALARM_DELAY_MILLIS = 120_000

export interface AlarmPolicy {
  readonly recoveryDelayMillis: number
}

export const DEFAULT_ALARM_POLICY: AlarmPolicy = {
  recoveryDelayMillis: DEFAULT_ALARM_DELAY_MILLIS
}

// alarmPolicyOf resolves and validates the actor alarm policy.
export const alarmPolicyOf = (policy: Partial<AlarmPolicy> = {}): AlarmPolicy => {
  const recoveryDelayMillis = policy.recoveryDelayMillis ?? DEFAULT_ALARM_POLICY.recoveryDelayMillis
  if (!Number.isSafeInteger(recoveryDelayMillis) || recoveryDelayMillis < 0) {
    throw new Error(`alarm recoveryDelayMillis must be a non-negative integer, got ${JSON.stringify(recoveryDelayMillis)}`)
  }
  return { recoveryDelayMillis }
}

// armAt returns a replacement alarm time when the standing alarm does not cover new work.
export const armAt = (due: number | null, now: number, recoveryDelayMillis: number): number | null => {
  const at = now + recoveryDelayMillis
  return due === null || due <= now || due > at ? at : null
}

// scheduledAlarmAt selects the standing Durable Object alarm for recovery work and method deadlines (alarm.test.ts, "active work keeps the earliest recovery or method wake").
export const scheduledAlarmAt = (
  current: number | null,
  resting: boolean,
  now: number,
  recoveryDelayMillis: number,
  methodDeadline: number | undefined
): number | null => {
  if (resting) return methodDeadline ?? null
  const recoveryWake = now + recoveryDelayMillis
  if (!Number.isSafeInteger(recoveryWake)) throw new Error("alarm recovery deadline must be a safe integer")
  const target = methodDeadline === undefined ? recoveryWake : Math.min(recoveryWake, methodDeadline)
  return current !== null && current > now && current <= target ? current : target
}
