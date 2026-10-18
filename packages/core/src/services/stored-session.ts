import { Schema } from "effect"
import { decodeReference, encodeReference, type Json } from "@tardie/grove"
import type { SyncStore } from "@tardie/grove/sqlite"
import { resolveInput, type DocumentSession } from "./tree-state"

// storedSession adapts stored document references to projection lifetimes (platform/test/bun/stored-journal.test.ts).
export function storedSession(store: SyncStore): DocumentSession {
  const bind: DocumentSession["bind"] = <State extends Json>(schema: Schema.Decoder<State>) => {
    const binding = store.bind<State>(schema)
    return { initial: binding.initial, check: binding.check, open: encoded => binding.open(decodeReference(encoded)) }
  }

  const readReference: DocumentSession["readReference"] = reference => store.view(decodeReference(reference), Schema.Json).materialize()
  return {
    bind, capture: value => encodeReference(store.capture(value)), stats: store.stats,
    bytes: encoded => store.bytes(decodeReference(encoded)),
    read: encoded => store.readValue(decodeReference(encoded)),
    readReference,
    resolve: request => resolveInput(request, readReference),
    hold: (holder, name, reference) => store.hold(holder, name, decodeReference(reference)),
    release: store.release,
  }
}
