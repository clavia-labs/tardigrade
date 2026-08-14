export const environment = (name: string): string | undefined => {
  const value = typeof process === "undefined" ? undefined : process.env[name]
  return value === undefined || value === "" ? undefined : value
}

export const environmentNumber = (name: string): number | undefined => {
  const value = environment(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
