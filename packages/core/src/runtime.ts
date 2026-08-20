export const MINIMUM_BUN_VERSION = "1.4.0"

const partsOf = (version: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

// supportsBunVersion reports whether a Bun version includes the required transport behavior.
export const supportsBunVersion = (version: string): boolean => {
  const actual = partsOf(version)
  const minimum = partsOf(MINIMUM_BUN_VERSION)!
  if (actual === undefined) return false
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i]! > minimum[i]!) return true
    if (actual[i]! < minimum[i]!) return false
  }
  return true
}

const detectedBunVersion = (): string | undefined => {
  const version = (globalThis as { Bun?: { version?: unknown } }).Bun?.version
  return typeof version === "string" ? version : undefined
}

// assertSupportedBun rejects Bun releases with the five-minute fetch idle deadline.
export const assertSupportedBun = (version: string | undefined = detectedBunVersion()): void => {
  if (version === undefined || supportsBunVersion(version)) return
  throw new Error(`Tardigrade requires Bun ${MINIMUM_BUN_VERSION} or later. Found Bun ${version}. Upgrade Bun before starting Tardigrade.`)
}
