import { Exit, Schema, SchemaAST } from "effect"
import { frozenPlainData } from "./frozen"

const STRICT = { onExcessProperty: "error" } as const
type Check = (value: unknown) => boolean
type Node = { readonly check: Check; readonly trust: (value: unknown) => void }

// incrementalValidator reuses successful checks for frozen plain-data subtrees under pure type-side schemas (packages/platform/test/properties/runtime/state-validation.ts).
// The returned trust(value) records an already decoded value as passing without checking it again; values that are not plain data are left unrecorded.
export function incrementalValidator(schema: Schema.Top, onFallback?: () => void): Check & { readonly trust: (value: unknown) => void } {
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
  const compile = (ast: SchemaAST.AST): Node => {
    const decode = Schema.decodeUnknownExit(Schema.toType(Schema.make(ast)), STRICT)
    const native: Check = value => Exit.isSuccess(decode(value))
    let check = native
    let children: ((value: unknown) => void) | undefined
    // compile retains native decoding for filters that depend on decoded children.
    if (ast._tag === "Arrays" && !ast.checks?.length && !ast.encodingChecks?.length && ast.elements.length === 0 && ast.rest.length === 1) {
      const item = compile(ast.rest[0]!)
      check = value => {
        if (!Array.isArray(value)) return false
        for (let index = 0; index < value.length; index++) if (!item.check(value[index])) return false
        return true
      }
      children = value => { if (Array.isArray(value)) for (const element of value) item.trust(element) }
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
          if (!field.check.check(record[field.name])) return false
        }
        return true
      }
      children = value => { if (typeof value === "object" && value !== null) for (const field of fields) if (Object.hasOwn(value, field.name)) field.check.trust((value as Record<PropertyKey, unknown>)[field.name]) }
    }
    const passed = new WeakSet<object>()
    return {
      check: value => {
        if (typeof value !== "object" || value === null || !immutable.has(value)) return native(value)
        if (passed.has(value)) return true
        const valid = check(value)
        if (valid) passed.add(value)
        return valid
      },
      trust: value => {
        if (typeof value !== "object" || value === null || !immutable.has(value) || passed.has(value)) return
        passed.add(value)
        children?.(value)
      },
    }
  }
  const ast = SchemaAST.toType(schema.ast)
  const fast = compile(ast)
  const decode = Schema.decodeUnknownExit(Schema.toType(Schema.make(ast)), STRICT)
  let reported = false
  const validate = (value: unknown) => {
    if (freeze(value)) return fast.check(value)
    const valid = Exit.isSuccess(decode(value))
    if (valid && !reported) {
      reported = true
      onFallback?.()
    }
    return valid
  }
  return Object.assign(validate, { trust: (value: unknown) => { if (freeze(value)) fast.trust(value) } })
}
