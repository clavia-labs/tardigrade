import { Schema } from "effect"
import { ModelRef, modelRefOf, type ModelRef as ModelRefType } from "./reference"

const PolicyName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

export const ModelSelector = Schema.Struct({
  provider: PolicyName,
  model_ids: Schema.Union([Schema.Literal("*"), Schema.Array(PolicyName).check(Schema.isNonEmpty())])
})

export interface ModelSelector {
  readonly provider: string
  readonly model_ids: "*" | ReadonlyArray<string>
}

export const ModelAllow = Schema.Union([Schema.Literal("*"), Schema.Array(ModelSelector)])
export type ModelAllow = "*" | ReadonlyArray<ModelSelector>

// ModelPolicy carries resolved coordinate authority. Future rule languages lower into this selector form before composition, so intersection remains the authority boundary.
export const ModelPolicy = Schema.Struct({
  default: Schema.optional(ModelRef),
  allow: ModelAllow
})

export interface ModelPolicy {
  readonly default?: ModelRefType
  readonly allow: ModelAllow
}

export const ModelPolicyOverride = Schema.Struct({
  default: Schema.optional(ModelRef),
  allow: Schema.optional(ModelAllow)
})

export interface ModelPolicyOverride {
  readonly default?: ModelRefType
  readonly allow?: ModelAllow
}

// DEFAULT_MODEL_POLICY leaves model authority unchanged and selects no default for an unconfigured host.
export const DEFAULT_MODEL_POLICY: ModelPolicy = { allow: "*" }

// DEFAULT_MODEL_POLICY_OVERRIDE inherits model authority and its default.
export const DEFAULT_MODEL_POLICY_OVERRIDE: ModelPolicyOverride = {}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const selectorOf = (value: unknown, index: number): ModelSelector => {
  const selector = recordOf(value)
  if (selector === undefined) throw new Error(`model selector ${index} must be an object`)
  const unknown = Object.keys(selector).filter((field) => field !== "provider" && field !== "model_ids")
  if (unknown.length > 0) throw new Error(`model selector ${index} contains unknown fields: ${unknown.join(", ")}`)
  const provider = textOf(selector["provider"])
  if (provider === undefined) throw new Error(`model selector ${index} must declare provider`)
  const rawModels = selector["model_ids"]
  if (rawModels === "*") return { provider, model_ids: "*" }
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new Error(`model selector ${index} model_ids must be "*" or a non-empty array`)
  }
  const modelIds = rawModels.map((value, modelIndex) => {
    const model = textOf(value)
    if (model === undefined) throw new Error(`model selector ${index} model_ids[${modelIndex}] must be a non-empty string`)
    return model
  })
  return { provider, model_ids: [...new Set(modelIds)].sort() }
}

type ProviderModels = "*" | Set<string>

// selectorMapOf lowers the current selector language into the set representation consumed by policy intersection. Query resolvers add syntax before this boundary and persist the normalized result.
const selectorMapOf = (selectors: ReadonlyArray<ModelSelector>): Map<string, ProviderModels> => {
  const providers = new Map<string, ProviderModels>()
  for (const selector of selectors) {
    const current = providers.get(selector.provider)
    if (current === "*" || selector.model_ids === "*") {
      providers.set(selector.provider, "*")
    } else {
      providers.set(selector.provider, new Set([...(current ?? []), ...selector.model_ids]))
    }
  }
  return providers
}

const selectorsOf = (providers: ReadonlyMap<string, ProviderModels>): ReadonlyArray<ModelSelector> =>
  [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, models]) => ({ provider, model_ids: models === "*" ? "*" : [...models].sort() }))

const allowOf = (rawAllow: unknown, required: boolean): ModelAllow | undefined => {
  if (rawAllow === "*") return "*"
  if (Array.isArray(rawAllow)) return selectorsOf(selectorMapOf(rawAllow.map(selectorOf)))
  if (!required && rawAllow === undefined) return undefined
  throw new Error(`model policy allow must be "*" or an array`)
}

// modelAllowedBy reports whether one reference belongs to a policy's selected set.
export const modelAllowedBy = (policy: ModelPolicy, reference: ModelRefType): boolean =>
  policy.allow === "*" || policy.allow.some((selector) =>
    selector.provider === reference.provider &&
    (selector.model_ids === "*" || selector.model_ids.includes(reference.model_id))
  )

