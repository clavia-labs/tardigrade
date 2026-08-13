import { Clock, Effect } from "effect"
import {
  EventLog,
  Router,
  Self,
  Wake,
  Writer,
  actor,
  send,
  settleAll,
  type Envelope,
  type EventLogStore,
  type Machine
} from "@flamecast/core"
import { boundaryOf, type CallResult } from "./boundary"
import { type ModelRequest, type NativeToolSpec, type Usage } from "./infer"
import { keyOf } from "./keys"
import { modelRequest } from "./render"
import {
  programId,
  resolve,
  type AgentProgram,
  type Instruction,
  type ModuleManifest,
  type Nudge,
  type RenderPlan
} from "./program"
import type { AnyToken, Binding, ModuleContext, Token, ValueOf } from "./dependency"
import { turnHead, usageIn } from "./turns"

export type AgentServices = EventLog | Writer | Wake | Router | Self

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

export interface Module<
  Id extends string = string,
  Provides extends readonly Binding<AnyToken>[] = readonly [],
  Requires extends readonly AnyToken[] = readonly [],
  R = never
> {
  readonly id: Id
  readonly version?: string
  readonly fingerprint?: unknown
  readonly provides?: Provides
  readonly requires?: Requires
  readonly setup: (context: ModuleContext<Requires>) => ModulePart<R>
}

export type AnyModule = Module<string, any, any, any>

export const defineModule = <
  const Id extends string,
  const Provides extends readonly Binding<AnyToken>[] = readonly [],
  const Requires extends readonly AnyToken[] = readonly [],
  R = never
>(module: Module<Id, Provides, Requires, R>): Module<Id, Provides, Requires, R> => module

type ModuleId<One> = One extends Module<infer Id, any, any, any>
  ? Id
  : never

type ProvidedToken<One> = One extends Module<string, infer Provides, any, any>
  ? Provides[number]["token"]
  : never

type RequiredToken<One> = One extends Module<string, any, infer Requires, any>
  ? Requires[number]
  : never

type TokenId<One> = One extends Token<infer Id, unknown> ? Id : never

type MissingDependencies<Modules extends readonly unknown[]> = Exclude<
  TokenId<RequiredToken<Modules[number]>>,
  TokenId<ProvidedToken<Modules[number]>>
>

type DuplicateModuleIds<
  Modules extends readonly unknown[],
  Seen extends string = never
> = Modules extends readonly [infer Head, ...infer Tail]
  ? ModuleId<Head> extends Seen
    ? ModuleId<Head>
    : DuplicateModuleIds<Tail, Seen | ModuleId<Head>>
  : never

type ModuleServices<One> = One extends Module<string, any, any, infer R>
  ? R
  : never

type ValidModules<Modules extends readonly unknown[]> =
  [MissingDependencies<Modules>] extends [never]
    ? [DuplicateModuleIds<Modules>] extends [never]
      ? unknown
      : { readonly duplicateModuleIds: DuplicateModuleIds<Modules> }
    : { readonly missingModuleDependencies: MissingDependencies<Modules> }

export interface InboundMessage {
  readonly id: string
  readonly text: string
  readonly output?: unknown
  readonly budget?: number
  readonly escalatable?: boolean
  readonly replyTo?: string
}

export type TurnOutcome = CallResult | { readonly kind: "open" }

export type TurnResult = TurnOutcome & {
  readonly turn: string
  readonly usage: Usage
}

export interface BranchOptions {
  readonly at?: number
  readonly id?: string
}

export interface Agent<R = never> {
  readonly program: AgentProgram<R>
  readonly turn: (message: InboundMessage) => Effect.Effect<TurnResult, never, R | AgentServices>
  readonly log: Effect.Effect<ReadonlyArray<Envelope>, never, EventLog>
  readonly replay: (
    recorded: ReadonlyArray<Envelope>
  ) => Effect.Effect<TurnResult, never, R | AgentServices>
  readonly request: (log: ReadonlyArray<Envelope>) => ModelRequest
  readonly resolve: <T extends AnyToken>(token: T, log: ReadonlyArray<Envelope>) => ValueOf<T>
  readonly branch: (recorded: ReadonlyArray<Envelope>, options?: BranchOptions) => Agent<R>
  readonly fork: (
    options?: BranchOptions
  ) => Effect.Effect<Agent<R>, never, EventLog | Self>
}

export interface AgentOptions<Modules extends readonly AnyModule[]> {
  readonly id?: string
  readonly parent?: string
  readonly modules: Modules
}

export const undeclaredEvents = (
  program: Pick<AgentProgram<never>, "events">,
  log: ReadonlyArray<Envelope>
): ReadonlyArray<string> =>
  [...new Set(log.map((event) => event.type))]
    .filter((type) => !program.events.includes(type))
    .sort()

const privateLog = (seed: ReadonlyArray<Envelope>): EventLogStore => {
  const rows: Array<Envelope> = []
  const keys = new Set<string>()
  const put = (events: ReadonlyArray<Envelope>) => {
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
    read: Effect.sync((): ReadonlyArray<Envelope> => [...rows]),
    readFrom: (from) => Effect.sync((): ReadonlyArray<Envelope> => rows.slice(from)),
    head: Effect.sync(() => rows.length)
  }
}

