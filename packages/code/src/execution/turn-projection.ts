import { Chunk, HashMap, HashSet, Option } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { REPLY_SUFFIX } from "./ids"
import { eventEpochOf, turnOf } from "./turns"

interface TurnRecord {
  readonly events: Chunk.Chunk<Event>
  readonly failed: HashSet.HashSet<number>
  readonly resumed: HashSet.HashSet<number>
  readonly terminals: HashMap.HashMap<number, Event>
  readonly epoch: number
}

interface TurnHeadRecord {
  readonly event: Event
  readonly order: number
}

// TurnProjectionState retains exactly the turn-order facts needed by turnView and trajectoryOf.
export interface TurnProjectionState {
  readonly nextHead: number
  readonly heads: HashMap.HashMap<string, TurnHeadRecord>
  readonly open: HashMap.HashMap<string, number>
  readonly turns: HashMap.HashMap<string, TurnRecord>
  readonly openPackages: HashSet.HashSet<string>
  readonly served: HashSet.HashSet<string>
  readonly trajectory: Chunk.Chunk<Event>
}

const emptyTurn = (): TurnRecord => ({
  events: Chunk.empty(),
  failed: HashSet.empty(),
  resumed: HashSet.empty(),
  terminals: HashMap.empty(),
  epoch: 0
})

// initialTurnProjection constructs the empty turn quotient.
export const initialTurnProjection = (): TurnProjectionState => ({
  nextHead: 0,
  heads: HashMap.empty(),
  open: HashMap.empty(),
  turns: HashMap.empty(),
  openPackages: HashSet.empty(),
  served: HashSet.empty(),
  trajectory: Chunk.empty()
})

const field = (event: Event, name: string): string =>
  String((event as Record<string, unknown>)[name] ?? "")

const terminal = (event: Event): boolean =>
  event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled"

const claimedReply = (state: TurnProjectionState, event: Event): boolean => {
  const id = field(event, "id")
  return id.endsWith(REPLY_SUFFIX) && HashSet.has(state.openPackages, id.slice(0, -REPLY_SUFFIX.length))
}

const advanceEpoch = (record: TurnRecord): number => {
  let epoch = record.epoch
  while (HashSet.has(record.failed, epoch) && HashSet.has(record.resumed, epoch)) epoch += 1
  return epoch
}

const reducePackageCalls = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  if (event.type !== "PackageCalled" && event.type !== "PackageReturned") return state
  const call = field(event, "callId")
  return {
    ...state,
    openPackages: event.type === "PackageCalled"
      ? HashSet.add(state.openPackages, call)
      : HashSet.remove(state.openPackages, call)
  }
}

const reduceHead = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  if (event.type !== "MessageReceived" || claimedReply(state, event)) return state
  const id = field(event, "id")
  if (HashMap.has(state.heads, id)) return state
  const turn = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
  return {
    ...state,
    nextHead: state.nextHead + 1,
    heads: HashMap.set(state.heads, id, { event, order: state.nextHead }),
    open: HashMap.has(turn.terminals, turn.epoch)
      ? state.open
      : HashMap.set(state.open, id, state.nextHead)
  }
}

const reduceTurn = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  const id = turnOf(event)
  if (id === undefined) return state
  const previous = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
  const eventEpoch = eventEpochOf(event)
  const failed = event.type === "TurnFailed" ? HashSet.add(previous.failed, eventEpoch) : previous.failed
  const failedEpoch = event.type === "TurnResumed"
    ? Number((event as { readonly failedEpoch?: unknown }).failedEpoch ?? 0)
    : undefined
  const resumed = failedEpoch === undefined || eventEpoch !== failedEpoch + 1
    ? previous.resumed
    : HashSet.add(previous.resumed, failedEpoch)
  const terminals = terminal(event) ? HashMap.set(previous.terminals, eventEpoch, event) : previous.terminals
  const record = {
    events: Chunk.append(previous.events, event),
    failed,
    resumed,
    terminals,
    epoch: advanceEpoch({ ...previous, failed, resumed, terminals })
  }
  if (!HashMap.has(state.heads, id)) return { ...state, turns: HashMap.set(state.turns, id, record) }
  const head = Option.getOrUndefined(HashMap.get(state.heads, id))!
  return {
    ...state,
    turns: HashMap.set(state.turns, id, record),
    open: HashMap.has(record.terminals, record.epoch)
      ? HashMap.remove(state.open, id)
      : HashMap.set(state.open, id, head.order)
  }
}

