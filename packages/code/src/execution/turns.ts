import type { Event } from "@clavia/tardigrade-core/log/event"

// Turn attribution. A turn is headed by one MessageReceived; every event serving it carries
// turn: <head id>. Attribution is a fact the event carries, never a derivation from position,
// so concurrent ingress cannot cross-wire turns: a message committed mid-turn waits, unserved.
// turnView is the current turn: the earliest unserved head plus its stamped events. An empty view is quiescence.

const idOf = (e: Event): string => String((e as { id?: unknown }).id ?? "")
export const turnOf = (e: Event): string | undefined => {
  const t = (e as { turn?: unknown }).turn
  return t === undefined ? undefined : String(t)
}

const stamped = (log: ReadonlyArray<Event>, id: string): ReadonlyArray<Event> =>
  log.filter((e) => turnOf(e) === id)

// eventEpochOf returns the execution epoch stamped on an event. Historical events belong to epoch zero.
export const eventEpochOf = (event: Event): number => {
  const epoch = (event as { epoch?: unknown }).epoch
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0
}

// turnEpochOf returns the latest execution epoch reached through a failed predecessor. A resume
// after another terminal is inert (turns.test.ts, "only a failed epoch can resume").
export const turnEpochOf = (log: ReadonlyArray<Event>, turn: string): number => {
  let epoch = 0
  while (
    log.some((event) => event.type === "TurnFailed" && turnOf(event) === turn && eventEpochOf(event) === epoch) &&
    log.some((event) =>
      event.type === "TurnResumed" &&
      turnOf(event) === turn &&
      Number((event as { readonly failedEpoch?: unknown }).failedEpoch ?? 0) === epoch &&
      eventEpochOf(event) === epoch + 1
    )
  ) epoch += 1
  return epoch
}

const isTerminal = (event: Event): boolean =>
  event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled"

// turnTerminalOf returns the terminal in the active execution epoch.
export const turnTerminalOf = (log: ReadonlyArray<Event>, turn: string): Event | undefined => {
  const epoch = turnEpochOf(log, turn)
  return log.find((event) => isTerminal(event) && turnOf(event) === turn && eventEpochOf(event) === epoch)
}

const activeStamped = (log: ReadonlyArray<Event>, turn: string): ReadonlyArray<Event> => {
  const epoch = turnEpochOf(log, turn)
  return stamped(log, turn).filter((event) => !isTerminal(event) || eventEpochOf(event) === epoch)
}

const heads = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.filter((event) => event.type === "MessageReceived")

// TurnIndex records, per turn, the epochs that failed, resumed from a failure, and reached a terminal.
interface TurnIndex {
  readonly failed: Map<string, Set<number>>
  readonly resumed: Map<string, Set<number>>
  readonly terminals: Map<string, Set<number>>
}

const note = (index: Map<string, Set<number>>, turn: string, epoch: number): void => {
  const epochs = index.get(turn)
  if (epochs === undefined) index.set(turn, new Set([epoch]))
  else epochs.add(epoch)
}

// turnIndexOf reads the log once, so a turn's epoch and terminal cost lookups instead of log scans.
const turnIndexOf = (log: ReadonlyArray<Event>): TurnIndex => {
  const index: TurnIndex = { failed: new Map(), resumed: new Map(), terminals: new Map() }
  for (const event of log) {
    const turn = turnOf(event)
    if (turn === undefined) continue
    const epoch = eventEpochOf(event)
    if (event.type === "TurnFailed") note(index.failed, turn, epoch)
    if (event.type === "TurnResumed") {
      const failedEpoch = Number((event as { readonly failedEpoch?: unknown }).failedEpoch ?? 0)
      if (epoch === failedEpoch + 1) note(index.resumed, turn, failedEpoch)
    }
    if (isTerminal(event)) note(index.terminals, turn, epoch)
  }
  return index
}

// indexedEpochOf is turnEpochOf over a TurnIndex (turns.test.ts, "matches the scanning epoch and head").
const indexedEpochOf = (index: TurnIndex, turn: string): number => {
  let epoch = 0
  while (index.failed.get(turn)?.has(epoch) === true && index.resumed.get(turn)?.has(epoch) === true) epoch += 1
  return epoch
}

// turnHead returns the current turn's head: the earliest message with no stamped terminal.
export const turnHead = (log: ReadonlyArray<Event>): Event | undefined => {
  const index = turnIndexOf(log)
  return heads(log).find((head) => index.terminals.get(idOf(head))?.has(indexedEpochOf(index, idOf(head))) !== true)
}

// turnView returns the current turn's slice: its head plus its stamped events, in log order.
export const turnView = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const head = turnHead(log)
  return head === undefined ? [] : [head, ...activeStamped(log, idOf(head))]
}

// trajectoryOf is the model's projection: turns in service order, each head just before its
// first stamped event, queued unserved messages excluded, unstamped events passing through in
// place. react receives the conversation as served, never as it interleaved at ingress.
export const trajectoryOf = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const current = turnHead(log)
  const index = turnIndexOf(log)
  const emitted = new Set<string>()
  const byId = new Map(heads(log).map((h) => [idOf(h), h]))
  const out: Event[] = []
  for (const e of log) {
    if (e.type === "MessageReceived") continue
    const turn = turnOf(e)
    if (turn !== undefined && isTerminal(e) && eventEpochOf(e) !== indexedEpochOf(index, turn)) continue
    if (turn !== undefined && !emitted.has(turn)) {
      const head = byId.get(turn)
      if (head !== undefined) out.push(head)
      emitted.add(turn)
    }
    out.push(e)
  }
  if (current !== undefined && !emitted.has(idOf(current))) out.push(current)
  return out
}
