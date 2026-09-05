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


// A reply belongs to the open package call whose BlockedOn fact names its exact identity in the
// same turn. The verdict reads only events before the reply's own position, so later appends
// cannot rewrite it (tla/runtime/Projection.tla, PrefixFaithful). A reply no call awaits heads
// its own turn: a background spawn's call returned at once, so no BlockedOn names its reply.
const claimedByPark = (log: ReadonlyArray<Event>, index: number): boolean => {
  const id = idOf(log[index]!)
  const blocked = log.slice(0, index).findLast(
    (event) => event.type === "BlockedOn" && String(event.awaiting) === id
  )
  if (blocked === undefined) return false
  const callId = String(blocked.callId ?? "")
  const turn = turnOf(blocked)
  let open = false
  for (let i = 0; i < index; i++) {
    const event = log[i]!
    if (event.type !== "PackageCalled" && event.type !== "PackageReturned") continue
    if (String(event.callId) !== callId || turnOf(event) !== turn) continue
    open = event.type === "PackageCalled"
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
