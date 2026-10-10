import { Schema, SchemaAST } from "effect"

type Tagged = { readonly type: string }
type Next<N extends number, Acc extends readonly unknown[] = []> = Acc["length"] extends N ? [...Acc, unknown]["length"] : Next<N, [...Acc, unknown]>
type InitialVersion<Value> = Value extends { readonly version: 1 } ? 1 : 0
type EventReader = (input: unknown) => Tagged
declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations { readonly "tardigrade/event/upcast"?: EventReader }
  }
}
const decode = <Value>(schema: Schema.Schema<Value>) => Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })

export interface VersionedEvent<Value extends Tagged, Version extends number> {
  readonly schema: Schema.Codec<Value>
  readonly decode: (input: unknown) => Value
  to<const Target extends Tagged & { readonly type: Value["type"]; readonly version: Next<Version> }>(schema: Schema.Schema<Target>, upcast: (value: Value) => Target): VersionedEvent<Target, Next<Version>>
}

// versionedEvent starts an ordered migration chain at an unversioned or v1 schema; upcasters must be deterministic and free of external reads.
export function versionedEvent<Value extends Tagged & ({ readonly version?: never } | { readonly version: 1 })>(schema: Schema.Schema<Value>): VersionedEvent<Value, InitialVersion<Value>> {
  const ast = Schema.toType(schema).ast
  const revision = SchemaAST.isObjects(ast) ? ast.propertySignatures.find(field => field.name === "version") : undefined
  if (revision && (!SchemaAST.isLiteral(revision.type) || revision.type.literal !== 1 || SchemaAST.isOptional(revision.type))) throw new Error("Initial event version must be literal 1 or absent")
  const initial = (revision ? 1 : 0) as InitialVersion<Value>
  const build = <Current extends Tagged, Version extends number>(current: Schema.Schema<Current>, version: Version, read: (input: unknown) => Current): VersionedEvent<Current, Version> => {
    return {
      schema: Schema.toType(current).annotate({ "tardigrade/event/upcast": read }),
      decode: read,
      to: (target, upcast) => {
        const validate = decode(target)
        const next = version + 1 as Next<Version>
        const migrate = (input: unknown) => {
          if (typeof input === "object" && input !== null && "version" in input && input.version === next) return validate(input)
          const previous = read(input)
          try {
            const result = validate(upcast(previous))
            if (result.version !== next) throw new Error(`Expected event version ${next}`)
            return result
          } catch (cause) {
            throw new Error(`Event ${previous.type}: migration ${version} -> ${next} failed`, { cause })
          }
        }
        return build(target, next, migrate)
      },
    }
  }
  return build(schema, initial, decode(schema))
}

// historicalEventMigrations collects declared readers and rejects conflicting chains for an event type.
export function historicalEventMigrations(schema: Schema.Top): ReadonlyMap<string, EventReader> {
  const migrations = new Map<string, EventReader>()
  const tags = (ast: SchemaAST.AST): readonly string[] => {
    if (SchemaAST.isUnion(ast)) return ast.types.flatMap(tags)
    if (!SchemaAST.isObjects(ast)) return []
    const tag = ast.propertySignatures.find(field => field.name === "type")?.type
    return tag && SchemaAST.isLiteral(tag) && typeof tag.literal === "string" ? [tag.literal] : []
  }
  const visit = (ast: SchemaAST.AST) => {
    const read = ast.annotations?.["tardigrade/event/upcast"]
    if (read) {
      const names = tags(ast)
      if (!names.length) throw new Error("Versioned events require a literal type discriminator")
      for (const name of names) {
        const previous = migrations.get(name)
        if (previous && previous !== read) throw new Error(`Conflicting event migrations: ${name}`)
        migrations.set(name, read)
      }
      return
    }
    if (SchemaAST.isUnion(ast)) for (const member of ast.types) visit(member)
  }
  visit(schema.ast)
  return migrations
}

// historicalEventDecoder validates historical JSON after advancing declared migration chains.
export function historicalEventDecoder<Value>(schema: Schema.Schema<Value>): (input: unknown) => Value {
  const migrations = historicalEventMigrations(schema)
  const validate = decode(schema)
  return input => {
    const read = typeof input === "object" && input !== null && "type" in input && typeof input.type === "string" ? migrations.get(input.type) : undefined
    try { return validate(read ? read(input) : input) } catch (cause) {
      const type = typeof input === "object" && input !== null && "type" in input ? String(input.type) : "unknown"
      const version = typeof input === "object" && input !== null && "version" in input ? String(input.version) : "unversioned"
      throw new Error(`Invalid historical event ${type} (incoming version ${version})`, { cause })
    }
  }
}
