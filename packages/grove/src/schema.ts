import { Schema, type SchemaAST } from "effect"
import type { Path } from "./storage/nodes"

export type At<T, P extends Path> = P extends readonly [infer K, ...infer R extends Path] ? T extends readonly (infer A)[] ? K extends number ? At<A, R> : never : K extends keyof T ? At<T[K], R> : never : T
export type Valid<T, P extends Path> = At<T, P> extends never ? never : P
export type ArrayPath<T, P extends Path> = At<T, P> extends readonly unknown[] ? Valid<T, P> : never
type Removable<T, K extends PropertyKey, P extends Path> = T extends readonly unknown[] ? never : T extends object ? K extends keyof T ? string extends keyof T ? P : {} extends Pick<T, K> ? P : never : never : never
export type RemovablePath<T, P extends Path> = P extends readonly [...infer Parent extends Path, infer Key extends PropertyKey] ? Removable<At<T, Parent>, Key, P> : never
export type Item<T> = T extends readonly (infer A)[] ? A : never

declare const AppendOnlyMark: unique symbol
declare const DeclarationMark: unique symbol
declare const TreeMark: unique symbol
declare const KeyValueMark: unique symbol
// AppendOnly constrains edits through existing entries while accepting ordinary array values (test/collections/append-only.test.ts; test/storage.test.ts).
export type AppendOnly<Value> = Value & { readonly [AppendOnlyMark]?: true }
export type Tree<Value> = Value extends null ? null : Value & { readonly [TreeMark]?: true }
export type KeyValue<Value> = Value & { readonly [KeyValueMark]?: true }
type Marked<Value> = [NonNullable<Value>] extends [never] ? false : typeof AppendOnlyMark extends keyof NonNullable<Value> ? true : false
type Keyed<Value> = [NonNullable<Value>] extends [never] ? false : typeof KeyValueMark extends keyof NonNullable<Value> ? true : false
type Collection<Value> = [NonNullable<Value>] extends [never] ? false : typeof TreeMark extends keyof NonNullable<Value> ? true : Marked<Value> extends true ? true : Keyed<Value>
interface Declaration<Kind extends string, Value, Encoded, RD, RE> extends Schema.Codec<Value, Encoded, RD, RE> {
  readonly [DeclarationMark]: Kind
  readonly Rebuild: Declaration<Kind, Value, Encoded, RD, RE>
}
type Declared<S> = S extends { readonly [DeclarationMark]: infer Kind } ? Kind extends "value" ? false : true : false
type DeclaredFields<S> = S extends { readonly fields: infer Fields extends Record<string, Schema.Top> } ? { [Key in keyof Fields]: Declared<Fields[Key]> }[keyof Fields] : false
type StateCollections<Value> = Collection<Value> extends true ? true : [Value] extends [readonly unknown[]] ? false : string extends keyof Value ? false : [Value] extends [object] ? true extends { [Key in keyof Value]-?: Collection<Value[Key]> }[keyof Value] ? true : false : false
export type ValueSchema<S extends Schema.Top> = S extends { readonly [DeclarationMark]: "value" } ? true : false
export type CollectionSchema<S extends Schema.Top> = ValueSchema<S> extends true ? false : true extends Declared<S> | DeclaredFields<S> | StateCollections<S["Type"]> ? true : false

type Editable<Value, P extends Path, Operation extends "set" | "append" | "splice"> = P extends readonly [infer Key extends string | number, ...infer Rest extends Path] ? Marked<Value> extends true ? false : Keyed<Value> extends true ? Operation extends "set" ? Rest extends readonly [] ? true : false : false : Editable<At<Value, [Key]>, Rest, Operation> : Operation extends "splice" ? Marked<Value> extends true ? false : true : true
export type EditPath<Value, P extends Path> = Editable<Value, P, "set"> extends true ? Valid<Value, P> : never
export type AppendPath<Value, P extends Path> = Editable<Value, P, "append"> extends true ? ArrayPath<Value, P> : never
export type SplicePath<Value, P extends Path> = Editable<Value, P, "splice"> extends true ? ArrayPath<Value, P> : never
const COLLECTION_ANNOTATION = "grove/collection"

// value declares a whole JSON value with replacement semantics (test/collections/value.test.ts).
export function value<S extends Schema.Top>(schema: S): Declaration<"value", S["Type"], S["Encoded"], S["DecodingServices"], S["EncodingServices"]> {
  jsonSchema(schema.ast)
  return Schema.make(schema.annotate({ [COLLECTION_ANNOTATION]: "value" }).ast)
}
export const isValue = (ast: SchemaAST.AST): boolean => collectionKind(ast) === "value"

// tree permits localized JSON edits within a declared collection (test/collections/mixed.test.ts; test/storage.test.ts).
export function tree<S extends Schema.Top>(schema: S): Declaration<"tree", Tree<S["Type"]>, S["Encoded"], S["DecodingServices"], S["EncodingServices"]> {
  treeSchema(schema.ast)
  return Schema.make(schema.annotate({ [COLLECTION_ANNOTATION]: "tree" }).ast)
}

