export const DEFAULT_WAIT_POLICY = { timeoutMs: 5_000, pollIntervalMs: 5 }

export async function waitFor<Value>(read: () => Promise<Value>, accepts: (value: Value) => boolean, options: Partial<typeof DEFAULT_WAIT_POLICY> = {}): Promise<Value> {
  const policy = { ...DEFAULT_WAIT_POLICY, ...options }
  const deadline = Date.now() + policy.timeoutMs
  while (true) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test behavior")
    await new Promise(resolve => setTimeout(resolve, policy.pollIntervalMs))
  }
}
