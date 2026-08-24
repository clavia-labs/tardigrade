import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"

export const CELLD_PROJECT_CONFIG_PATH = "celld.jsonc"
export const CELLD_OMITTED_KEYS = ["limits", "observability", "worker_loaders"] as const
export const CELLD_SANDBOX_TRANSPORT_VAR = "TARDIGRADE_SANDBOX_TRANSPORT"
export const CELLD_SANDBOX_TRANSPORT = "replay"

export interface CelldConfig {
  readonly source: string
  readonly omitted: ReadonlyArray<string>
}

const objectOf = (raw: string, path: string): Record<string, unknown> => {
  const errors: Array<ParseError> = []
  const parsed = parse(raw, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${path} is invalid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

const celldVar = (name: string, value: unknown): string => {
  if (typeof value === "string") return value
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error(`Worker var ${JSON.stringify(name)} cannot be encoded for Celld`)
  return encoded
}

// celldConfigOf derives the Celld manifest from a Wrangler project configuration.
export const celldConfigOf = (raw: string, path = "wrangler.jsonc"): CelldConfig => {
  const source = objectOf(raw, path)
  const omitted = CELLD_OMITTED_KEYS.filter((key) => key in source)
  const omittedSet = new Set<string>(omitted)
  const config = Object.fromEntries(Object.entries(source).filter(([key]) => !omittedSet.has(key)))
  const rawVars = config["vars"]
  if (rawVars !== undefined && (typeof rawVars !== "object" || rawVars === null || Array.isArray(rawVars))) {
    throw new Error(`${path} vars must contain a JSON object`)
  }
  const vars = rawVars === undefined
    ? {}
    : Object.fromEntries(Object.entries(rawVars as Record<string, unknown>).map(([name, value]) => [
      name,
      celldVar(name, value)
    ]))
  config["vars"] = {
    ...vars,
    [CELLD_SANDBOX_TRANSPORT_VAR]: CELLD_SANDBOX_TRANSPORT
  }
  return { source: `${JSON.stringify(config, undefined, 2)}\n`, omitted }
}

// celldConfigWithVarOf keeps Celld settings while updating one variable from Wrangler.
export const celldConfigWithVarOf = (
  celldRaw: string,
  wranglerRaw: string,
  name: string,
  celldPath = CELLD_PROJECT_CONFIG_PATH,
  wranglerPath = "wrangler.jsonc"
): string => {
  objectOf(celldRaw, celldPath)
  const wrangler = objectOf(wranglerRaw, wranglerPath)
  const vars = wrangler["vars"]
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) return celldRaw
  const value = (vars as Record<string, unknown>)[name]
  if (value === undefined) return celldRaw
  const next = applyEdits(celldRaw, modify(celldRaw, ["vars", name], celldVar(name, value), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
  }))
  return next.endsWith("\n") ? next : `${next}\n`
}
