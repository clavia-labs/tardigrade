import { dedupKey, type DedupKey, type Envelope } from "@flamecast/core"

// The dedup key policy for this alphabet. A runtime takes it and its unique index absorbs a
// redelivered event, which is guarantee 5 of the log port.
//
// The policy lives here because the harness owns the alphabet: a store that held this table would
// have to know `ToolReturned` and `RunFired`, and a store knows no domain. Bind a runtime with
// `MemoryRuntime({ keyOf })` and hand the same function to the conformance kit, so the kit reads
// the log the way the store does.
//
// An event type absent from the table has no key and always lands. That is deliberate for a mark:
// the repetition of `ModelCalled` is the evidence that an attempt died, so the log keeps every copy.
//
// THE SCOPE RULE. A key has to name the scope its id is unique in, and no wider. The store already
// scopes every key to one session, so what is left is the turn. An id the world hands us is unique
// only inside the response that minted it: a provider numbers its tool calls per response, so turn
// 2 legitimately opens `call_1` again, and a key of `tr:call_1` would make the store absorb that
// second result as a redelivery of the first. The tools machine would then never observe its own
// result and the turn would wedge. Every id below that came from outside carries its turn.
export const keyOf: DedupKey = (event: Envelope) => {
  const field = (name: string) => {
    const value = event[name]
    return value === undefined || value === null ? undefined : String(value)
  }
  // An id minted by the world, namespaced by the turn it was minted in. An event outside any turn
  // takes the empty namespace, which is still one scope and still absorbs its own redelivery.
  const inTurn = (prefix: string, id: string | undefined) =>
    id === undefined ? undefined : `${prefix}:${field("turn") ?? ""}/${id}`
  switch (event.type) {
    // The three ids below head their own unit of work rather than sitting inside one, so each is
    // already the namespace a narrower key would be scoped to. A message id IS the turn id
    // (`turnOf` returns the head's id), and a run id is what `incarnationOf` reads.
    case "MessageReceived":
      return field("id") === undefined ? undefined : `msg:${field("id")}`
    case "RunFired":
      return field("runId") === undefined ? undefined : `rf:${field("runId")}`
    case "RunReported":
      return field("run") === undefined ? undefined : `rr:${field("run")}`
    case "RewardGranted":
      return field("run") === undefined ? undefined : `rw:${field("run")}/${field("regime") ?? ""}`
    case "ToolReturned":
      return inTurn("tr", field("callId"))
    case "PackageReturned":
      return inTurn("pr", field("callId"))
    case "CodeDispatched":
      return inTurn("cd", field("execId"))
    case "CodeSettled":
      return inTurn("cs", field("execId"))
    default:
      // Anything outside the table falls back to the core policy, where an event states its own
      // key. That is the door an outside sender uses when it can redeliver its own event type.
      return dedupKey(event)
  }
}
