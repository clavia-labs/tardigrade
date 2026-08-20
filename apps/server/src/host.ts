import { Clock, Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import type { Event } from "@clavia/tardigrade-core/event"
import { Infer } from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"
import { createBunHost, type BunHost } from "@clavia/tardigrade-bun/host"
import { infer } from "@clavia/tardigrade-model/model"

import { assemblyOf, type ServerR } from "./actor"
import { ServerConfig, type ServerConfigValue } from "./config"
import { DriverGauge } from "./http"

// The durable host, the assembly it runs, and the loop that drives it, behind one service. The
// routes speak thread ids; the lane a host knows lives here and nowhere else, so a route can never
// name a lane and the store can never see an id.

// LANE_PREFIX is the id-to-lane map (apps-server-spec.md, "Resources"). A lane outside it belongs
// to something other than a thread and never appears in a listing. The prefix stays `ag.` while the
// API's noun is the thread, because the lane is where the agent assembly runs, and that assembly
// mints its own child lanes under the same prefix (packages/agent/src/spawn.ts, `sibling`). Renaming
// it would rename addresses a spawn already wrote into a durable log.
export const LANE_PREFIX = "ag."

export const laneOf = (id: string): string => `${LANE_PREFIX}${id}`

// idOf is laneOf's inverse, undefined for a lane this server does not own.
export const idOf = (lane: string): string | undefined =>
  lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

// The operations the HTTP surface has: append an event, read a log, list what exists. Every one
// speaks a thread id and none of them reads an event's fields, because what an event means is the
// actor's knowledge and this service holds the log (actor.ts, agentProjections).
export class Threads extends Context.Service<
  Threads,
  {
    readonly append: (id: string, event: Event) => Effect.Effect<void>
    readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
    readonly list: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
    // settled resolves once the drive in flight, and the follow-up it coalesced, has finished. A
    // client never waits on it (a delivery answers 202 and the client polls the turn); a test and
    // a shutdown do (host.test.ts).
    readonly settled: Effect.Effect<void>
  }
>()("tardigrade/server/Threads") {}

// The model binding the configured coordinates name. Absent coordinates are not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
export const MISSING_MODEL = "no model is configured: run `tdg setup`, or set MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID"

// modelIsConfigured says whether a turn can reach a model at all. The command line reads it to say
// so once on boot rather than letting every turn be the first news (apps/cli/src/commands.ts).
export const modelIsConfigured = (config: ServerConfigValue): boolean =>
  config.model.baseUrl !== undefined && config.model.apiKey !== undefined && config.model.id !== undefined

const layerInferFrom = (config: ServerConfigValue): Layer.Layer<Infer> => {
  const { apiKey, baseUrl, id, provider } = config.model
  if (!modelIsConfigured(config) || baseUrl === undefined || apiKey === undefined || id === undefined) {
    const failed: Action = { kind: "fail", error: MISSING_MODEL, failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({ react: () => Effect.succeed(failed) })
  }
  return infer({ baseUrl, apiKey, model: id, ...(provider === undefined ? {} : { provider }) })
}

// The lane environment: everything the assembly needs that the bun host does not bind. The model
// binding is one of them, and so are the platform services the files and fetch packages reach
// through, bound here to their bun implementations. The union comes off the assembly's own type
// (actor.ts, ServerR), so a package added to the assembly is a compile error here until it is bound.
const layerLane = (config: ServerConfigValue, options: ThreadsOptions) =>
  Layer.mergeAll(
    options.infer ?? layerInferFrom(config),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

export interface ThreadsOptions {
  // The model seam. Absent, the binding is derived from ServerConfig; present, it replaces that
  // derivation whole, which is how a test runs a scripted mind with no credentials
  // (host.test.ts). It is the one seam because Infer is the one place a turn leaves the process.
  readonly infer?: Layer.Layer<Infer>
}

// make builds the host, recovers what a death interrupted, and returns the service pair. The
// close is a scope finalizer, so the process that stops listening also stops writing.
const make = (options: ThreadsOptions) =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const assembly = assemblyOf()
    const lane = layerLane(config, options)
    const host: BunHost = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createBunHost<ServerR>({
          log: config.db,
          actorFor: (lane) => (idOf(lane) === undefined ? undefined : assembly),
          layersFor: () => lane,
          keyOf: (event) => assembly.keyOf?.(event)
        })
      ),
      (open) => Effect.promise(() => open.close())
    )

    // The drive loop. Deliveries request a drive rather than run one: drives are serialized, so
    // two lanes never settle at once, and coalesced, so a request arriving mid-drive schedules
    // exactly one follow-up pass however many arrive. The follow-up runs inside the same promise,
    // so a caller awaiting a requested drive also awaits the work its own delivery enabled.
    let driving: Promise<void> | undefined
    let follow = false
    let failure: unknown = undefined
    const pump = async (): Promise<void> => {
      try {
        do {
          follow = false
          await host.drive()
        } while (follow)
      } catch (e) {
        failure = e
      } finally {
        driving = undefined
        follow = false
      }
    }
    const request = (): Promise<void> => {
      if (driving !== undefined) {
        follow = true
        return driving
      }
      driving = pump()
      return driving
    }

    // A drive that threw is a defect the loop cannot report to the delivery that caused it, so it
    // is held and raised by the next `settled`: the process dies on it rather than driving on
    // over a broken host.
    const settled = Effect.suspend(() =>
      Effect.promise(() => driving ?? Promise.resolve()).pipe(
        Effect.flatMap(() => {
          if (failure === undefined) return Effect.void
          const held = failure
          failure = undefined
          return Effect.die(held)
        })
      )
    )

    yield* Effect.promise(() => host.recover())

    const read = (id: string) => Effect.promise(() => host.read(laneOf(id)))

    const service: Context.Service.Shape<typeof Threads> = {
      // An append stamps `at` only when the caller stated none, so a replayed event keeps the time
      // it happened. Everything else about the fact is passed through: duplicate suppression is the
      // assembly's own key function, which the host was built with (actor.ts, assemblyOf).
      append: (id, event) =>
        Effect.gen(function*() {
          const at = yield* Clock.currentTimeMillis
          const stamped = event.at === undefined ? { ...event, at } : event
          yield* Effect.promise(() => host.deliver(host.self(laneOf(id)), stamped))
          request()
        }),
      events: read,
      list: () =>
        Effect.gen(function*() {
          const lanes = yield* Effect.promise(() => host.lanes())
          const ids = lanes.flatMap((lane) => {
            const id = idOf(lane)
            return id === undefined ? [] : [id]
          })
          return yield* Effect.forEach(ids, (id) => Effect.map(read(id), (events) => ({ id, events })))
        }),
      settled
    }

    // dirty counts the drive passes owed, not lanes: 0 resting, 1 while a drive runs, 2 when that
    // drive has already coalesced a follow-up. The host's own dirty set is private to it, and the
    // number a client reads is the one this loop acts on.
    const gauge: Context.Service.Shape<typeof DriverGauge> = {
      resting: Effect.promise(() => host.resting()),
      dirty: Effect.sync(() => (driving === undefined ? 0 : follow ? 2 : 1))
    }

    return Context.make(Threads, service).pipe(Context.add(DriverGauge, gauge))
  })

// layerThreads is the host, the assembly, and the driver: the Threads the routes consume and the
// DriverGauge /healthz reads, built once and closed with the scope.
export const layerThreads = (options: ThreadsOptions = {}): Layer.Layer<Threads | DriverGauge, never, ServerConfig> =>
  Layer.effectContext(make(options))
