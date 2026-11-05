import type { AtomCheckpointIdentity, ReadAtomCheckpoint } from "./checkpoint/atom"
import type { ReadonlyIndex, ReadonlyLog } from "../runtime/log-view"
import { Context, Schema, type Effect } from "effect"
import { Atom as NativeAtom } from "effect/reactivity"
import { atom, type Atom } from "../atoms/atom"
import type { ObservedRecord, Recorded, JournalQuery, JournalQueryResult } from "./journal"
import { EffectDied, type EffectRef } from "../runtime/effects"
import type { AtomState, StatefulAtom, StateSeed } from "../initialise"
import type { AcceptedOperation } from "../runtime/operation"
import type { PromiseSettled } from "../runtime/events"
import type { EffectCheckpoint } from "../runtime/replay"
import type { FamilyRecord, JournalFamily } from "./journal/family"

export type AtomCheckpointCodec = StatefulAtom[typeof AtomState] & {
  readonly identity: AtomCheckpointIdentity
  readonly owner: object
}

export interface AtomCheckpointCandidate {
  readonly codec: AtomCheckpointCodec
  readonly position: number
  readonly value: unknown
}

// AtomReplay supplies missing observations up to a fixed consumed position (platform/test/properties/checkpoint/safety.ts).
export interface AtomReplay {
  readonly position: number
  readonly seed: StateSeed | undefined
  // originSeed caches the initial journal marker, including its absence, independently of a checkpoint seed.
  readonly originSeed?: { readonly value: StateSeed | undefined }
  // states carries atom values and cursors by codec identity across registry forks (platform/test/properties/runtime/snapshot-lookups.ts).
  readonly states?: ReadonlyMap<StatefulAtom[typeof AtomState], { readonly position: number; readonly value: unknown }>
  readonly read: (from: number) => ReadonlyLog<ObservedRecord<unknown>>
  readonly readFamily?: (family: JournalFamily, key: string, from: number, options?: { readonly to?: number; readonly order?: "asc" | "desc" }) => Iterable<FamilyRecord<ObservedRecord<unknown>>>
  readonly captureAtomCheckpoint?: (checkpoint: AtomCheckpointCandidate) => void
  readonly readAtomCheckpoint?: ReadAtomCheckpoint
  readonly familyKeys?: (family: JournalFamily, after: string | undefined, limit: number) => readonly string[]
}

// EventLogSnapshot reads a fixed journal prefix (packages/platform/test/scenarios/log/lifecycle.ts).
export interface EventLogSnapshot {
  readonly position: number
  readonly read: (from: number, to: number) => readonly ObservedRecord<unknown>[]
}

export class EventLog extends Context.Service<EventLog, {
  readonly query?: (request: JournalQuery) => Effect.Effect<JournalQueryResult, Error>
  readonly snapshot: () => EventLogSnapshot
  readonly schemas?: () => readonly Schema.Top[]
  readonly replay: Atom<AtomReplay>
  // events extends an immutable prefix; another history requires another source atom.
  readonly events: Atom<ReadonlyLog<unknown>>
  readonly records?: Atom<ReadonlyLog<ObservedRecord<unknown>>>
  readonly bindings?: Atom<ReadonlyIndex<object, EffectRef>>
  readonly effect?: (ref: EffectRef) => AcceptedOperation | undefined
  readonly operations?: () => Iterable<AcceptedOperation>
  readonly defect?: () => EffectDied | undefined
  readonly promise?: (ref: EffectRef) => PromiseSettled | undefined
}>()("experimental/EventLog") {}

// eventLogService binds atom projections and history reads to the same replay source.
export function eventLogService(projections: Omit<typeof EventLog.Service, "snapshot">, get: <Value>(node: Atom<Value>) => Value): typeof EventLog.Service {
  return { ...projections, snapshot: () => {
    const replay = get(projections.replay)
    return {
      position: replay.position,
      read: (from, to) => {
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > replay.position) throw new Error("Event log range is outside its snapshot")
        return replay.read(from).slice(0, to - from)
      },
    }
  } }
}

// ReplayContext supplies committed history during actor setup; runtime/execution.ts caches readFull for the loading attempt.
export class ReplayContext extends Context.Service<ReplayContext, {
  readonly records: ReadonlyLog<Recorded<unknown>>
  readonly checkpoint?: EffectCheckpoint
  readonly readFull: Effect.Effect<readonly Recorded<unknown>[], Error>
}>()("experimental/ReplayContext") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))

// executionDefect observes the terminal journal defect for caller delivery (quint/checkpoint/effectRecovery.qnt, blockedIsDurable).
export const executionDefect = atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new Error("Missing EventLog service")
  const service = Context.get(context, EventLog)
  const events = get(service.events)
  return service.defect ? service.defect() : events.find(Schema.is(EffectDied))
})
