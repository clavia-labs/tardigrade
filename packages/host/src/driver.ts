// DriverPolicy controls graph-wide lane scheduling. The cap counts live lane settlements; each
// lane still admits one settlement at a time (tla/runtime/ConcurrentDriver.tla,
// ConcurrencyBound and LaneExclusive).
export interface DriverPolicy {
  readonly maxConcurrentLanes: number
}

// DEFAULT_MAX_CONCURRENT_LANES is the host's visible settlement capacity when none is stated.
export const DEFAULT_MAX_CONCURRENT_LANES = 4

// DEFAULT_DRIVER_POLICY is the complete default scheduling policy.
export const DEFAULT_DRIVER_POLICY: DriverPolicy = {
  maxConcurrentLanes: DEFAULT_MAX_CONCURRENT_LANES
}

// driverPolicyOf resolves and validates the policy where a host is constructed.
export const driverPolicyOf = (policy: Partial<DriverPolicy> = {}): DriverPolicy => {
  const maxConcurrentLanes = policy.maxConcurrentLanes ?? DEFAULT_DRIVER_POLICY.maxConcurrentLanes
  if (!Number.isSafeInteger(maxConcurrentLanes) || maxConcurrentLanes <= 0) {
    throw new Error(`driver maxConcurrentLanes must be a positive integer, got ${JSON.stringify(maxConcurrentLanes)}`)
  }
  return { maxConcurrentLanes }
}

export interface LaneDriver {
  // mark records that a lane owes a settlement pass.
  readonly mark: (lane: string) => void
  // drain settles every owed lane while respecting the configured capacity.
  readonly drain: () => Promise<void>
  // resting reports scheduler quiescence across durable debt and live settlements.
  readonly resting: () => boolean
  // work counts lanes that are dirty, live, or both.
  readonly work: () => number
}

interface LaneDriverOptions {
  readonly serve: (lane: string) => Promise<void>
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly policy?: Partial<DriverPolicy>
}

// createLaneDriver schedules distinct lanes concurrently and keeps an active lane dirty when a
// delivery reaches it mid-settlement. A failed settlement releases its slot and restores the
// lane's durable debt (tla/runtime/ConcurrentDriver.tla, ConcurrencyBound and Accounting).
export const createLaneDriver = (options: LaneDriverOptions): LaneDriver => {
  const policy = driverPolicyOf(options.policy)
  const dirty = new Set<string>()
  const inFlight = new Set<string>()
  const pulse = (): { readonly promise: Promise<void>; readonly send: () => void } => {
    let send!: () => void
    const promise = new Promise<void>((resolve) => {
      send = resolve
    })
    return { promise, send }
  }
  let changed = pulse()

  const mark = (lane: string): void => {
    if (dirty.has(lane)) return
    dirty.add(lane)
    const previous = changed
    changed = pulse()
    previous.send()
  }

  const work = (): number => new Set([...dirty, ...inFlight]).size
  const eligible = (): Set<string> => new Set([...dirty].filter((lane) => !inFlight.has(lane)))

  const drain = async (): Promise<void> => {
    const active = new Map<string, Promise<void>>()
    let failure: { readonly cause: unknown } | undefined

    const launch = (lane: string): void => {
      dirty.delete(lane)
      inFlight.add(lane)
      const task = Promise.resolve()
        .then(() => options.serve(lane))
        .catch((cause: unknown) => {
          dirty.add(lane)
          failure ??= { cause }
        })
        .finally(() => {
          inFlight.delete(lane)
          active.delete(lane)
        })
      active.set(lane, task)
    }

    for (;;) {
      while (failure === undefined && active.size < policy.maxConcurrentLanes) {
        const candidates = eligible()
        if (candidates.size === 0) break
        let lane: string
        try {
          lane = options.pick?.(candidates) ?? (candidates.values().next().value as string)
          if (!candidates.has(lane)) {
            throw new Error(`driver pick returned ineligible lane ${JSON.stringify(lane)}`)
          }
        } catch (cause) {
          failure = { cause }
          break
        }
        launch(lane)
      }

      if (active.size === 0) break
      const completions = [...active.values()]
      if (failure === undefined && active.size < policy.maxConcurrentLanes) {
        const notification = changed.promise
        if (eligible().size > 0) continue
        await Promise.race([...completions, notification])
      } else {
        await Promise.race(completions)
      }
    }

    if (failure !== undefined) throw failure.cause
  }

  return {
    mark,
    drain,
    resting: () => dirty.size === 0 && inFlight.size === 0,
    work
  }
}
