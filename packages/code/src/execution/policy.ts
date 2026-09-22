import type { SpillPolicy } from "../storage/store"

// PackageCallPolicy bounds each live attempt and the retries performed before its failure is
// committed as an answer (code.test.ts, "a hanging call exhausts its deadline and backoff as
// one durable error").
export interface PackageCallPolicy {
  readonly attemptTimeoutMs: number
  readonly retryDelaysMs: ReadonlyArray<number>
}

export interface PackageCallFailure {
  readonly error: string
  readonly attempts: number
  readonly policy: PackageCallPolicy
}

export const DEFAULT_PACKAGE_CALL_POLICY: PackageCallPolicy = {
  attemptTimeoutMs: 30_000,
  retryDelaysMs: [250, 1_000, 4_000]
}

export const packageCallPolicyOf = (policy: Partial<PackageCallPolicy> = {}): PackageCallPolicy => {
  const attemptTimeoutMs = policy.attemptTimeoutMs ?? DEFAULT_PACKAGE_CALL_POLICY.attemptTimeoutMs
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) {
    throw new Error("package call attemptTimeoutMs must be a positive safe integer")
  }
  const retryDelaysMs = policy.retryDelaysMs ?? DEFAULT_PACKAGE_CALL_POLICY.retryDelaysMs
  for (const [index, delay] of retryDelaysMs.entries()) {
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error(`package call retryDelaysMs[${index}] must be a non-negative safe integer`)
    }
  }
  return { attemptTimeoutMs, retryDelaysMs: [...retryDelaysMs] }
}


export interface CodePolicy {
  readonly spill: Partial<SpillPolicy>
  readonly call: Partial<PackageCallPolicy>
}

export interface CallPolicy {
  readonly call: PackageCallPolicy
  readonly spill: { readonly spillBytes: number; readonly previewChars: number; readonly note: string }
  readonly shadow: boolean
}
