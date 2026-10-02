import { boundaryEvent } from "./provider-message"
import { formatThreadAddress } from "../transport/endpoint"
import type { ThreadCoordinate } from "../actor/coordinate"
import type { ActorMethodResponse } from "./events"

const textOf = (state: ActorMethodResponse["state"]): string => {
  if (state.status === "failed") return `error: ${state.error}`
  if (state.status === "cancelled") return state.reason === undefined ? "cancelled" : `cancelled: ${state.reason}`
  if (typeof state.output === "string") return state.output
  try {
    return JSON.stringify(state.output) ?? String(state.output)
  } catch {
    return String(state.output)
  }
}

// providerResponseOf adapts a method terminal to the provider boundary-message protocol.
export const providerResponseOf = (response: ActorMethodResponse, source: ThreadCoordinate, at: number) =>
  boundaryEvent({
    turn: response.invocation.id, round: 0, text: textOf(response.state), outcome: response.state.status,
    from: formatThreadAddress(source), ...(response.state.data === undefined ? {} : { data: response.state.data }), at
  })
