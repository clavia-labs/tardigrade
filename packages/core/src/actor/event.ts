import { Schema, SchemaAST } from "effect"

const EventCodec = Symbol("EventCodec")
type Tagged = { readonly type: string }
type Payload<Value> = Value extends Tagged ? Omit<Value, "type"> : never
export type DeclaredEvent<Value extends object = object> = Value & { readonly [EventCodec]: Schema.Schema<Value> }
export interface EventHandler<Value extends object, Args extends readonly unknown[]> {
  (...args: Args): DeclaredEvent<Value>
  readonly schema: Schema.Schema<Value>
}
export interface EventDeclaration<Value extends Tagged> extends Schema.Schema<Value> {
  make(input: Payload<Value>): DeclaredEvent<Value>
  from<Args extends readonly unknown[]>(map: (...args: Args) => Payload<Value>): EventHandler<Value, Args>
}
type Fields<Definition extends Tagged> = { readonly [Key in Exclude<keyof Definition, "type">]: Extract<Definition[Key], Schema.Top> } & { readonly type: Schema.Literal<Definition["type"]> }

const constructed = new WeakMap<object, Schema.Schema<object>>()

// event declares a codec and constructs validated events without registering process-wide names.
export function event<const Definition extends Tagged>(definition: Definition & { readonly [Key in Exclude<keyof Definition, "type">]: Schema.Top }): EventDeclaration<Schema.Struct.Type<Fields<Definition>> & { readonly type: Definition["type"] }>
export function event<const Name extends string, Value extends { readonly type: Name }>(name: Name, schema: Schema.Schema<Value>): EventDeclaration<Value>
export function event(definition: Tagged | string, supplied?: Schema.Schema<Tagged>): EventDeclaration<Tagged> {
  const name = typeof definition === "string" ? definition : definition.type
  if (!name) throw new Error("Event name must not be empty")
  const { type: _type, ...fields } = typeof definition === "string" ? { type: definition } : definition
  const schema: Schema.Schema<Tagged> = supplied ?? Schema.Struct({ ...fields, type: Schema.Literal(name) })
  const decode = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })
  const make = (input: Payload<Tagged>): DeclaredEvent<Tagged> => {
    if (Object.hasOwn(input, "type")) throw new Error("Event constructors supply the type discriminator")
    const value = decode({ ...input, type: name })
    if (value.type !== name) throw new Error("Event schema must match its declaration name")
    constructed.set(value, schema)
    return value as DeclaredEvent<Tagged>
  }
  const from = <Args extends readonly unknown[]>(map: (...args: Args) => Payload<Tagged>): EventHandler<Tagged, Args> =>
    Object.assign((...args: Args) => make(map(...args)), { schema })
  const declaration = Object.create(schema) as EventDeclaration<Tagged>
  Object.defineProperties(declaration, {
    make: { value: make, enumerable: true },
    from: { value: from, enumerable: true },
  })
  return declaration
}

// constructedEvent validates a method-produced event against the declaration carried by its constructor.
export function constructedEvent<Value extends object>(value: DeclaredEvent<Value>): Value {
  const schema = typeof value === "object" && value !== null ? constructed.get(value) : undefined
  if (!schema) throw new Error("Method handlers must return a declared event")
  return Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })(value) as Value
}

// eventCatalog owns the tagged codecs discovered for an actor setup.
export function eventCatalog<Value extends object>() {
  const codecs = new Map<string, Set<(input: unknown) => boolean>>()
  const registered = new WeakSet<SchemaAST.AST>()
  const tags = (node: SchemaAST.AST): readonly string[] => {
    if (SchemaAST.isUnion(node)) return node.types.flatMap(tags)
    if (!SchemaAST.isObjects(node)) return []
    const discriminator = node.propertySignatures.find(field => field.name === "type")?.type
    return discriminator && SchemaAST.isLiteral(discriminator) && typeof discriminator.literal === "string" ? [discriminator.literal] : []
  }
  return {
    add: (schema: Schema.Top) => {
      const ast = Schema.toType(schema).ast
      if (registered.has(ast)) return
      registered.add(ast)
      const decode = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })
      const accepts = (input: unknown) => { try { decode(input); return true } catch { return false } }
      for (const tag of tags(ast)) {
        let checks = codecs.get(tag)
        if (!checks) { checks = new Set(); codecs.set(tag, checks) }
        checks.add(accepts)
      }
    },
    schema: Schema.declare((input): input is Value => {
      if (typeof input !== "object" || input === null || !("type" in input) || typeof input.type !== "string") return false
      return [...(codecs.get(input.type) ?? [])].some(accepts => accepts(input))
    }, { identifier: "ActorEvent" }),
  }
}
