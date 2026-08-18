import { Clock, Context, Effect, Option } from "effect"
import {
  Alarm,
  EventLog,
  Router,
  Self,
  Writer,
  actor,
  send,
  settleAll,
  type Event,
  type EventLogStore,
  type Machine
} from "@flamecast/core"
import { alarmFired } from "./alphabet"
import { boundaryOf, type CallResult } from "./boundary"
import { type ModelRequest, type NativeToolSpec, type Spend, type Usage, RequestOptionsProjection } from "./infer"
import { keyOf } from "./keys"
import { modelRequest } from "./render"
import {
  WITHDRAW_ALL,
  agentId,
  type AgentDefinition,
  type Instruction,
  type ModuleManifest,
  type Nudge,
  type RenderPlan
} from "./definition"
import { pendingDeferral, turnHead, usageIn } from "./turns"

export type AgentServices = EventLog | Writer | Router | Self | Alarm

export interface ModulePart<R = never> {
  readonly events?: ReadonlyArray<string>
  readonly machines?:
    | ReadonlyArray<Machine<R, never>>
    | ((render: RenderPlan) => ReadonlyArray<Machine<R, never>>)
  readonly instructions?: ReadonlyArray<Instruction>
  readonly nudges?: ReadonlyArray<Nudge>
  readonly nativeTools?: ReadonlyArray<NativeToolSpec>
  readonly render?: Partial<Pick<RenderPlan, "messageTruncateAt" | "resultTruncateAt">>
}

type AnyService = Context.Service.Any

// What a module's declared requirements name. `defineModule` takes `Requires` as a `const`, so a
// module that declares any is always a literal tuple, and a tuple has a literal `length`. An
// unbounded array reaches here only when inference had nothing to read and fell back to the
// constraint, which happens to a module written inline inside `createAgent`, where the tuple's own
// element constraint is the contextual type. Reading that as "requires every service" would reject
// a module that declares none, so it reads as what it means: nothing was declared.
type RequiredServices<Requires extends readonly AnyService[]> = number extends Requires["length"]
  ? never
  : Context.Service.Identifier<Requires[number]>

export interface Module<
  Id extends string = string,
  Services = never,
  Requires extends readonly AnyService[] = readonly [],
  R = never
> {
  readonly id: Id
  readonly version?: string
  readonly identity?: unknown
  readonly services?: Context.Context<Services>
  readonly requires?: Requires
  readonly setup: (context: Context.Context<RequiredServices<Requires>>) => ModulePart<R>
}

// A module in a heterogeneous tuple, and the constraint every module tuple is checked against.
//
// `Requires` is the one `any` in the framework, and it is load-bearing. It sits in `setup`'s
// parameter, which is contravariant, so the constraint has to accept a module that requires
// anything and a module that requires nothing at once. `unknown` and `never` each reject one of
// those, and a service array narrows `setup` to a context no real module can be called with.
// A wildcard in a constraint is read by the compiler and never by the code, so nothing here is
// unsound: `createAgent` recovers each module's real types from the tuple it was given.
// eslint-disable-next-line typescript/no-explicit-any
export type AnyModule = Module<string, never, any, unknown>

export const defineModule = <
  const Id extends string,
  Services = never,
  const Requires extends readonly AnyService[] = readonly [],
  R = never
>(module: Module<Id, Services, Requires, R>): Module<Id, Services, Requires, R> => module

type ModuleId<One> = One extends Module<infer Id, infer _Services, infer _Requires, infer _R>
  ? Id
  : never

type ProvidedServices<One> = One extends Module<infer _Id, infer Services, infer _Requires, infer _R>
  ? Services
  : never

type RequiredModuleServices<One> = One extends Module<infer _Id, infer _Services, infer Requires, infer _R>
  ? RequiredServices<Requires>
  : never

type MissingDependencies<Modules extends readonly unknown[]> = Exclude<
  RequiredModuleServices<Modules[number]>,
  ProvidedServices<Modules[number]>
