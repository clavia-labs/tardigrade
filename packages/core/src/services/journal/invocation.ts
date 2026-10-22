import { Schema } from "effect"
import { CoreEvent, EffectRequested, InvocationIdentity } from "../../runtime/events"
import { EffectRef, RuntimeError, effectKey } from "../../runtime/effects"
import { cleanupSucceeded, settlementCompletesExecution } from "../../runtime/operation"
import type { Journal, InvocationLookup, Recorded } from "../journal"

// selectInvocationRecords binds in-memory journals to invocation lookup through accepted references (quint/checkpoint/acceptanceBinding.qnt, admissionSound).
export function selectInvocationRecords<Event>(history: Iterable<Recorded<Event>>, identity: InvocationIdentity): readonly Recorded<Event>[] {
  const records = [...history]
  const refs = new Set(records.flatMap(({ event }) => Schema.is(EffectRequested)(event) && event.ref.atom === identity.atom && event.ref.act === identity.act && event.origin === identity.origin ? [effectKey(event.ref)] : []))
  return records.filter(({ event }) => Schema.is(CoreEvent)(event) && "ref" in event && refs.has(effectKey(event.ref)))
}

// createInvocationLookup derives admission state from an invocation's committed records (quint/checkpoint/acceptanceBinding.qnt, admissionSound). Readers include acceptance and subsequent lifecycle records from the full journal.
export function createInvocationLookup(read: (identity: InvocationIdentity) => readonly Recorded<object>[]): Journal<object>["lookupInvocation"] {
  return identity => {
    const invocation = Schema.decodeSync(InvocationIdentity)(identity)
    const records = read(invocation)
    let ref: EffectRef | undefined
    let settled = false
    let cancelled = false
    let cleaned = false
    for (const record of records) {
      const event = Schema.decodeUnknownSync(Schema.toType(CoreEvent))(record.event)
      if (Schema.is(EffectRequested)(event)) {
        if (ref || event.ref.atom !== invocation.atom || event.ref.act !== invocation.act || event.origin !== invocation.origin) throw new RuntimeError("Invocation index differs from its acceptance")
        ref = event.ref
      } else {
        if (!ref || !("ref" in event) || effectKey(event.ref) !== effectKey(ref)) throw new RuntimeError("Invocation lifecycle differs from its acceptance")
        if (event.type === "EffectCancelled") cancelled = true
        else if (event.type === "CancellationSettled" && cleanupSucceeded(event)) cleaned = true
        else if (event.type === "PromiseSettled" || event.type === "EffectDied") settled = true
        else if (event.type === "EffectSettled" && settlementCompletesExecution(event)) settled = true
      }
    }
    return ref ? { status: (cancelled ? cleaned : settled) ? "settled" : "pending", ref } satisfies InvocationLookup : { status: "absent" }
  }
}
