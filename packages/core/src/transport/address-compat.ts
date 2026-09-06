import type { ThreadCoordinate } from "../actor/coordinate"

// legacyThreadAddressOf retains the colon encoding when its fields round-trip without ambiguity.
export const legacyThreadAddressOf = (coordinate: ThreadCoordinate): string | undefined =>
  coordinate.actor !== "" && !coordinate.actor.includes(":") && !coordinate.actor.startsWith("[") &&
    coordinate.instance !== "" && !coordinate.instance.includes(":") && coordinate.thread !== ""
    ? `${coordinate.actor}:${coordinate.instance}:${coordinate.thread}`
    : undefined

// parseLegacyThreadAddress reads persisted actor:instance:thread addresses.
export const parseLegacyThreadAddress = (value: string): ThreadCoordinate => {
  const actorEnd = value.indexOf(":")
  const instanceEnd = value.indexOf(":", actorEnd + 1)
  if (actorEnd <= 0 || instanceEnd <= actorEnd + 1 || instanceEnd === value.length - 1) {
    throw new Error(`invalid thread address ${JSON.stringify(value)}`)
  }
  return { actor: value.slice(0, actorEnd), instance: value.slice(actorEnd + 1, instanceEnd), thread: value.slice(instanceEnd + 1) }
}
