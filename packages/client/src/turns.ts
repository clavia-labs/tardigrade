import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnsOf as snapshotsOf, turnViewOf as snapshotOf, type TurnSnapshot } from "@clavia/tardigrade-agent/output/boundary"
import { projection } from "./contract"
import { Schema } from "effect"
import { TurnView, type TurnView as TurnViewType } from "./contract"

// turnViewOf projects one turn into the HTTP TurnView, including a parked budget or schema ask.
export const turnViewOf = (log: ReadonlyArray<Event>, turn: string): TurnViewType =>
  snapshotOf(log, turn) as TurnViewType

// turnsOf lists every MessageReceived as a TurnView in log order.
export const turnsOf = (log: ReadonlyArray<Event>): ReadonlyArray<TurnViewType> =>
  snapshotsOf(log) as ReadonlyArray<TurnViewType>

export type { TurnSnapshot }

// turnsProjection is the ready-made turns read an actor can mount on the HTTP API.
export const turnsProjection = projection({
  params: {},
  result: Schema.Array(TurnView),
  run: (events) => turnsOf(events)
})
