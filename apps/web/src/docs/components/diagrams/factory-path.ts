export type FactoryAction = "inspect" | "produce" | "treat"
export interface FactoryPolicy {
  readonly capacity: number
  readonly wastePerBatch: number
  readonly clipsPerBatch: number
}
export const DEFAULT_FACTORY_POLICY: FactoryPolicy = { capacity: 10, wastePerBatch: 6, clipsPerBatch: 500 }
export const DEFAULT_FACTORY_PATH_STEPS = 8
export const DEFAULT_FACTORY_EXPLORER_LIMITS = { maxSteps: 12, maxPaths: 100 } as const
export const DEFAULT_FACTORY_EXPLORER_PATHS = 10
export const DEFAULT_VERIFICATION_PREVIEW_RUNS = 6

// factoryPath models completed toy-factory actions with persistent pollution and safety violations.
export const factoryPath = (actions: ReadonlyArray<FactoryAction>, policy: FactoryPolicy, { enforceRules = false }: { readonly enforceRules?: boolean } = {}) => {
  let inspected = false
  let water = 0
  let pollution = 0
  let clips = 0
  let violation: string | undefined
  return actions.map((action) => {
    const rejection = enforceRules && action === "produce"
      ? !inspected ? "Inspect before production" : water + policy.wastePerBatch > policy.capacity ? "Treat waste before another batch" : undefined
      : undefined
    if (action === "inspect") inspected = true
    if (action === "produce" && rejection === undefined) {
      if (!inspected) violation ??= "Production before inspection"
      clips += policy.clipsPerBatch
      const generated = water + policy.wastePerBatch
      pollution += Math.max(0, generated - policy.capacity)
      water = Math.min(policy.capacity, generated)
      if (pollution > 0) violation ??= "Wastewater escaped into the surroundings"
    }
    if (action === "treat") water = 0
    return { action, water, pollution, clips, violation, rejection }
  })
}
