import { Exit, Schema, SchemaAST } from "effect"
import { frozenPlainData } from "./frozen"

const STRICT = { onExcessProperty: "error" } as const
type Check = (value: unknown) => boolean

// incrementalValidator reuses successful checks for frozen plain-data subtrees under pure type-side schemas (packages/platform/test/properties/runtime/state-validation.ts).
export function incrementalValidator(schema: Schema.Top, onFallback?: () => void): Check {
  const immutable = frozenPlainData
  const freeze = (value: unknown): boolean => {
    const pending: object[] = []
    const seen = new Set<object>()
    const visit = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") return typeof value !== "function"
      if (immutable.has(value) || seen.has(value)) return true
      const prototype: unknown = Object.getPrototypeOf(value)
      if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
      seen.add(value)
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!("value" in descriptor) || !visit(descriptor.value)) return false
      }
      pending.push(value)
      return true
    }
    if (!visit(value)) return false
    for (const object of pending) {
      Object.freeze(object)
      immutable.add(object)
    }
    return true
  }
  const compile = (ast: SchemaAST.AST): Check => {
    const decode = Schema.decodeUnknownExit(Schema.toType(Schema.make(ast)), STRICT)
    const native: Check = value => Exit.isSuccess(decode(value))
    let check = native
    // compile retains native decoding for filters that depend on decoded children.
    if (ast._tag === "Arrays" && !ast.checks?.length && !ast.encodingChecks?.length && ast.elements.length === 0 && ast.rest.length === 1) {
      const item = compile(ast.rest[0]!)
      check = value => {
        if (!Array.isArray(value)) return false
        for (let index = 0; index < value.length; index++) if (!item(value[index])) return false
        return true
      }
    } else if (ast._tag === "Objects" && !ast.checks?.length && !ast.encodingChecks?.length && ast.indexSignatures.length === 0 && ast.propertySignatures.every(property => typeof property.name === "string")) {
      const fields = ast.propertySignatures.map(property => ({ name: property.name, optional: property.type.context?.isOptional, check: compile(property.type) }))
      const names = new Set(fields.map(field => field.name))
      check = value => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false
        for (const key of Reflect.ownKeys(value)) if (!names.has(key)) return false
        const record = value as Record<PropertyKey, unknown>
        for (const field of fields) {
          if (!(field.name === "__proto__" ? Object.hasOwn(record, field.name) : field.name in record)) {
            if (field.optional) continue
            return false
          }
          if (!field.check(record[field.name])) return false
        }
        return true
      }
    }
    const passed = new WeakSet<object>()
    return value => {
      if (typeof value !== "object" || value === null || !immutable.has(value)) return native(value)
      if (passed.has(value)) return true
      const valid = check(value)
      if (valid) passed.add(value)
      return valid
    }
  }
  const ast = SchemaAST.toType(schema.ast)
  const fast = compile(ast)
  const decode = Schema.decodeUnknownExit(Schema.toType(Schema.make(ast)), STRICT)
  let reported = false
  return value => {
    if (freeze(value)) return fast(value)
    const valid = Exit.isSuccess(decode(value))
    if (valid && !reported) {
      reported = true
      onFallback?.()
    }
    return valid
  }
}
