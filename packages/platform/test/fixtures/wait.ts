export const DEFAULT_WAIT_POLICY = { timeoutMs: 5_000, pollIntervalMs: 5 }

// testStage bounds a test step including unresolved RPC calls; its deadline does not cancel remote work.
export async function testStage<Value>(name: string, run: () => Promise<Value>, timeoutMs = DEFAULT_WAIT_POLICY.timeoutMs): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out ${name} after ${timeoutMs}ms`)), timeoutMs)
    })])
  } catch (cause) {
    throw new Error(`Test stage failed: ${name}`, { cause })
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

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
