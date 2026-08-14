import { Context, Effect, Semaphore } from "effect"
import {
  EventLog,
  Router,
  Self,
  Wake,
  Writer,
  type Event,
  type EventLogStore
} from "@flamecast/core"
import { usageOf } from "./infer"
import {
  privateLog,
  type Agent,
  type AgentServices,
  type InboundMessage,
  type MessageOrigin,
  type TurnResult
} from "./module"
import { treeUsageIn } from "./turns"

// The in-process session host: the map from an address to a running session. It owns one store and
// one writer lease per address, creates a session on first delivery, and settles the program's
// machines under that session's services. It is what a `route` function had to hand-write before,
// and it is the whole registry a swarm needs: no roles, no topology, just names bound to programs.
//
// The host is also where swarm-level safety lives, because it sees every crossing. It walks the
// derived origin chain to refuse a delegation cycle and to bound recursion depth, and it stamps the
// terminal it returns with the child's inclusive tree usage, so cost folds up to the caller without
// the caller reading the child's log.
//
// A durable runtime replaces this host wholesale: on such a platform the address already names a
// durable object or a cell, and hosting is the platform's job. This one exists so a swarm runs in
// one process with nothing bound but a `route`.

// A program the host can serve. The host binds the session services itself, and `R` names whatever
// else the program's modules require, such as a sandbox or an application's own services.
export type HostedAgent<R = never> = Agent<AgentServices | R, any>

export interface HostOptions<R = never> {
  readonly programs: Readonly<
    Record<string, HostedAgent<R> | ((address: string) => HostedAgent<R>)>
  >
  // What the hosted programs require beyond the session services. The host holds it as a value
  // rather than a layer, because a router hop hands the target a context that is already built.
  readonly services?: Context.Context<R>
  // The recursion bound. The chain is derived by walking heads through their origins, so the cap
  // needs no carried counter and an application cannot forget to decrement it.
  readonly maxDepth?: number
}

export interface Host {
  readonly route: (address: string, event: Event) => Effect.Effect<Event>
  readonly call: (address: string, message: InboundMessage) => Effect.Effect<Event>
  readonly log: (address: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly sessions: Effect.Effect<ReadonlyArray<string>>
}

const DEFAULT_MAX_DEPTH = 8

const messageOf = (event: Event): InboundMessage => ({
  id: String(event.id ?? ""),
  text: String(event.text ?? ""),
  ...(event.output === undefined ? {} : { output: event.output }),
  ...(typeof event.budget === "number" ? { budget: event.budget } : {}),
  ...(event.escalatable === undefined ? {} : { escalatable: event.escalatable === true }),
  ...(event.replyTo === undefined ? {} : { replyTo: String(event.replyTo) }),
  ...(event.origin === undefined ? {} : { origin: event.origin as MessageOrigin }),
  ...(event.outcome === "completed" || event.outcome === "failed"
    ? { outcome: event.outcome }
    : {}),
  ...(event.usage === undefined ? {} : { usage: usageOf(event.usage) })
})

export const host = <R = never>(options: HostOptions<R>): Host => {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const services = options.services ?? (Context.empty() as Context.Context<R>)
  const stores = new Map<string, EventLogStore>()
  const leases = new Map<string, Semaphore.Semaphore>()
  const agents = new Map<string, HostedAgent<R>>()

  const storeOf = (address: string): EventLogStore => {
    const held = stores.get(address)
    if (held !== undefined) return held
    const fresh = privateLog([])
    stores.set(address, fresh)
    return fresh
  }

  const leaseOf = (address: string): Semaphore.Semaphore => {
    const held = leases.get(address)
    if (held !== undefined) return held
    const fresh = Semaphore.makeUnsafe(1)
    leases.set(address, fresh)
    return fresh
  }

  // Exact address first, then the longest `prefix/*` pattern. A factory builds the program once
  // per address, so a spawned session keeps one program identity for its lifetime.
  //
  // The exact lookup asks for an own property. A plain object inherits `constructor` and `toString`,
  // and a spawn pattern lets a model choose the address, so a plain index would resolve those names
  // to inherited functions and call one as a factory.
  const programOf = (address: string): HostedAgent<R> | undefined => {
    const built = agents.get(address)
    if (built !== undefined) return built
    const exact = Object.hasOwn(options.programs, address)
      ? options.programs[address]
      : undefined
    const entry =
      exact ??
      Object.entries(options.programs)
        .filter(([key]) => key.endsWith("/*") && address.startsWith(key.slice(0, -1)))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1]
    if (entry === undefined) return undefined
    const agent = typeof entry === "function" ? entry(address) : entry
    agents.set(address, agent)
    return agent
  }