>

type DuplicateServiceProviders<
  Modules extends readonly unknown[],
  Seen = never
> = Modules extends readonly [infer Head, ...infer Tail]
  ? | Extract<ProvidedServices<Head>, Seen>
    | DuplicateServiceProviders<Tail, Seen | ProvidedServices<Head>>
  : never

type ServiceKey<Service> = Service extends { readonly key: infer Key extends string }
  ? Key
  : Service

type DuplicateModuleIds<
  Modules extends readonly unknown[],
  Seen extends string = never
> = Modules extends readonly [infer Head, ...infer Tail]
  ? ModuleId<Head> extends Seen
    ? ModuleId<Head>
    : DuplicateModuleIds<Tail, Seen | ModuleId<Head>>
  : never

type ModuleServices<One> = One extends Module<infer _Id, infer _Services, infer _Requires, infer R>
  ? R
  : never

type AgentModuleServices<Modules extends readonly unknown[]> = ProvidedServices<Modules[number]>

type ValidModules<Modules extends readonly unknown[]> =
  [MissingDependencies<Modules>] extends [never]
    ? [DuplicateModuleIds<Modules>] extends [never]
      ? [DuplicateServiceProviders<Modules>] extends [never]
        ? unknown
        : {
            readonly duplicateModuleServices: ServiceKey<DuplicateServiceProviders<Modules>>
          }
      : { readonly duplicateModuleIds: DuplicateModuleIds<Modules> }
    : { readonly missingModuleDependencies: ServiceKey<MissingDependencies<Modules>> }

// Where a cross-session message came from: the sending session, and, when the send happened while
// serving a turn, the turn and the tool call that asked. It is the one carried provenance fact.
// Everything else about a swarm, the delegation tree, ancestry, blast radius, is derived by
// walking logs through these fields.
export interface MessageOrigin {
  readonly session: string
  readonly turn?: string
  readonly call?: string
}

export interface InboundMessage {
  readonly id: string
  readonly text: string
  // The turn's declared output schema, as the JSON Schema the log carries. A caller declaring a
  // `Schema` lowers it with `jsonSchemaOf`, and a message arriving from another session already
  // holds the lowered form, so one field means one thing wherever it comes from.
  readonly output?: unknown
  readonly budget?: number
  readonly escalatable?: boolean
  readonly replyTo?: string
  readonly origin?: MessageOrigin
  // A reply from another session states how that session's turn ended and what it spent. Both
  // ride the message so the receiver attributes and costs the exchange from its own log alone.
  readonly outcome?: "completed" | "failed"
  readonly usage?: Usage
}

export type TurnOutcome = CallResult | { readonly kind: "open" }

export type TurnResult = TurnOutcome & {
  readonly turn: string
  readonly usage: Spend
}

export interface BranchOptions {
  readonly at?: number
  readonly id?: string
}

export interface Agent<R = never, Services = never> {
  readonly definition: AgentDefinition<R, Services>
  readonly services: Context.Context<Services>
  readonly turn: (message: InboundMessage) => Effect.Effect<TurnResult, never, R | AgentServices>
  readonly log: Effect.Effect<ReadonlyArray<Event>, never, EventLog>
  readonly replay: (
    recorded: ReadonlyArray<Event>
  ) => Effect.Effect<TurnResult, never, R | AgentServices>
  readonly request: (log: ReadonlyArray<Event>) => ModelRequest
  readonly branch: (recorded: ReadonlyArray<Event>, options?: BranchOptions) => Agent<R, Services>
  readonly fork: (
    options?: BranchOptions
  ) => Effect.Effect<Agent<R, Services>, never, EventLog | Self>
}

export interface AgentOptions<Modules extends readonly AnyModule[]> {
  readonly id?: string
  readonly modules: Modules
}

export const undeclaredEvents = (
  definition: Pick<AgentDefinition<never>, "events">,
  log: ReadonlyArray<Event>
): ReadonlyArray<string> =>
  [...new Set(log.map((event) => event.type))]
    .filter((type) => !definition.events.includes(type))
    .sort()

