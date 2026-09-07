import { readdir } from "node:fs/promises"

// bunInstances owns concurrent opening, recovery tasks, and shutdown of actor instances (instances.test.ts).
export const bunInstances = <Runtime extends { readonly close: () => Promise<void> }>(options: {
  readonly open: (id: string, signal: AbortSignal) => Promise<Runtime>
  readonly recover?: (runtime: Runtime) => Promise<void>
}) => {
  const instances = new Map<string, Runtime>()
  const opening = new Map<string, Promise<Runtime>>()
  const tasks = new Set<Promise<void>>()
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  const track = (task: Promise<void>): void => {
    tasks.add(task)
    void task.catch((error: unknown) => lifetime.abort(error)).finally(() => tasks.delete(task))
  }
  const open = (id: string): Promise<Runtime> => {
    lifetime.signal.throwIfAborted()
    const current = instances.get(id)
    if (current !== undefined) return Promise.resolve(current)
    const pending = opening.get(id)
    if (pending !== undefined) return pending
    const created = Promise.resolve().then(() => options.open(id, lifetime.signal)).then((runtime) => {
      instances.set(id, runtime)
      if (!lifetime.signal.aborted && options.recover !== undefined) track(Promise.resolve().then(() => options.recover!(runtime)))
      return runtime
    }).finally(() => opening.delete(id))
    opening.set(id, created)
    return created
  }
  const close = (): Promise<void> => closing ??= (async () => {
    lifetime.abort(new Error("host is closed"))
    await Promise.allSettled(opening.values())
    await Promise.allSettled(tasks)
    const results = await Promise.allSettled([...instances.values()].map((runtime) => runtime.close()))
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, "instance shutdown failed")
  })()
  return {
    instances: instances as ReadonlyMap<string, Runtime>, signal: lifetime.signal, open, track, close,
    restore: async (directory: string, idOf: (file: string) => string | undefined): Promise<void> => {
      try {
        const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
        for (const file of files) {
          const id = idOf(file)
          if (id !== undefined) await open(id)
        }
      } catch (error) { await close(); throw error }
    }
  }
}
