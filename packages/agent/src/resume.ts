import type { Event } from "@clavia/tardigrade-core/event"
import { turnEpochOf } from "@clavia/tardigrade-code/turns"
import { boundaryOf, type Boundary } from "./boundary"
import { turnResumed } from "./events"

type Awaitable<T> = T | Promise<T>

// TurnDriver is the common control surface of the memory host and the durable Bun host.
export interface TurnDriver {
  readonly read: (lane: string) => Awaitable<ReadonlyArray<Event>>
  readonly deliver: (address: string, event: Event) => Awaitable<void>
  readonly drive: () => Promise<void>
  readonly self: (lane: string) => string
}

export interface ResumeTurnOptions {
  readonly at?: number
}

// resumeTurn starts a new execution epoch from a failed turn's committed history.
export const resumeTurn = async (
  host: TurnDriver,
  lane: string,
  turn: string,
  options: ResumeTurnOptions = {}
): Promise<Boundary | undefined> => {
  const before = await host.read(lane)
  const boundary = boundaryOf(before, turn)
  if (boundary?.kind !== "failed") {
    throw new Error(`turn "${turn}" cannot resume because its active epoch is not failed`)
  }
  const failedEpoch = turnEpochOf(before, turn)
  await host.deliver(
    host.self(lane),
    turnResumed({ turn, failedEpoch, epoch: failedEpoch + 1, at: options.at ?? Date.now() })
  )
  await host.drive()
  return boundaryOf(await host.read(lane), turn)
}