export const privateLog = (seed: ReadonlyArray<Event>): EventLogStore => {
  const rows: Array<Event> = []
  const keys = new Set<string>()
  const put = (events: ReadonlyArray<Event>) => {
    for (const event of events) {
      const key = keyOf(event)
      if (key !== undefined && keys.has(key)) continue
      if (key !== undefined) keys.add(key)
      rows.push(event)
    }
  }
  put(seed)
  return {
    append: (events) => Effect.sync(() => put(events)),
    read: Effect.sync((): ReadonlyArray<Event> => [...rows]),
    readFrom: (from) => Effect.sync((): ReadonlyArray<Event> => rows.slice(from)),
    head: Effect.sync(() => rows.length)
  }
}

const headOf = (message: InboundMessage, definition: Pick<AgentDefinition<never>, "id">, at: number): Event => ({
  type: "MessageReceived",
  id: message.id,
  text: message.text,
  agent: definition.id,
  ...(message.output === undefined ? {} : { output: message.output }),
  ...(message.budget === undefined ? {} : { budget: message.budget }),
  ...(message.escalatable === undefined ? {} : { escalatable: message.escalatable }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  ...(message.origin === undefined ? {} : { origin: message.origin }),
  ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
  ...(message.usage === undefined ? {} : { usage: message.usage }),
  at
})

const resultOf = (log: ReadonlyArray<Event>, turn: string): TurnResult => ({
  ...(boundaryOf(log, turn) ?? { kind: "open" }),
  turn,
  usage: usageIn(log, turn)
})

const lastTurnOf = (log: ReadonlyArray<Event>): string => {
  const open = turnHead(log)
  if (open !== undefined) return String(open.id ?? "")
  const heads = log.filter((event) => event.type === "MessageReceived")
  return String(heads[heads.length - 1]?.id ?? "")
}

interface BoundSession {
  readonly id: string
  readonly store: EventLogStore
}

const build = <R, Services>(
  definition: AgentDefinition<R, Services>,
  bound?: BoundSession
): Agent<R, Services> => {
  const machines = actor<R>(definition.machines)
  const scoped = <A>(effect: Effect.Effect<A, never, R | AgentServices>) =>
    bound === undefined
      ? effect
      : effect.pipe(
          Effect.provideService(EventLog, bound.store),
          Effect.provideService(Self, bound.id)
        )
  const held = <A>(work: Effect.Effect<A, never, R | AgentServices>) =>
    Effect.gen(function* () {
      const writer = yield* Writer
      return yield* writer.hold(yield* Self, work)
    })
  const settleDue = (turn: string) =>
    Effect.gen(function* () {
      const store = yield* EventLog
      while (true) {
        yield* settleAll(machines.machines)
        const log = yield* store.read
        const pending = pendingDeferral(log)
        if (pending === undefined || pending.turn !== turn) return resultOf(log, turn)
        const now = yield* Clock.currentTimeMillis
        if (now < pending.notBefore) {
          const alarm = yield* Effect.serviceOption(Alarm)
          if (Option.isSome(alarm)) {
            yield* alarm.value.set(
              yield* Self,
              pending.notBefore,
              alarmFired({ turn: pending.turn, callId: pending.callId, at: now })
            )
          }
          return resultOf(log, turn)
        }
        yield* store.append([
          alarmFired({ turn: pending.turn, callId: pending.callId, at: now })
        ])
      }
    })
  const branch = (recorded: ReadonlyArray<Event>, options: BranchOptions = {}) => {
    const upTo = Math.max(0, Math.min(options.at ?? recorded.length, recorded.length))
    const seed = recorded.slice(0, upTo)
    return build(definition, {
      id: options.id ?? `branch:${definition.id}:${upTo}`,
      store: privateLog(seed)
    })
  }
  return {
    definition,
    services: definition.services,
    turn: (message) =>
      scoped(
        held(
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            yield* send(machines, headOf(message, definition, at))
            return yield* settleDue(message.id)
          })
        )
      ),
    log:
      bound === undefined
        ? Effect.flatMap(EventLog, (store) => store.read)
        : bound.store.read,
    replay: (recorded) =>
      scoped(
        held(
          Effect.gen(function* () {
            const store = yield* EventLog
            yield* store.append(recorded)
            const log = yield* store.read
            return yield* settleDue(lastTurnOf(log))
          })
        )
      ),
    request: (log) => modelRequest(definition, log),
    branch,
    fork: (options = {}) => {
      if (bound !== undefined) {
        return Effect.map(bound.store.read, (recorded) =>
          branch(recorded, {
            ...options,
            id: options.id ?? `${bound.id}:fork:${options.at ?? recorded.length}`
          })
        )
      }
      return Effect.gen(function* () {
        const store = yield* EventLog
        const recorded = yield* store.read
        const session = yield* Self
        return branch(recorded, {
          ...options,
          id: options.id ?? `${session}:fork:${options.at ?? recorded.length}`
        })
      })
    }
  }
}

