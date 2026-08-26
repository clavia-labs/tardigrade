import type { Event } from "@clavia/tardigrade-core/log/event"
import { REPLY_SUFFIX } from "./ids"

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

// turnEpochOf returns the latest execution epoch that an operator started for one turn.
export const turnEpochOf = (log: ReadonlyArray<Event>, turn: string): number =>
  log.reduce((epoch, event) => {
    if (event.type !== "TurnResumed" || turnOf(event) !== turn) return epoch
    return Math.max(epoch, eventEpochOf(event))
  }, 0)

const isTerminal = (event: Event): boolean => event.type === "TurnCompleted" || event.type === "TurnFailed"

// turnTerminalOf returns the terminal in the active execution epoch.
export const turnTerminalOf = (log: ReadonlyArray<Event>, turn: string): Event | undefined => {
  const epoch = turnEpochOf(log, turn)
  return log.find((event) => isTerminal(event) && turnOf(event) === turn && eventEpochOf(event) === epoch)
}

const activeStamped = (log: ReadonlyArray<Event>, turn: string): ReadonlyArray<Event> => {
  const epoch = turnEpochOf(log, turn)
  return stamped(log, turn).filter((event) => !isTerminal(event) || eventEpochOf(event) === epoch)
}

// claimedByPark: a reply an open package call was awaiting when it landed belongs to that call,
// never to a fresh turn of its own; the awaiting body harvests it, and nothing else may react
// to it as inbound. The verdict reads only events before the reply's own position, so later
// appends cannot rewrite it (tla/runtime/Projection.tla, PrefixFaithful). A background spawn's reply is
// the opposite case and is meant to head its own turn: its call returned at once, so no call is
// open for it. Only agents.run ids can ever match: tasks.fire mints run- prefixed ids
// (mintedRunId, src/grammar/grammar.ts), so a task reply is structurally never claimed.
const claimedByPark = (log: ReadonlyArray<Event>, index: number): boolean => {
  const id = idOf(log[index]!)
  if (!id.endsWith(REPLY_SUFFIX)) return false
  const callId = id.slice(0, -REPLY_SUFFIX.length)
  let open = false
  for (let i = 0; i < index; i++) {
    const e = log[i]!
    if (e.type !== "PackageCalled" && e.type !== "PackageReturned") continue
    if (String((e as { callId?: unknown }).callId) !== callId) continue
    open = e.type === "PackageCalled"
  }
  return open
}

const heads = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.filter((e, i) => e.type === "MessageReceived" && !claimedByPark(log, i))

// turnHead returns the current turn's head: the earliest message with no stamped terminal.
export const turnHead = (log: ReadonlyArray<Event>): Event | undefined =>
  heads(log).find((head) => turnTerminalOf(log, idOf(head)) === undefined)

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
  const emitted = new Set<string>()
  const byId = new Map(heads(log).map((h) => [idOf(h), h]))
  const out: Event[] = []
  for (const e of log) {
    if (e.type === "MessageReceived") continue
    const turn = turnOf(e)
    if (turn !== undefined && isTerminal(e) && eventEpochOf(e) !== turnEpochOf(log, turn)) continue
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
