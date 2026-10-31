import { Schema } from "effect"
import { CheckpointPosition } from "./position"

const Fields = {
  name: Schema.String,
  family: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.optionalKey(Schema.NonEmptyString),
  position: CheckpointPosition,
}
type Reference = Schema.Struct.Type<typeof Fields>
type Identity = Pick<Reference, "name" | "family" | "version">

export const CompleteCheckpointIdentity = Schema.makeFilter((value: Identity) => (value.family === undefined) === (value.version === undefined) && (value.family !== undefined || value.name.trim().length > 0), { title: "Atom checkpoint identity is complete" })
export const AtomCheckpointReference = Schema.Struct(Fields).check(CompleteCheckpointIdentity)
export const atomCheckpointKey = (identity: Identity): string => JSON.stringify([identity.family ?? null, identity.version ?? null, identity.name])

// validateCheckpointReferences enforces identity uniqueness and version-specific recovery boundaries (platform/test/properties/checkpoint/schema.ts).
export function validateCheckpointReferences(position: number, entries: readonly Reference[], checkpointVersion: 4 | 5): void {
  if (checkpointVersion === 4) {
    if (entries.some(entry => entry.family !== undefined)) throw new Error("Legacy checkpoint cannot contain family members")
    if (entries.some(entry => entry.position !== position)) throw new Error("Durable entry position differs from checkpoint position")
  } else if (entries.some(entry => entry.position > position)) throw new Error("Atom checkpoint exceeds actor position")
  const identities = entries.map(atomCheckpointKey)
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate durable atom checkpoint name")
}
