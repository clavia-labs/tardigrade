// structuredWorkerConfigOf accepts Wrangler object vars and string-only Worker runtimes.
export const structuredWorkerConfigOf = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (value === undefined) return undefined
  let parsed: unknown = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error("TARDIGRADE_CONFIG must be valid JSON")
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TARDIGRADE_CONFIG must be a JSON object")
  }
  return parsed as Readonly<Record<string, unknown>>
}
