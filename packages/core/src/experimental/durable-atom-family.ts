import { Context, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { makeDurableAtom, type DurableAtom, type DurableAtomOptions } from "../atoms/durable"
import { observeRecord } from "../runtime/event-source"
import { recordEvent } from "../runtime/record"
import { collectFamilyKeys, type FamilyKeyPage, type JournalFamily } from "../services/journal/family"
import { EventLog, eventLogContext } from "../services/event-log"
import type { Atom } from "../atoms/atom"

export const DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL = 0
export const DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION = "1"
export const DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE = 100

export interface FamilyPageOptions {
  readonly after?: string
  readonly limit?: number
}

export interface DurableAtomFamilyOptions<State, Event> extends DurableAtomOptions<State, Event> {
  readonly key: (event: NoInfer<Event>) => string | undefined
  readonly idleTTL?: number
  readonly indexVersion?: string
}

export interface DurableAtomFamily<State, Event> {
  (key: string): DurableAtom<State, Event>
  readonly name: string
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<State>
  readonly key: (event: Event) => string | undefined
  readonly idleTTL: number
  readonly indexVersion: string
  readonly keys: (options?: FamilyPageOptions) => Atom<FamilyKeyPage>
}

// durableAtomFamily constructs memoized string-keyed durable atoms with configurable idle retention and journal indexing. An undefined event key skips the event.
export function durableAtomFamily<State, Event>(options: DurableAtomFamilyOptions<State, Event>): DurableAtomFamily<State, Event> {
  const { name, input, schema, key, reduce } = options
  if (!name.trim()) throw new Error("Durable atom family name must not be empty")
  const idleTTL = options.idleTTL ?? DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL
  const indexVersion = options.indexVersion ?? DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION
  if (!indexVersion.trim()) throw new Error("Durable atom family indexVersion must not be empty")
  if (!(idleTTL >= 0) || (idleTTL !== Infinity && !Number.isFinite(idleTTL))) throw new Error("Durable atom family idleTTL must be nonnegative milliseconds or Infinity")
  const initial = structuredClone(options.initial)
  Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })(initial)
  const accepts = Schema.is(input)
  const family: JournalFamily = { name, indexVersion, key: record => {
    const event = recordEvent(observeRecord(record))
    if (!accepts(event)) return undefined
    const eventKey = key(event)
    if (eventKey !== undefined && typeof eventKey !== "string") throw new Error("Durable atom family event keys must be strings or undefined")
    return eventKey
  } }
  const member = NativeAtom.family((memberKey: string): DurableAtom<State, Event> => {
    if (typeof memberKey !== "string") throw new Error("Durable atom family keys must be strings")
    return makeDurableAtom({
      name: JSON.stringify([name, indexVersion, memberKey]),
      input, schema, initial,
      reduce: (state, event, metadata, position) => {
        const eventKey = key(event)
        if (eventKey !== undefined && typeof eventKey !== "string") throw new Error("Durable atom family event keys must be strings or undefined")
        return eventKey === memberKey ? reduce(state, event, metadata, position) : state
      },
    }, idleTTL, { family, key: memberKey })
  })
  const pages = NativeAtom.family((identity: string): Atom<FamilyKeyPage> => {
    const [after, limit] = JSON.parse(identity) as [string | null, number]
    return Object.assign(NativeAtom.readable(get => {
      const context = get(eventLogContext)
      if (!context) throw new Error("Missing EventLog service")
      const replay = get(Context.get(context, EventLog).replay)
      const keys = replay.familyKeys
        ? replay.familyKeys(family, after ?? undefined, limit + 1)
        : collectFamilyKeys((function* () {
          let position = 0
          for (const record of replay.read(0)) yield family.key(record, position++)
        })(), after ?? undefined, limit + 1)
      return { keys: keys.slice(0, limit), ...(keys.length > limit ? { next: keys[limit - 1]! } : {}) }
    }).pipe(NativeAtom.setIdleTTL(idleTTL)), { input })
  })
  const keys = (options: FamilyPageOptions = {}) => {
    const limit = options.limit ?? DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) throw new Error("Family page limit must be a positive safe integer with room for lookahead")
    return pages(JSON.stringify([options.after ?? null, limit]))
  }
  Object.defineProperty(member, "name", { value: name })
  return Object.assign(member, { input, schema, key, idleTTL, indexVersion, keys })
}
