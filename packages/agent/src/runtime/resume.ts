import type { Event } from "@clavia/tardigrade-core/log/event"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/method"
import { invokedEventOf } from "@clavia/tardigrade-core/communication/envelope"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { boundaryOf, type Boundary } from "../output/boundary"
import { turnResumed } from "../log/events"

type Awaitable<T> = T | Promise<T>

// TurnDriver is the common control surface of the memory host and the durable Bun host.
export interface TurnDriver {
  readonly read: (thread: string) => Awaitable<ReadonlyArray<Event>>
  readonly commitRoot: (address: string, event: Event) => Awaitable<void>
  readonly drive: () => Promise<void>
  readonly self: (thread: string) => string
}

export interface ResumeTurnOptions {
  readonly at?: number
}

// resumeTurn starts a new execution epoch from a failed turn's committed history.
export const resumeTurn = async (
  host: TurnDriver,
  thread: string,
  turn: string,
  options: ResumeTurnOptions = {}
): Promise<Boundary | undefined> => {
  const before = await host.read(thread)
  const boundary = boundaryOf(before, turn)
  if (boundary?.kind !== "failed") {
    throw new Error(`turn "${turn}" cannot resume because its active epoch is not failed`)
  }
  const failedEpoch = turnEpochOf(before, turn)
  const failed = { method: "message", id: turn, epoch: failedEpoch }
  const previous = actorInvocationContextOf(before, failed)
  const context = {
    invocation: { ...failed, epoch: failedEpoch + 1 },
    ...(previous?.parent === undefined ? {} : { parent: previous.parent }),
    ...(previous?.deadlineAt === undefined ? {} : { deadlineAt: previous.deadlineAt })
  }
  await host.commitRoot(
    host.self(thread),
    invokedEventOf(context, turnResumed({ turn, failedEpoch, epoch: failedEpoch + 1, at: options.at ?? Date.now() }))
  )
  await host.drive()
  return boundaryOf(await host.read(thread), turn)
}