// keyValue declares a string-keyed collection with whole-entry replacement and deletion (test/collections/mixed.test.ts; test/storage.test.ts).
export function keyValue<S extends Schema.Top>(value: S): Declaration<"keyValue", KeyValue<Readonly<Record<string, S["Type"]>>>, Readonly<Record<string, S["Encoded"]>>, S["DecodingServices"], S["EncodingServices"]> {
  jsonSchema(value.ast)
  return Schema.make(Schema.Record(Schema.String, value).annotate({ [COLLECTION_ANNOTATION]: "keyValue" }).ast)
}
const checkKind = (check: SchemaAST.Check<unknown>): unknown => check.annotations?.[COLLECTION_ANNOTATION] ?? (check._tag === "FilterGroup" ? check.checks.map(checkKind).find(value => value !== undefined) : undefined)
const collectionKind = (ast: SchemaAST.AST): unknown => ast.annotations?.[COLLECTION_ANNOTATION] ?? ast.checks?.map(checkKind).find(value => value !== undefined)
export const isKeyValue = (ast: SchemaAST.AST): boolean => collectionKind(ast) === "keyValue"
const collection = (ast: SchemaAST.AST): boolean => isAppendOnly(ast) || collectionKind(ast) === "tree" || isKeyValue(ast)

// collectionSchema recognizes declared roots or structs whose fields each declare a collection (test/collections/mixed.test.ts; test/storage.test.ts).
export function collectionSchema(ast: SchemaAST.AST): boolean {
  if (isValue(ast)) return false
  if (ast._tag === "Objects" && ast.propertySignatures.some(field => isValue(field.type))) throw new Error("Whole values require value(schema) at the state root")
  if (collection(ast)) { treeSchema(ast); return true }
  const declarations = (ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): boolean => {
    if (seen.has(ast)) return false
    seen.add(ast)
    if (collection(ast)) return true
    if (ast._tag === "Objects") return ast.propertySignatures.some(field => collection(field.type))
    if (ast._tag === "Suspend") return declarations(ast.thunk(), seen)
    return ast._tag === "Union" && ast.types.some(type => declarations(type, seen))
  }
  if ((ast._tag === "Union" || ast._tag === "Suspend") && declarations(ast)) throw new Error("Collection union and suspended roots require an explicit tree declaration")
  if (ast._tag !== "Objects" || !ast.propertySignatures.some(field => collection(field.type))) return false
  if (ast.indexSignatures.length || ast.propertySignatures.some(field => !collection(field.type))) throw new Error("Each durable state field must declare tree, appendOnly or keyValue")
  treeSchema(ast)
  return true
}

const APPEND_ONLY_ANNOTATION = "grove/appendOnly"

// appendOnly stores array entries independently and permits appends and whole replacements (test/collections/append-only.test.ts; test/storage.test.ts).
export function appendOnly<S extends Schema.Top & { readonly Type: readonly unknown[] }>(schema: S): Declaration<"appendOnly", AppendOnly<S["Type"]>, S["Encoded"], S["DecodingServices"], S["EncodingServices"]> {
  if (schema.ast._tag !== "Arrays" || schema.ast.elements.length || schema.ast.rest.length !== 1 || schema.ast.checks?.length) throw new Error("appendOnly requires a homogeneous array schema without container checks")
  return Schema.make(schema.annotate({ [APPEND_ONLY_ANNOTATION]: true }).ast)
}
export const isAppendOnly = (ast: SchemaAST.AST): boolean => ast._tag === "Arrays" && ast.annotations?.[APPEND_ONLY_ANNOTATION] === true

const markedSchemas = new WeakMap<SchemaAST.AST, boolean>()
export function hasCollectionStorage(ast: SchemaAST.AST): boolean {
  const cached = markedSchemas.get(ast)
  if (cached !== undefined) return cached
  const seen = new Set<SchemaAST.AST>()
  const visit = (ast: SchemaAST.AST): boolean => {
    if (seen.has(ast)) return false
    seen.add(ast)
    if (isAppendOnly(ast) || isKeyValue(ast)) return true
    switch (ast._tag) {
      case "Objects": return ast.propertySignatures.some(field => visit(field.type)) || ast.indexSignatures.some(field => visit(field.type))
      case "Arrays": return [...ast.elements, ...ast.rest].some(visit)
      case "Union": return ast.types.some(visit)
      case "Suspend": return visit(ast.thunk())
      default: return false
    }
  }
  const found = visit(ast)
  markedSchemas.set(ast, found)
  return found
}

