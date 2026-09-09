// ProviderContinuation preserves one native assistant response for compatible replay (packages/model/src/continuation.test.ts).
export interface ProviderContinuation {
  readonly protocol: string
  readonly provider: string
  readonly model: string
  readonly endpoint: string
  readonly payload: ReadonlyArray<unknown>
}