const headOf = (message: InboundMessage, program: AgentProgram<unknown>, at: number): Envelope => ({
  type: "MessageReceived",
  id: message.id,
  text: message.text,
  program: program.id,
  ...(message.output === undefined ? {} : { output: message.output }),
  ...(message.budget === undefined ? {} : { budget: message.budget }),
  ...(message.escalatable === undefined ? {} : { escalatable: message.escalatable }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  at
})

const resultOf = (log: ReadonlyArray<Envelope>, turn: string): TurnResult => ({
  ...(boundaryOf(log, turn) ?? { kind: "open" }),
  turn,
  usage: usageIn(log, turn)
})

const lastTurnOf = (log: ReadonlyArray<Envelope>): string => {
  const open = turnHead(log)
  if (open !== undefined) return String(open.id ?? "")
  const heads = log.filter((event) => event.type === "MessageReceived")
  return String(heads[heads.length - 1]?.id ?? "")
}

interface BoundSession {
  readonly id: string
  readonly store: EventLogStore
}

const build = <R>(
  program: AgentProgram<R>,
  bound?: BoundSession
): Agent<R> => {
  const machines = actor<R>(program.machines)
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
  const branch = (recorded: ReadonlyArray<Envelope>, options: BranchOptions = {}) => {
    const upTo = Math.max(0, Math.min(options.at ?? recorded.length, recorded.length))
    const seed = recorded.slice(0, upTo)
    return build(program, {
      id: options.id ?? `branch:${program.id}:${upTo}`,
      store: privateLog(seed)
    })
  }
  return {
    program,
    turn: (message) =>
      scoped(
        held(
          Effect.gen(function* () {
            const store = yield* EventLog
            const at = yield* Clock.currentTimeMillis
            yield* send(machines, headOf(message, program, at))
            return resultOf(yield* store.read, message.id)
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
            yield* settleAll(machines.machines)
            const log = yield* store.read
            return resultOf(log, lastTurnOf(log))
          })
        )
      ),
    request: (log) => modelRequest(program, log),
    resolve: (token, log) => resolve(program, token, log),
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

const compile = <R>(
  modules: ReadonlyArray<AnyModule>,
  options: { readonly id?: string; readonly parent?: string }
): AgentProgram<R> => {
  const ids = new Set<string>()
  const bindings = new Map<string, Binding<AnyToken>>()
  for (const module of modules) {
    if (ids.has(module.id)) throw new Error(`duplicate module id "${module.id}"`)
    ids.add(module.id)
    for (const provided of module.provides ?? []) {
      if (bindings.has(provided.token.id)) {
        throw new Error(`token "${provided.token.id}" is provided by more than one module`)
      }
      bindings.set(provided.token.id, provided)
    }
  }

  const parts = modules.map((module) => {
    for (const required of module.requires ?? []) {
      if (!bindings.has(required.id)) {
        throw new Error(`module "${module.id}" requires missing token "${required.id}"`)
      }
    }
    const context = {
      resolve: (token: AnyToken, log: ReadonlyArray<Envelope>) => {
        const found = bindings.get(token.id)
        if (found === undefined) throw new Error(`no module provides token "${token.id}"`)
        return found.project(log)
      }
    }
    return module.setup(context as ModuleContext<any>)
  })

  const toolNames = new Set<string>()
  const instructionIds = new Set<string>()
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
  }

  const render = parts.reduce<RenderPlan>(
    (plan, part) => ({
      ...plan,
      ...part.render,
      instructions: [...plan.instructions, ...(part.instructions ?? [])],
      nativeTools: [...plan.nativeTools, ...(part.nativeTools ?? [])],
      nudges: [...plan.nudges, ...(part.nudges ?? [])]
    }),
    {
      instructions: [],
      nativeTools: [],
      nudges: [],
      messageTruncateAt: 12_000,
      resultTruncateAt: 6_000
    } satisfies RenderPlan
  )
  const manifests: ReadonlyArray<ModuleManifest> = modules.map((module) => ({
    id: module.id,
    version: module.version ?? "1",
    ...(module.fingerprint === undefined ? {} : { fingerprint: module.fingerprint })
  }))
  const machines = parts.flatMap((part) =>
    typeof part.machines === "function" ? part.machines(render) : (part.machines ?? [])
  )
  const machineIds = new Set<string>()
  for (const machine of machines) {
    if (machineIds.has(machine.id)) throw new Error(`duplicate machine id "${machine.id}"`)
    machineIds.add(machine.id)
  }
  return {
    id: options.id ?? programId(manifests),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    modules: manifests,
    events: [...new Set(parts.flatMap((part) => part.events ?? []))].sort(),
    machines: machines as ReadonlyArray<Machine<R, never>>,
    render,
    bindings: [...bindings.values()]
  }
}

export const createAgent = <
  const Modules extends readonly AnyModule[]
>(
  options: AgentOptions<Modules> & ValidModules<Modules>
): Agent<ModuleServices<Modules[number]>> => {
  const modules = options.modules as ReadonlyArray<AnyModule>
  const program = compile<ModuleServices<Modules[number]>>(modules, options)
  return build(program)
}