// editableSchema enforces collection edit vocabularies before a mutation stages values (test/collections/mixed.test.ts; test/storage.test.ts; test/collections/append-only.test.ts).
export function editableSchema(ast: SchemaAST.AST, path: Path, operation: "set" | "append" | "splice" | "remove" = "set"): SchemaAST.AST {
  for (const [index, key] of path.entries()) {
    if (isAppendOnly(ast)) throw new Error("Append-only arrays reject indexed edits")
    if (isKeyValue(ast) && (index !== path.length - 1 || operation !== "set" && operation !== "remove")) throw new Error("Key-value collections require whole-entry set or remove")
    ast = childSchema(ast, key)
  }
  if (operation === "splice" && isAppendOnly(ast)) throw new Error("Append-only arrays reject splice")
  return ast
}

const fieldType = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast.context?.constructorDefault !== undefined) throw new Error("Tree schemas require plain JSON without defaults")
  return ast
}
const jsonSchema = (ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): void => {
  if (seen.has(ast)) return
  seen.add(ast)
  if (ast.encoding || ast.context?.constructorDefault !== undefined) throw new Error("Tree schemas must describe plain JSON")
  if (ast._tag === "Declaration" && Schema.Json.ast._tag === "Declaration" && ast.run === Schema.Json.ast.run) return
  switch (ast._tag) {
    case "Objects":
      for (const p of ast.propertySignatures) { if (typeof p.name === "symbol") throw new Error("Tree fields must have JSON keys"); jsonSchema(fieldType(p.type), seen) }
      for (const p of ast.indexSignatures) jsonSchema(fieldType(p.type), seen)
      return
    case "Arrays": for (const a of [...ast.elements, ...ast.rest]) jsonSchema(a, seen); return
    case "Union": for (const a of ast.types) jsonSchema(a, seen); return
    case "Suspend": jsonSchema(ast.thunk(), seen); return
    case "String": case "Number": case "Boolean": case "Null": case "Literal": return
    default: throw new Error(`Unsupported tree schema: ${ast._tag}`)
  }
}
// treeSchema excludes container checks because selective edits cannot validate constraints spanning siblings (test/transactions.test.ts; test/collections/tree.test.ts).
export const treeSchema = (ast: SchemaAST.AST): void => {
  if (ast.encoding || ast.context?.constructorDefault !== undefined) throw new Error("Tree schemas must describe plain JSON")
  switch (ast._tag) {
    case "Objects":
      if (ast.checks?.length) throw new Error("Tree objects require no container checks")
      if (ast.indexSignatures.length) {
        if (ast.propertySignatures.length || ast.indexSignatures.length !== 1 || ast.indexSignatures[0]!.parameter._tag !== "String") throw new Error("Tree records require a single string-key schema without fixed fields")
        jsonSchema(ast.indexSignatures[0]!.parameter)
        jsonSchema(ast.indexSignatures[0]!.type)
      }
      for (const p of ast.propertySignatures) {
        if (typeof p.name !== "string") throw new Error("Tree fields must have JSON keys")
        treeSchema(fieldType(p.type))
      }
      return
    case "Arrays":
      if (ast.checks?.length || ast.elements.length || ast.rest.length !== 1) throw new Error("Tree arrays require homogeneous elements without container checks")
      jsonSchema(ast.rest[0]!); return
    case "Union": case "Suspend": jsonSchema(ast); return
    case "String": case "Number": case "Boolean": case "Null": case "Literal": return
    default: throw new Error(`Unsupported tree schema: ${ast._tag}`)
  }
}
export const childSchema = (ast: SchemaAST.AST, key: string | number): SchemaAST.AST => {
  if (ast.checks?.length && (ast._tag === "Objects" || ast._tag === "Arrays")) throw new Error("Refined containers require whole-value edits")
  if (ast._tag === "Objects" && typeof key === "string") {
    if (ast.indexSignatures.length && (ast.propertySignatures.length || ast.indexSignatures.length !== 1 || ast.indexSignatures[0]!.parameter._tag !== "String")) throw new Error("Mixed records require whole-value edits")
    const p = ast.propertySignatures.find(p => p.name === key)
    if (p) return fieldType(p.type)
    const index = ast.indexSignatures[0]
    if (index && Schema.is(Schema.make<Schema.Schema<string>>(index.parameter))(key)) return index.type
  }
  if (ast._tag === "Arrays" && typeof key === "number" && Number.isSafeInteger(key) && key >= 0) return ast.rest[0]!
  throw new Error("Invalid schema path")
}


// removableSchema permits optional fields and string-record entries while preserving required fields (test/collections/tree.test.ts).
export const removableSchema = (ast: SchemaAST.AST, path: Path): void => {
  if (!path.length) throw new Error("Cannot remove a document root")
  const parent = path.slice(0, -1).reduce(childSchema, ast)
  const key = path.at(-1)!
  if (parent._tag === "Arrays") throw new Error("Use splice to remove array entries")
  childSchema(parent, key)
  if (parent._tag !== "Objects" || typeof key !== "string") throw new Error("Removal target must be an object field")
  const property = parent.propertySignatures.find(property => property.name === key)
  if (property && !property.type.context?.isOptional) throw new Error("Cannot remove a required field")
}
