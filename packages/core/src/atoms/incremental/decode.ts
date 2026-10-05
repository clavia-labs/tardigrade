import { Exit, Schema, SchemaAST } from "effect"
import { frozenPlainData } from "./frozen"

const STRICT = { onExcessProperty: "error" } as const
const isJson = Schema.is(Schema.Json)

type Decode = (value: unknown) => { readonly value: unknown } | undefined
type DecodeOptions = { readonly freeze?: boolean }

// reusableJson holds frozen plain data that is JSON (Schema.Json) with Object.prototype objects, so reusing it equals a structuredClone of it; frozen plain data cannot change after the check.
const reusableJson = new WeakSet<object>()
const isReusableJson = (value: object): boolean => {
  if (reusableJson.has(value)) return true
  if (!isJson(value)) return false
  const visit = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null || reusableJson.has(node)) return true
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype) return false
    for (const child of Object.values(node)) if (!visit(child)) return false
    reusableJson.add(node)
    return true
  }
  return visit(value)
}

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// incrementalDecoder decodes a value against a type-side schema and returns a result deep-equal to structuredClone of Schema.decodeSync, reusing frozen plain-data subtrees instead of decoding and copying them again. It returns undefined where it cannot show that equivalence; the caller then decodes and clones.
// With freeze, a container it builds whose children are all primitives or frozen plain data is frozen, recorded in frozenPlainData so later proofs of the result stop at it (runtime/replay.ts freeze), and recorded as passed at its node, since it holds exactly that node's fields, each decoded; a later call without freeze then reuses it.
export function incrementalDecoder(schema: Schema.Top): (value: unknown, options?: DecodeOptions) => ReturnType<Decode> {
  let freeze = false
  const built = (value: object, plain: boolean, passed: WeakSet<object>) => {
    if (freeze && plain) {
      Object.freeze(value)
      frozenPlainData.add(value)
      passed.add(value)
    }
    return { value }
  }
  const isFrozenPlain = (value: unknown) => typeof value !== "object" || value === null || frozenPlainData.has(value)
  const compile = (ast: SchemaAST.AST): Decode => {
    const decodeStrict = Schema.decodeUnknownExit(Schema.toType(Schema.make(ast)), STRICT)
    const strict = (value: unknown) => Exit.isSuccess(decodeStrict(value))
    // passed holds frozen values that decoded strictly here, so they carry no keys the default decode would drop.
    const passed = new WeakSet<object>()
    let container: Decode | undefined
    if (ast._tag === "Arrays" && !ast.checks?.length && !ast.encodingChecks?.length && ast.elements.length === 0 && ast.rest.length === 1) {
      const item = compile(ast.rest[0]!)
      container = value => {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
        const out: unknown[] = []
        let plain = true
        for (let index = 0; index < value.length; index++) {
          const decoded = item(value[index])
          if (!decoded) return undefined
          out.push(decoded.value)
          plain &&= isFrozenPlain(decoded.value)
        }
        return built(out, plain, passed)
      }
    } else if (ast._tag === "Objects" && !ast.checks?.length && !ast.encodingChecks?.length && ast.indexSignatures.length === 0 && ast.propertySignatures.every(property => typeof property.name === "string")) {
      const fields = ast.propertySignatures.map(property => ({ name: property.name as string, optional: property.type.context?.isOptional === true, decode: compile(property.type) }))
      container = value => {
        if (typeof value !== "object" || value === null || Array.isArray(value) || !isPlainObject(value)) return undefined
        const record = value as Readonly<Record<string, unknown>>
        const out: Record<string, unknown> = {}
        let plain = true
        for (const field of fields) {
          if (!Object.hasOwn(record, field.name)) {
            if (field.optional) continue
            return undefined
          }
          const decoded = field.decode(record[field.name])
          if (!decoded) return undefined
          out[field.name] = decoded.value
          plain &&= isFrozenPlain(decoded.value)
        }
        return built(out, plain, passed)
      }
    }
    return value => {
      if (typeof value !== "object" || value === null) return isJson(value) && strict(value) ? { value } : undefined
      if (frozenPlainData.has(value)) {
        if (passed.has(value)) return { value }
        if (!isReusableJson(value) || !strict(value)) return undefined
        passed.add(value)
        return { value }
      }
      if (container) return container(value)
      return strict(value) && isJson(value) ? { value: structuredClone(value) } : undefined
    }
  }
  const decode = compile(SchemaAST.toType(schema.ast))
  return (value, options) => {
    freeze = options?.freeze === true
    try {
      return decode(value)
    } finally {
      freeze = false
    }
  }
}
