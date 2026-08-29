// DriverPolicy controls graph-wide thread scheduling. The cap counts live thread settlements; each
// thread still admits one settlement at a time (tla/runtime/ConcurrentDriver.tla,
// ConcurrencyBound and ThreadExclusive).
export interface DriverPolicy {
  readonly maxConcurrentThreads: number
}

// DEFAULT_MAX_CONCURRENT_THREADS is the host's visible settlement capacity when none is stated.
export const DEFAULT_MAX_CONCURRENT_THREADS = 4

// DEFAULT_DRIVER_POLICY is the complete default scheduling policy.
export const DEFAULT_DRIVER_POLICY: DriverPolicy = {
  maxConcurrentThreads: DEFAULT_MAX_CONCURRENT_THREADS
}

// driverPolicyOf resolves and validates the policy where a host is constructed.
export const driverPolicyOf = (policy: Partial<DriverPolicy> = {}): DriverPolicy => {
  const maxConcurrentThreads = policy.maxConcurrentThreads ?? DEFAULT_DRIVER_POLICY.maxConcurrentThreads
  if (!Number.isSafeInteger(maxConcurrentThreads) || maxConcurrentThreads <= 0) {
    throw new Error(`driver maxConcurrentThreads must be a positive integer, got ${JSON.stringify(maxConcurrentThreads)}`)
  }
  return { maxConcurrentThreads }
}

export interface ThreadDriver {
  // mark records that a thread owes a settlement pass.
  readonly mark: (thread: string) => void
  // drain settles every owed thread while respecting the configured capacity.
  readonly drain: () => Promise<void>
  // resting reports scheduler quiescence across durable debt and live settlements.
  readonly resting: () => boolean
  // work counts threads that are dirty, live, or both.
  readonly work: () => number
}

interface ThreadDriverOptions {
  readonly serve: (thread: string) => Promise<void>
  readonly pick?: (dirty: ReadonlySet<string>) => string
  readonly policy?: Partial<DriverPolicy>
}

// createThreadDriver schedules distinct threads concurrently and keeps an active thread dirty when a
// delivery reaches it mid-settlement. A failed settlement releases its slot and restores the
// thread's durable debt (tla/runtime/ConcurrentDriver.tla, ConcurrencyBound and Accounting).
export const createThreadDriver = (options: ThreadDriverOptions): ThreadDriver => {
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

  const mark = (thread: string): void => {
    if (dirty.has(thread)) return
    dirty.add(thread)
    const previous = changed
    changed = pulse()
    previous.send()
  }

  const work = (): number => new Set([...dirty, ...inFlight]).size
  const eligible = (): Set<string> => new Set([...dirty].filter((thread) => !inFlight.has(thread)))

  const drain = async (): Promise<void> => {
    const active = new Map<string, Promise<void>>()
    let failure: { readonly cause: unknown } | undefined

    const launch = (thread: string): void => {
      dirty.delete(thread)
      inFlight.add(thread)
      const task = Promise.resolve()
        .then(() => options.serve(thread))
        .catch((cause: unknown) => {
          dirty.add(thread)
          failure ??= { cause }
        })
        .finally(() => {
          inFlight.delete(thread)
          active.delete(thread)
        })
      active.set(thread, task)
    }

    for (;;) {
      while (failure === undefined && active.size < policy.maxConcurrentThreads) {
        const candidates = eligible()
        if (candidates.size === 0) break
        let thread: string
        try {
          thread = options.pick?.(candidates) ?? (candidates.values().next().value as string)
          if (!candidates.has(thread)) {
            throw new Error(`driver pick returned ineligible thread ${JSON.stringify(thread)}`)
          }
        } catch (cause) {
          failure = { cause }
          break
        }
        launch(thread)
      }

      if (active.size === 0) break
      const completions = [...active.values()]
      if (failure === undefined && active.size < policy.maxConcurrentThreads) {
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
