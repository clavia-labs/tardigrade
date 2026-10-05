import { Exit, Schema, SchemaAST } from "effect"
import { frozenPlainData } from "./frozen"

const STRICT = { onExcessProperty: "error" } as const
type Check = (value: unknown) => boolean
type Node = { readonly check: Check; readonly trust: (value: unknown) => void }

// invalid is the result of parse for a value that fails validation.
export const invalid: unique symbol = Symbol("invalid")

// incrementalValidator reuses successful checks for frozen plain-data subtrees under pure type-side schemas (packages/platform/test/properties/runtime/state-validation.ts).
// parse(value) returns the deep-frozen plain value that passed, or invalid; an unfrozen array is read by index into a new array, as Effect's decode reads it, so the result can differ from value by identity and callers keep the result.
// trust(value) records an already decoded value as passing without checking it again and returns the value to keep; values that are not plain data are returned unrecorded.
export function incrementalValidator(schema: Schema.Top, onFallback?: () => void): Check & { readonly parse: (value: unknown) => unknown; readonly trust: (value: unknown) => unknown } {
  const immutable = frozenPlainData
  const own = (root: unknown): unknown => {
    const pending: object[] = []
    const owned = new Map<object, unknown>()
    const visit = (value: unknown): unknown => {
      if (value === null || typeof value !== "object") return typeof value === "function" ? invalid : value
      if (immutable.has(value)) return value
      const known = owned.get(value)
      if (known !== undefined) return known
      const prototype: unknown = Object.getPrototypeOf(value)
      if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid
      if (Array.isArray(value) && !Object.isFrozen(value)) {
        const copy: unknown[] = []
        owned.set(value, copy)
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index]
          if (item === undefined && !Object.hasOwn(value, index)) return invalid
          const next = visit(item)
          if (next === invalid) return invalid
          copy.push(next)
        }
        pending.push(copy)
        return copy
      }
      owned.set(value, value)
      const keys = Reflect.ownKeys(value)
      const values: unknown[] = []
      let replaced = false
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!("value" in descriptor)) return invalid
        const next = visit(descriptor.value)
        if (next === invalid) return invalid
        replaced ||= next !== descriptor.value
        values.push(next)
      }
      let result: object = value
      if (replaced) {
        result = Array.isArray(value) ? [] : prototype === null ? Object.create(null) as object : {}
        keys.forEach((key, index) => Object.defineProperty(result, key, { value: values[index], enumerable: Object.getOwnPropertyDescriptor(value, key)!.enumerable!, writable: true, configurable: true }))
        owned.set(value, result)
      }
      pending.push(result)
      return result
    }
    const result = visit(root)
    if (result === invalid) return invalid
    for (const object of pending) {
      Object.freeze(object)
      immutable.add(object)
    }
    return result
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
  const parse = (value: unknown): unknown => {
    const owned = own(value)
    if (owned !== invalid) return fast.check(owned) ? owned : invalid
    if (!Exit.isSuccess(decode(value))) return invalid
    if (!reported) {
      reported = true
      onFallback?.()
    }
    return value
  }
  const trust = (value: unknown): unknown => {
    const owned = own(value)
    if (owned === invalid) return value
    fast.trust(owned)
    return owned
  }
  return Object.assign((value: unknown) => parse(value) !== invalid, { parse, trust })
}