  // The ancestry of a delegation, derived: each origin names a session and the turn that sent,
  // and that turn's head names its own origin. The walk stays inside this host's stores; a hop
  // into a session the host does not hold ends the chain with what is known.
  const ancestry = (origin: MessageOrigin | undefined) =>
    Effect.gen(function* () {
      const chain: Array<string> = []
      let cursor = origin
      while (cursor !== undefined && chain.length <= maxDepth) {
        const current = cursor
        chain.push(current.session)
        const store = stores.get(current.session)
        if (store === undefined) break
        const rows: ReadonlyArray<Event> = yield* store.read
        const head = rows.find(
          (event) => event.type === "MessageReceived" && String(event.id ?? "") === current.turn
        )
        cursor = head?.origin as MessageOrigin | undefined
      }
      return chain
    })

  const failed = (event: Event, error: string): Event => ({
    type: "TurnFailed",
    turn: String(event.id ?? ""),
    error
  })

  const routerValue = {
    deliver: (address: string, event: Event) => Effect.asVoid(route(address, event)),
    call: (address: string, event: Event) => route(address, event)
  }

  const terminalOf = (result: TurnResult, log: ReadonlyArray<Event>): Event => {
    const usage = treeUsageIn(log, result.turn)
    switch (result.kind) {
      case "completed":
        return { type: "TurnCompleted", turn: result.turn, output: result.output, usage }
      case "failed":
        return { type: "TurnFailed", turn: result.turn, error: result.error, usage }
      case "parked":
        // The event that parked the turn is the event that ended the settle. A caller that wants
        // to grant the ask can deliver the grant and call again; `callAgent` reads it as an error.
        return {
          type: "BudgetRequested",
          turn: result.turn,
          callId: result.callId,
          reason: result.reason,
          amount: result.amount,
          usage
        }
      case "open":
        return { type: "TurnFailed", turn: result.turn, error: "the turn settled without a terminal", usage }
    }
  }

  const route = (address: string, event: Event): Effect.Effect<Event> =>
    Effect.gen(function* () {
      const agent = programOf(address)
      if (agent === undefined) return failed(event, `the host has no program at "${address}"`)
      const origin = event.origin as MessageOrigin | undefined
      if (origin !== undefined) {
        const chain = yield* ancestry(origin)
        if (chain.includes(address)) {
          return failed(event, `delegation cycle: "${address}" is already serving this request`)
        }
        if (chain.length >= maxDepth) {
          return failed(event, `delegation depth reached the host bound of ${maxDepth}`)
        }
      }
      const store = storeOf(address)
      const provided = <A>(work: Effect.Effect<A, never, AgentServices | R>) =>
        work.pipe(
          Effect.provideContext(services),
          Effect.provideService(EventLog, store),
          Effect.provideService(Self, address),
          Effect.provideService(Writer, {
            hold: (session, held) => leaseOf(session).withPermits(1)(held)
          }),
          Effect.provideService(Wake, {
            armIfSooner: () => Effect.void,
            owed: Effect.succeed([])
          }),
          Effect.provideService(Router, routerValue)
        )
      // A message is a turn. Any other event is a delivery the session absorbs: append and settle,
      // then report the last turn's boundary, which is how a grant resumes a parked session.
      const result =
        event.type === "MessageReceived"
          ? yield* provided(agent.turn(messageOf(event)))
          : yield* provided(agent.replay([event]))
      return terminalOf(result, yield* store.read)
    })

  return {
    route,
    call: (address, message) =>
      route(address, {
        type: "MessageReceived",
        id: message.id,
        text: message.text,
        ...(message.output === undefined ? {} : { output: message.output }),
        ...(message.budget === undefined ? {} : { budget: message.budget }),
        ...(message.escalatable === undefined ? {} : { escalatable: message.escalatable }),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        ...(message.origin === undefined ? {} : { origin: message.origin })
      }),
    log: (address) => storeOf(address).read,
    sessions: Effect.sync(() => [...stores.keys()])
  }
}
