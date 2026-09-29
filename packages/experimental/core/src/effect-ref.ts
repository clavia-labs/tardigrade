import { Schema } from "effect"

export const EffectRef = Schema.Struct({
  seq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  atom: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
})
export type EffectRef = typeof EffectRef.Type

export const effectKey = (ref: EffectRef) => JSON.stringify([ref.seq, ref.atom, ref.tag])
