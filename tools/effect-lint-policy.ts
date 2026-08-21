import { fileURLToPath } from "node:url"

type EffectPolicy = {
  readonly compilerOptions?: {
    readonly plugins?: ReadonlyArray<{
      readonly name?: string
      readonly diagnosticSeverity?: Readonly<Record<string, unknown>>
    }>
  }
}

type EffectSchema = {
  readonly definitions?: Readonly<Record<string, {
    readonly properties?: Readonly<Record<string, unknown>>
  }>>
}

const root = fileURLToPath(new URL("../", import.meta.url))
const policyPath = `${root}tsconfig.effect.json`
const schemaPath = `${root}node_modules/@effect/tsgo/schema.json`
const policy = Bun.JSONC.parse(await Bun.file(policyPath).text()) as EffectPolicy
const schema = await Bun.file(schemaPath).json() as EffectSchema
const plugin = policy.compilerOptions?.plugins?.find(({ name }) => name === "@effect/language-service")
const configuredRules = plugin?.diagnosticSeverity
const shippedRules = schema.definitions?.effectLanguageServicePluginDiagnosticSeverityDefinition?.properties

if (configuredRules === undefined) {
  throw new Error(`${policyPath} does not define the @effect/language-service diagnosticSeverity policy`)
}
if (shippedRules === undefined) {
  throw new Error(`${schemaPath} does not expose the Effect diagnostic rule catalog`)
}

const configured = Object.keys(configuredRules).sort()
const shipped = Object.keys(shippedRules).sort()
const configuredSet = new Set(configured)
const shippedSet = new Set(shipped)
const missing = shipped.filter((rule) => !configuredSet.has(rule))
const unknown = configured.filter((rule) => !shippedSet.has(rule))
const gateSeverities = new Set(["error", "off", "warning"])
const nonGating = Object.entries(configuredRules)
  .filter(([, severity]) => typeof severity !== "string" || !gateSeverities.has(severity))
  .map(([rule, severity]) => `${rule}:${String(severity)}`)

if (missing.length > 0 || unknown.length > 0 || nonGating.length > 0) {
  const details = [
    ...(missing.length === 0 ? [] : [`missing rules: ${missing.join(", ")}`]),
    ...(unknown.length === 0 ? [] : [`unknown rules: ${unknown.join(", ")}`]),
    ...(nonGating.length === 0 ? [] : [`non-gating severities: ${nonGating.join(", ")}`])
  ]
  throw new Error(`Effect lint policy does not match the installed rule catalog\n${details.join("\n")}`)
}

console.log(`Effect lint policy names all ${shipped.length} installed rules at gating severities`)