// Where a function sits inside an identity value, as a path, or undefined when it is all data.
const functionIn = (value: unknown, path = ""): string | undefined => {
  if (typeof value === "function") return path === "" ? "" : ` ${path}`
  if (value === null || typeof value !== "object") return undefined
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    const found = functionIn(held, path === "" ? key : `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

const compile = <R, Services>(
  modules: ReadonlyArray<AnyModule>,
  options: { readonly id?: string }
): AgentDefinition<R, Services> => {
  const ids = new Set<string>()
  const serviceKeys = new Set<string>()
  let services: Context.Context<never> = Context.empty()
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`duplicate module id "${module.id}"`)
    ids.add(module.id)
    for (const key of module.services?.mapUnsafe.keys() ?? []) {
      if (serviceKeys.has(key)) {
        throw new Error(`service "${key}" is provided by more than one module`)
      }
      serviceKeys.add(key)
    }
    if (module.services !== undefined) {
      services = Context.merge(services, module.services) as Context.Context<never>
    }
  }

  const parts = modules.map((module) => {
    for (const required of module.requires ?? []) {
      if (!serviceKeys.has(required.key)) {
        throw new Error(`module "${module.id}" requires missing service "${required.key}"`)
      }
    }
    const context = services.pipe(Context.pick(...(module.requires ?? [])))
    return module.setup(context as unknown as Context.Context<unknown>)
  })

  const toolNames = new Set<string>()
  const instructionIds = new Set<string>()
  const nudgeIds = new Set<string>()
  for (const part of parts) {
    for (const tool of part.nativeTools ?? []) {
      if (toolNames.has(tool.name)) throw new Error(`duplicate native tool name "${tool.name}"`)
      toolNames.add(tool.name)
    }
    for (const instruction of part.instructions ?? []) {
      if (instructionIds.has(instruction.id)) {
        throw new Error(`duplicate instruction id "${instruction.id}"`)
      }
      instructionIds.add(instruction.id)
    }
    for (const nudge of part.nudges ?? []) {
      if (nudgeIds.has(nudge.id)) throw new Error(`duplicate nudge id "${nudge.id}"`)
      nudgeIds.add(nudge.id)
    }
  }

  const renderKeys = ["messageTruncateAt", "resultTruncateAt"] as const
  for (const key of renderKeys) {
    const values = parts.flatMap((part) => {
      const value = part.render?.[key]
      return value === undefined ? [] : [value]
    })
    if (values.length > 1) throw new Error(`more than one module sets render.${key}`)
    const value = values[0]
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`render.${key} must be a nonnegative integer`)
    }
  }

  const render = parts.reduce<RenderPlan>(
    (plan, part) => ({
      ...plan,
      ...part.render,
      instructions: [...plan.instructions, ...(part.instructions ?? [])],
      nativeTools: [...plan.nativeTools, ...(part.nativeTools ?? [])],
      nudges: [...plan.nudges, ...(part.nudges ?? [])]
    }),
    // The plan starts with no truncation bound. A module that wants one contributes it, and a
    // render with none sends what the log holds.
    {
      instructions: [],
      nativeTools: [],
      nudges: []
    } satisfies RenderPlan
  )
  const requestOptions = serviceKeys.has(RequestOptionsProjection.key)
    ? Context.get(services as Context.Context<RequestOptionsProjection>, RequestOptionsProjection)
    : undefined
  const planned: RenderPlan =
    requestOptions === undefined ? render : { ...render, requestOptions }
  // Identity is hashed into the agent id, and the hash serializes a function as the constant
  // "[function]". Two modules whose behavior differs only inside a function would then share an
  // id. The value has to be data for the hash to identify a program reliably.
  for (const module of modules) {
    const carried = functionIn(module.identity)
    if (carried !== undefined) {
      throw new Error(
        `module "${module.id}" carries a function at identity${carried} and identity is hashed, so it must be data`
      )
    }
  }

  const manifests: ReadonlyArray<ModuleManifest> = modules.map((module) => ({
    id: module.id,
    version: module.version ?? "1",
    ...(module.identity === undefined ? {} : { identity: module.identity })
  }))
  const machines = parts.flatMap((part) =>
    typeof part.machines === "function" ? part.machines(planned) : (part.machines ?? [])
  )
  const machineIds = new Set<string>()
  for (const machine of machines) {
    if (machineIds.has(machine.id)) throw new Error(`duplicate machine id "${machine.id}"`)
    machineIds.add(machine.id)
  }

  const declared = new Set(parts.flatMap((part) => part.events ?? []))

  // A transition on an event no module declares waits forever. `machine()` checks that a target
  // names a declared state, and this is the same check on the other axis of the transition table:
  // the event names are only meaningful against the alphabet the tuple composes, so the check
  // belongs here, where the tuple is known, rather than in core, which knows no alphabet.
  //
  // The rule is one-directional on purpose. Transitioning on an undeclared event is a typo or a
  // missing module. Declaring an event nothing transitions on is ordinary: a module records facts
  // for a projection or for a reader, and no machine has to care.
  for (const machine of machines) {
    for (const [state, definition] of Object.entries(machine.states)) {
      for (const type of Object.keys(definition.on ?? {})) {
        if (!declared.has(type)) {
          throw new Error(
            `machine "${machine.id}" transitions on "${type}" in state "${state}", which no module declares`
          )
        }
      }
    }
  }

  // A withdrawal that names no tool is a typo that reads as working: the nudge fires, the surface
  // is unchanged, and the tool it meant to take away stays in front of the model. Nudges that
  // compute their tools from the log are exempt, since their names are only known at render time.
  const offered = new Set(planned.nativeTools.map((tool) => tool.name))
  for (const nudge of planned.nudges) {
    for (const name of nudge.withdrawsNativeTools ?? []) {
      if (name !== WITHDRAW_ALL && !offered.has(name)) {
        throw new Error(`nudge "${nudge.id}" withdraws "${name}", which no module offers`)
      }
    }
  }
  return {
    id: options.id ?? agentId(manifests),
    modules: manifests,
    events: [...new Set(parts.flatMap((part) => part.events ?? []))].sort(),
    machines: machines as ReadonlyArray<Machine<R, never>>,
    render: planned,
    services: services as unknown as Context.Context<Services>
  }
}

export const createAgent = <
  const Modules extends readonly AnyModule[]
>(
  options: AgentOptions<Modules> & ValidModules<Modules>
): Agent<ModuleServices<Modules[number]>, AgentModuleServices<Modules>> => {
  const modules = options.modules as ReadonlyArray<AnyModule>
  const definition = compile<
    ModuleServices<Modules[number]>,
    AgentModuleServices<Modules>
  >(modules, options)
  return build(definition)
}
