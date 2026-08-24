// DEFAULT_ALARM_DELAY_MILLIS is the watchdog delay for work whose immediate drive does not settle.
export const DEFAULT_ALARM_DELAY_MILLIS = 120_000

export interface AlarmPolicy {
  readonly delayMillis: number
}

export const DEFAULT_ALARM_POLICY: AlarmPolicy = {
  delayMillis: DEFAULT_ALARM_DELAY_MILLIS
}

// alarmPolicyOf resolves and validates the actor alarm policy.
export const alarmPolicyOf = (policy: Partial<AlarmPolicy> = {}): AlarmPolicy => {
  const delayMillis = policy.delayMillis ?? DEFAULT_ALARM_POLICY.delayMillis
  if (!Number.isSafeInteger(delayMillis) || delayMillis < 0) {
    throw new Error(`alarm delayMillis must be a non-negative integer, got ${JSON.stringify(delayMillis)}`)
  }
  return { delayMillis }
}

// armAt returns a replacement alarm time when the standing alarm does not cover new work.
export const armAt = (due: number | null, now: number, delayMillis: number): number | null => {
  const at = now + delayMillis
  return due === null || due <= now || due > at ? at : null
}