// modelPolicyOf validates one policy and gives duplicate selectors a stable representation.
export const modelPolicyOf = (value: unknown): ModelPolicy => {
  if (value === undefined) return DEFAULT_MODEL_POLICY
  const policy = recordOf(value)
  if (policy === undefined) throw new Error("model policy must be an object")
  const unknown = Object.keys(policy).filter((field) => field !== "default" && field !== "allow")
  if (unknown.length > 0) throw new Error(`model policy contains unknown fields: ${unknown.join(", ")}`)
  if (!("allow" in policy)) throw new Error('model policy must declare allow as "*" or an array')
  const rawDefault = policy["default"]
  const selected = modelRefOf(rawDefault)
  if (rawDefault !== undefined && selected === undefined) throw new Error("model policy default must be { provider, model_id }")
  const allow = allowOf(policy["allow"], true)!
  const normalized: ModelPolicy = { ...(selected === undefined ? {} : { default: selected }), allow }
  if (selected !== undefined && !modelAllowedBy(normalized, selected)) {
    throw new Error(`model policy default ${selected.provider}/${selected.model_id} is excluded by allow`)
  }
  return normalized
}

// modelPolicyOverrideOf validates an optional downstream attenuation and default override.
export const modelPolicyOverrideOf = (value: unknown): ModelPolicyOverride => {
  if (value === undefined) return DEFAULT_MODEL_POLICY_OVERRIDE
  const policy = recordOf(value)
  if (policy === undefined) throw new Error("model policy override must be an object")
  const unknown = Object.keys(policy).filter((field) => field !== "default" && field !== "allow")
  if (unknown.length > 0) throw new Error(`model policy override contains unknown fields: ${unknown.join(", ")}`)
  const rawDefault = policy["default"]
  const selected = modelRefOf(rawDefault)
  if (rawDefault !== undefined && selected === undefined) throw new Error("model policy override default must be { provider, model_id }")
  const allow = allowOf(policy["allow"], false)
  const normalized: ModelPolicyOverride = {
    ...(selected === undefined ? {} : { default: selected }),
    ...(allow === undefined ? {} : { allow })
  }
  if (selected !== undefined && allow !== undefined && !modelAllowedBy({ allow }, selected)) {
    throw new Error(`model policy override default ${selected.provider}/${selected.model_id} is excluded by allow`)
  }
  return normalized
}

const intersectModels = (left: ProviderModels, right: ProviderModels): ProviderModels => {
  if (left === "*") return right === "*" ? "*" : new Set(right)
  if (right === "*") return new Set(left)
  return new Set([...left].filter((model) => right.has(model)))
}

// intersectModelPolicies returns the authority shared by every layer (packages/core/tla/runtime/ModelPolicy.tla, ChildCannotWiden; HostCeiling).
export const intersectModelPolicies = (policies: ReadonlyArray<ModelPolicy>): ModelPolicy => {
  const explicit = policies.filter((policy) => policy.allow !== "*")
  if (explicit.length === 0) return DEFAULT_MODEL_POLICY
  let intersection = selectorMapOf(explicit[0]!.allow as ReadonlyArray<ModelSelector>)
  for (const policy of explicit.slice(1)) {
    const right = selectorMapOf(policy.allow as ReadonlyArray<ModelSelector>)
    const next = new Map<string, ProviderModels>()
    for (const [provider, models] of intersection) {
      const other = right.get(provider)
      if (other === undefined) continue
      const shared = intersectModels(models, other)
      if (shared === "*" || shared.size > 0) next.set(provider, shared)
    }
    intersection = next
  }
  return { allow: selectorsOf(intersection) }
}

// applyModelPolicy attenuates incoming authority and inherits or overrides its default (packages/core/tla/runtime/ModelPolicy.tla, ChildCannotWiden; DefaultAllowed).
export const applyModelPolicy = (incoming: ModelPolicy, override: ModelPolicyOverride): ModelPolicy => {
  const authority = intersectModelPolicies([incoming, { allow: override.allow ?? "*" }])
  const selected = override.default ?? incoming.default
  if (selected !== undefined && !modelAllowedBy(authority, selected)) {
    throw new Error(`effective model policy excludes default ${selected.provider}/${selected.model_id}; supply an allowed default`)
  }
  return { ...authority, ...(selected === undefined ? {} : { default: selected }) }
}

// modelPolicyScopeOf returns a stable cursor scope for a policy intersection.
export const modelPolicyScopeOf = (policies: ReadonlyArray<ModelPolicy>): string =>
  JSON.stringify(intersectModelPolicies(policies).allow)
