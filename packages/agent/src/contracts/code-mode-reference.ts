import { Schema } from "effect"
import { EffectRef, effectSourceName, RuntimeError } from "@clavia/tardigrade-core"

export const CodeModeName = Schema.NonEmptyString.check(Schema.isPattern(/^[^/]+$/))
const Owner = Schema.Struct({ codeMode: CodeModeName, callId: Schema.NonEmptyString })
const decodeOwner = Schema.decodeSync(Owner)
const PackageTag = Schema.Tuple([Owner.fields.callId, EffectRef.fields.seq])
const decodePackageTag = Schema.decodeUnknownSync(PackageTag)
const packageSuffix = (ordinal: number) => `.package.${ordinal}`

// codeModeCoordinate encodes evaluation and package identities without changing the runtime namespace (referenceCoordinates).
export function codeModeCoordinate(owner: typeof Owner.Type, ordinal?: number): { readonly source: string; readonly tag: string } {
  const { codeMode, callId } = decodeOwner(owner)
  if (ordinal === undefined) return { source: codeMode, tag: callId }
  const index = Schema.decodeSync(EffectRef.fields.seq)(ordinal)
  return { source: codeMode + packageSuffix(index), tag: JSON.stringify([callId, index]) }
}

// evaluationOwner identifies an accepted evaluation from its coordinate (referenceCoordinates).
export function evaluationOwner(ref: EffectRef): typeof Owner.Type {
  return decodeOwner({ codeMode: effectSourceName(ref), callId: ref.tag })
}

// packageOwner requires the encoded source ordinal and canonical tag to agree (referenceCoordinates).
export function packageOwner(ref: EffectRef): typeof Owner.Type & { readonly ordinal: number } {
  const [callId, ordinal] = decodePackageTag(JSON.parse(ref.tag))
  const source = effectSourceName(ref)
  const suffix = packageSuffix(ordinal)
  if (!source.endsWith(suffix) || JSON.stringify([callId, ordinal]) !== ref.tag) throw new RuntimeError("Package effect coordinate differs from its tag")
  return { ...decodeOwner({ codeMode: source.slice(0, -suffix.length), callId }), ordinal }
}
