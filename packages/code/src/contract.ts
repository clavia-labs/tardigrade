// Package contract reads a method's declared input schema (packages.ts, MethodDoc) for two
// callers: `packages.describe` renders a signature line, and the dispatch funnel (execute.ts)
// checks the args before the method runs, so a wrong call settles with a teaching error. Both
// are pure functions of the schema, so replay reproduces every refusal (contract.test.ts).

// SchemaNode is the schema subset the contract reads: type, properties, required, enum, items.
// The subset keeps standard JSON Schema semantics. A keyword outside the subset is ignored, so
// a richer schema stays a valid declaration.
interface SchemaNode {
  readonly type?: string
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: ReadonlyArray<string>
  readonly enum?: ReadonlyArray<unknown>
  readonly items?: SchemaNode
}

const asNode = (schema: unknown): SchemaNode | undefined =>
  typeof schema === "object" && schema !== null ? (schema as SchemaNode) : undefined

// typeName renders one schema node as a type expression. Depth caps the nesting: an object
// below the cap renders as `object`, so a deep schema still fits one line.
const typeName = (node: SchemaNode, depth: number): string => {
  if (node.enum !== undefined && node.enum.length > 0) return node.enum.map((v) => JSON.stringify(v)).join(" | ")
  switch (node.type) {
    case "string":
    case "boolean":
    case "null":
      return node.type
    case "number":
    case "integer":
      return "number"
    case "array":
      return node.items === undefined ? "array" : `${typeName(node.items, depth)}[]`
    case "object": {
      if (node.properties === undefined || depth <= 0) return "object"
      return objectBody(node, depth)
    }
    default:
      return "unknown"
  }
}

const objectBody = (node: SchemaNode, depth: number): string => {
  const required = new Set(node.required ?? [])
  const fields = Object.entries(node.properties ?? {}).map(
    ([name, child]) => `${name}${required.has(name) ? "" : "?"}: ${typeName(child, depth - 1)}`
  )
  return `{${fields.join(", ")}}`
}

// renderSignature folds a method's declared input schema into one calling line:
// `put({name: string, body: string, title?: string})`. A method with no usable object schema
// renders bare: `list()`.
export const renderSignature = (method: string, input: unknown): string => {
  const node = asNode(input)
  if (node === undefined || node.type !== "object" || node.properties === undefined) return `${method}()`
  const body = objectBody(node, 2)
  return body === "{}" ? `${method}()` : `${method}(${body})`
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value

const matchesType = (value: unknown, declared: string): boolean => {
  const actual = typeOf(value)
  if (declared === "integer") return actual === "number" && Number.isInteger(value as number)
  if (declared === "number") return actual === "number"
  return actual === declared
}

const check = (value: unknown, node: SchemaNode, path: string, issues: Array<string>): void => {
  if (node.enum !== undefined && node.enum.length > 0) {
    if (!node.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
      issues.push(`${path} must be one of ${node.enum.map((v) => JSON.stringify(v)).join(", ")}`)
    }
    return
  }
  if (node.type !== undefined && !matchesType(value, node.type)) {
    issues.push(`${path} must be ${node.type}, got ${typeOf(value)}`)
    return
  }
  if (node.type === "object") {
    const record = value as Readonly<Record<string, unknown>>
    for (const name of node.required ?? []) {
      if (record[name] === undefined) issues.push(`missing required field '${path === "args" ? name : `${path}.${name}`}'`)
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const v = record[name]
      if (v !== undefined) check(v, child, path === "args" ? name : `${path}.${name}`, issues)
    }
  }
  if (node.type === "array" && node.items !== undefined) {
    for (const [i, v] of (value as ReadonlyArray<unknown>).entries()) check(v, node.items, `${path}[${i}]`, issues)
  }
}

// checkInput validates one call's args against the method's declared input schema. Empty result
// means the call may run. Absent args stand for `{}`, so a no-arg call passes a schema that
// requires nothing. A declaration outside the subset checks as far as the subset reads.
export const checkInput = (args: unknown, input: unknown): ReadonlyArray<string> => {
  const node = asNode(input)
  if (node === undefined) return []
  const issues: Array<string> = []
  check(args === undefined ? {} : args, node, "args", issues)
  return issues
}
