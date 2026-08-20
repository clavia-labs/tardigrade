import { Clock, Context, Data, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { messageReceived } from "@clavia/tardigrade-core/message"
import {
  agentOf,
  agentsPackage,
  budget,
  codeModeFor,
  compaction,
  Infer,
  reply,
  resumeTurn,
  workspacePackage,
  type RlmR
} from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"
import { createBunHost, type BunHost } from "@clavia/tardigrade-bun/host"
import { infer } from "@clavia/tardigrade-model/model"

import { ServerConfig, type ServerConfigValue } from "./config"
import { DriverGauge } from "./http"

// The durable host, the assembly it runs, and the loop that drives it, behind one service. The
// routes speak agent ids; the lane a host knows lives here and nowhere else, so a route can never
// name a lane and the store can never see an id.

// LANE_PREFIX is the id-to-lane map (apps-server-spec.md, "Resources"). A lane outside it belongs
// to something other than an agent and never appears in a listing.
export const LANE_PREFIX = "ag."

export const laneOf = (id: string): string => `${LANE_PREFIX}${id}`

// idOf is laneOf's inverse, undefined for a lane this server does not own.
export const idOf = (lane: string): string | undefined =>
  lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

// Inbound is one delivered message: the canonical inbound's fields a client may state
// (packages/core/src/message.ts, MessageReceived). `id` is the dedup key end to end and becomes
// the turn id.
export interface Inbound {
  readonly id: string
  readonly text: string
  readonly input?: unknown
  readonly data?: unknown
}

// ResumeRefused is the library's guard, typed: a turn resumes only from a failed active epoch
// (packages/agent/src/resume.ts). `detail` is the library's own message, which the route renders
// as the 409's detail (host.test.ts, "a turn that did not fail refuses to resume").
export class ResumeRefused extends Data.TaggedError("ResumeRefused")<{
  readonly id: string
  readonly turn: string
  readonly detail: string
}> {}

// The operations the HTTP surface has: deliver a message, read a log, list what exists, resume a
// failed turn. Every one speaks an agent id. Reads return raw events because the projections are
// pure functions of a log (projections.ts); a route joins the two.
export class Agents extends Context.Service<
  Agents,
  {
    readonly deliver: (id: string, message: Inbound) => Effect.Effect<{ agent: string; turn: string }>
    readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
    readonly list: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
    readonly resume: (id: string, turn: string) => Effect.Effect<void, ResumeRefused>
    // settled resolves once the drive in flight, and the follow-up it coalesced, has finished. A
    // client never waits on it (a delivery answers 202 and the client polls the turn); a test and
    // a shutdown do (host.test.ts).
    readonly settled: Effect.Effect<void>
  }
>()("tardigrade/server/Agents") {}

// The assembly this server runs, one for every lane: code mode with the spawn and workspace
// packages in scope, plus the three policy capabilities. v1 runs this one assembly and forking is
// the customization path (apps-server-spec.md, "Explicitly out of scope for v1").
const assemblyOf = () =>
  agentOf([
    codeModeFor({}, {}, [agentsPackage({ budget: {} }), workspacePackage({ policy: {} })]),
    reply,
    budget,
    compaction
  ])

// The model binding the configured coordinates name. Absent coordinates are not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
const MISSING_MODEL = "no model is configured: set MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID"

const layerInferFrom = (config: ServerConfigValue): Layer.Layer<Infer> => {
  const { apiKey, baseUrl, id, provider } = config.model
  if (baseUrl === undefined || apiKey === undefined || id === undefined) {
    const failed: Action = { kind: "fail", error: MISSING_MODEL, failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({ react: () => Effect.succeed(failed) })
  }
  return infer({ baseUrl, apiKey, model: id, ...(provider === undefined ? {} : { provider }) })
}

export interface AgentsOptions {
  // The model seam. Absent, the binding is derived from ServerConfig; present, it replaces that
  // derivation whole, which is how a test runs a scripted mind with no credentials
  // (host.test.ts). It is the one seam because Infer is the one place a turn leaves the process.
  readonly infer?: Layer.Layer<Infer>
}

// make builds the host, recovers what a death interrupted, and returns the service pair. The
// close is a scope finalizer, so the process that stops listening also stops writing.
const make = (options: AgentsOptions) =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const assembly = assemblyOf()
    const inferLayer = options.infer ?? layerInferFrom(config)
    const host: BunHost = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createBunHost<RlmR>({
          log: config.db,
          actorFor: (lane) => (idOf(lane) === undefined ? undefined : assembly),
          layersFor: () => inferLayer,
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

    const service: Context.Service.Shape<typeof Agents> = {
      deliver: (id, message) =>
        Effect.gen(function*() {
          const at = yield* Clock.currentTimeMillis
          yield* Effect.promise(() =>
            host.deliver(
              host.self(laneOf(id)),
              messageReceived({
                id: message.id,
                text: message.text,
                ...(message.input === undefined ? {} : { input: message.input }),
                ...(message.data === undefined ? {} : { data: message.data }),
                at
              })
            )
          )
          request()
          return { agent: id, turn: message.id }
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
      // resumeTurn drives through this loop rather than the host, so a resume is serialized with
      // every other drive (packages/agent/src/resume.ts, TurnDriver).
      resume: (id, turn) =>
        Effect.tryPromise({
          try: () =>
            resumeTurn(
              { read: host.read, deliver: host.deliver, drive: request, self: host.self },
              laneOf(id),
              turn
            ),
          catch: (e) =>
            new ResumeRefused({ id, turn, detail: e instanceof Error ? e.message : String(e) })
        }).pipe(Effect.asVoid),
      settled
    }

    // dirty counts the drive passes owed, not lanes: 0 resting, 1 while a drive runs, 2 when that
    // drive has already coalesced a follow-up. The host's own dirty set is private to it, and the
    // number a client reads is the one this loop acts on.
    const gauge: Context.Service.Shape<typeof DriverGauge> = {
      resting: Effect.promise(() => host.resting()),
      dirty: Effect.sync(() => (driving === undefined ? 0 : follow ? 2 : 1))
    }

    return Context.make(Agents, service).pipe(Context.add(DriverGauge, gauge))
  })

// layerAgents is the host, the assembly, and the driver: the Agents the routes consume and the
// DriverGauge /healthz reads, built once and closed with the scope.
export const layerAgents = (options: AgentsOptions = {}): Layer.Layer<Agents | DriverGauge, never, ServerConfig> =>
  Layer.effectContext(make(options))
