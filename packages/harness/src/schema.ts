// The answer check: does a tool call's arguments satisfy the turn's declared output schema?
//
// The check exists because a model can produce a well-formed tool call whose arguments still miss
// the schema. A nested array arriving as a stringified copy of the whole object is the shape that
// gets you, and an unchecked answer surfaces later as a type error deep inside the code that read
// the fields.
//
// The subset covered is the one a model actually gets wrong: the declared type, a missing required
// property, a value outside an enum, and an element of the wrong type inside an array. A full
// draft-2020 validator is a dependency, and the errors it adds beyond these are ones a model does
// not make. The check is pure, which the decide that calls it requires.

const kindOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const matches = (expected: string, value: unknown): boolean => {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value)
  return expected === kindOf(value)
}

const at = (path: string) => (path === "" ? "/" : path)

const walk = (schema: unknown, value: unknown, path: string, errors: Array<string>): void => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return
  const rules = schema as Record<string, unknown>

  const declared =
    typeof rules.type === "string"
      ? [rules.type]
      : Array.isArray(rules.type)
        ? rules.type.filter((one): one is string => typeof one === "string")
        : []
  if (declared.length > 0 && !declared.some((one) => matches(one, value))) {
    // Once the type is wrong, every nested report is noise about a value that was never there.
    errors.push(`${at(path)}: expected ${declared.join(" or ")}, got ${kindOf(value)}`)
    return
  }

  if (Array.isArray(rules.enum)) {
    const encoded = JSON.stringify(value)
    if (!rules.enum.some((one) => JSON.stringify(one) === encoded)) {
      errors.push(`${at(path)}: expected one of ${JSON.stringify(rules.enum)}`)
    }
  }

  if (kindOf(value) === "object") {
    const record = value as Record<string, unknown>
    const properties =
      rules.properties !== null && typeof rules.properties === "object"
        ? (rules.properties as Record<string, unknown>)
        : {}
    if (Array.isArray(rules.required)) {
      for (const name of rules.required) {
        if (typeof name === "string" && record[name] === undefined) {
          errors.push(`${path}/${name}: required`)
        }
      }
    }
    for (const [name, sub] of Object.entries(properties)) {
      if (record[name] !== undefined) walk(sub, record[name], `${path}/${name}`, errors)
    }
    if (rules.additionalProperties === false) {
      for (const name of Object.keys(record)) {
        if (!(name in properties)) errors.push(`${path}/${name}: not allowed here`)
      }
    }
  }

  if (Array.isArray(value) && rules.items !== undefined) {
    value.forEach((item, index) => walk(rules.items, item, `${path}/${index}`, errors))
  }
}

// Why an answer fails its schema, one line each. Empty when it conforms, and empty when the turn
// declared nothing to conform to.
export const answerErrors = (schema: unknown, answer: unknown): ReadonlyArray<string> => {
  if (schema === undefined || schema === null || typeof schema !== "object") return []
  const errors: Array<string> = []
  walk(schema, answer === undefined ? {} : answer, "", errors)
  return errors
}

// What the model reads when its answer misses the schema. The errors are the whole message, so the
// model repairs the shape it actually got wrong.
export const repairText = (errors: ReadonlyArray<string>): string =>
  `Your answer did not match this turn's output schema:\n${errors.map((one) => `- ${one}`).join("\n")}\n` +
  "Call the answer tool again with arguments that satisfy the schema. Send values in their " +
  "declared types: an array is a JSON array, never a string holding one."
