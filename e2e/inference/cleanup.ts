export const cleanup = async (tasks: ReadonlyArray<() => unknown>) => {
  const failures: unknown[] = []
  for (const task of tasks) {
    try { await task() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Inference test cleanup failed")
}

export const registerCleanup = <A>(tasks: Array<() => unknown>, value: A, dispose: (value: A) => unknown) => {
  let active = true
  tasks.unshift(async () => { if (active) await dispose(value) })
  return async () => {
    if (!active) return
    active = false
    await dispose(value)
  }
}