const reduceTrajectory = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  if (event.type === "MessageReceived") return state
  const id = turnOf(event)
  if (id === undefined || HashSet.has(state.served, id)) {
    return { ...state, trajectory: Chunk.append(state.trajectory, event) }
  }
  const head = Option.getOrUndefined(HashMap.get(state.heads, id))
  return {
    ...state,
    served: HashSet.add(state.served, id),
    trajectory: head === undefined
      ? Chunk.append(state.trajectory, event)
      : Chunk.append(Chunk.append(state.trajectory, head.event), event)
  }
}

// reduceTurnProjection advances the quotient by one durable event.
export const reduceTurnProjection = (state: TurnProjectionState, event: Event): TurnProjectionState => {
  const packages = reducePackageCalls(state, event)
  const headed = reduceHead(packages, event)
  const turned = reduceTurn(headed, event)
  return reduceTrajectory(turned, event)
}

const currentHead = (state: TurnProjectionState): { readonly id: string; readonly head: TurnHeadRecord } | undefined => {
  let current: { readonly id: string; readonly head: TurnHeadRecord } | undefined
  for (const [id, order] of HashMap.entries(state.open)) {
    const head = Option.getOrUndefined(HashMap.get(state.heads, id))
    if (head !== undefined && (current === undefined || order < current.head.order)) current = { id, head }
  }
  return current
}

// turnViewFrom returns the current active turn from the incremental quotient.
export const turnViewFrom = (state: TurnProjectionState): ReadonlyArray<Event> => {
  const current = currentHead(state)
  if (current === undefined) return []
  const record = Option.getOrElse(HashMap.get(state.turns, current.id), emptyTurn)
  return [
    current.head.event,
    ...Chunk.toReadonlyArray(record.events).filter((event) => !terminal(event) || eventEpochOf(event) === record.epoch)
  ]
}

// trajectoryFrom returns served conversation order from the incremental quotient.
export const trajectoryFrom = (state: TurnProjectionState): ReadonlyArray<Event> => {
  const projected = Chunk.toReadonlyArray(state.trajectory).filter((event) => {
    const id = turnOf(event)
    if (id === undefined || !terminal(event)) return true
    const record = Option.getOrElse(HashMap.get(state.turns, id), emptyTurn)
    return eventEpochOf(event) === record.epoch
  })
  const current = currentHead(state)
  return current === undefined || HashSet.has(state.served, current.id)
    ? projected
    : [...projected, current.head.event]
}

// turnTerminalFrom returns the terminal for one turn's active epoch.
export const turnTerminalFrom = (state: TurnProjectionState, turn: string): Event | undefined => {
  const record = Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn)
  return Option.getOrUndefined(HashMap.get(record.terminals, record.epoch))
}

// turnEpochFrom returns one turn's active execution epoch.
export const turnEpochFrom = (state: TurnProjectionState, turn: string): number =>
  Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn).epoch

// turnHeadFrom returns one named turn's accepted head.
export const turnHeadFrom = (state: TurnProjectionState, turn: string): Event | undefined =>
  Option.getOrUndefined(HashMap.get(state.heads, turn))?.event

// turnTerminalAtFrom returns one named turn's terminal at an execution epoch.
export const turnTerminalAtFrom = (state: TurnProjectionState, turn: string, epoch: number): Event | undefined =>
  Option.getOrUndefined(HashMap.get(
    Option.getOrElse(HashMap.get(state.turns, turn), emptyTurn).terminals,
    epoch
  ))
