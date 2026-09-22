import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  applyModelPolicy,
  DEFAULT_MODEL_POLICY,
  intersectModelPolicies,
  modelAllowedBy,
  modelPolicyOf,
  type ModelPolicy
} from "./access"
import type { ModelRef } from "./reference"

const coordinates: ReadonlyArray<ModelRef> = [
  { provider: "openai", model_id: "large" },
  { provider: "openai", model_id: "small" },
  { provider: "anthropic", model_id: "sonnet" }
]

const coordinateKey = (model: ModelRef): string => `${model.provider}/${model.model_id}`

const policyOf = (models: ReadonlyArray<ModelRef>, selected?: ModelRef): ModelPolicy => modelPolicyOf({
  ...(selected === undefined ? {} : { default: selected }),
  allow: models.map((model) => ({ provider: model.provider, model_ids: [model.model_id] }))
})

const selected = (policy: ModelPolicy): ReadonlyArray<string> =>
  coordinates.filter((model) => modelAllowedBy(policy, model)).map(coordinateKey).sort()

const policyArbitrary = fc.subarray([...coordinates]).map((models) => policyOf(models))

const pointedPolicyArbitrary = fc.subarray([...coordinates], { minLength: 1 }).chain((models) =>
  fc.constantFrom(...models).map((model) => policyOf(models, model))
)

const pointedOverrideArbitrary = pointedPolicyArbitrary.chain((incoming) =>
  fc.constantFrom(...coordinates.filter((model) => modelAllowedBy(incoming, model)))
    .map((nextDefault) => ({ incoming, nextDefault }))
)

describe("model policy set laws", () => {
  test("wildcard is identity and an empty allowlist is empty", () => {
    expect(selected(intersectModelPolicies([DEFAULT_MODEL_POLICY]))).toEqual(selected(DEFAULT_MODEL_POLICY))
    expect(selected(intersectModelPolicies([{ allow: [] }]))).toEqual([])
  })

  test("selectors form a normalized union inside one policy", () => {
    expect(modelPolicyOf({
      allow: [
        { provider: "openai", model_ids: ["small"] },
        { provider: "anthropic", model_ids: "*" },
        { provider: "openai", model_ids: ["large"] }
      ]
    })).toEqual({
      allow: [
        { provider: "anthropic", model_ids: "*" },
        { provider: "openai", model_ids: ["large", "small"] }
      ]
    })
  })

  test("intersection is commutative and idempotent", () => {
    fc.assert(fc.property(policyArbitrary, policyArbitrary, (left, right) => {
      expect(selected(intersectModelPolicies([left, left]))).toEqual(selected(left))
      expect(selected(intersectModelPolicies([left, right]))).toEqual(selected(intersectModelPolicies([right, left])))
    }))
  })

  test("intersection is associative and contractive", () => {
    fc.assert(fc.property(policyArbitrary, policyArbitrary, policyArbitrary, (left, middle, right) => {
      const first = intersectModelPolicies([left, middle])
      expect(selected(first).every((model) => selected(left).includes(model))).toBe(true)
      expect(selected(intersectModelPolicies([first, right]))).toEqual(
        selected(intersectModelPolicies([left, intersectModelPolicies([middle, right])]))
      )
    }))
  })

  test("an inherited default remains the point of every valid attenuation", () => {
    fc.assert(fc.property(pointedPolicyArbitrary, fc.subarray([...coordinates]), (incoming, extra) => {
      const retained = coordinates.filter((model) =>
        modelAllowedBy(incoming, model) && (coordinateKey(model) === coordinateKey(incoming.default!) || extra.some((value) => coordinateKey(value) === coordinateKey(model)))
      )
      const effective = applyModelPolicy(incoming, { allow: policyOf(retained).allow })
      expect(effective.default).toEqual(incoming.default)
      expect(modelAllowedBy(effective, effective.default!)).toBe(true)
      expect(selected(effective).every((model) => selected(incoming).includes(model))).toBe(true)
    }))
  })

  test("a declared default remains inside the attenuated coordinate set", () => {
    fc.assert(fc.property(pointedOverrideArbitrary, ({ incoming, nextDefault }) => {
      const effective = applyModelPolicy(incoming, { default: nextDefault })
      expect(effective.default).toEqual(nextDefault)
      expect(modelAllowedBy(effective, effective.default!)).toBe(true)
    }))
  })
})
