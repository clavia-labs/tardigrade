import { Schema } from "effect"
import type { KeyFragment } from "@flamecast/core/event-log"
import type { Event } from "@flamecast/core/event"

// The code lane's domain events. Consumers connect through these and never call in: the
// agent's execute tool dispatches and awaits, the task's policy dispatches and awaits, and
// neither knows how the code runs.

// CodeDispatched starts one execution of `code`. `execId` is the dedup key: a re-dispatch of
// the same id is one execution.
export const CodeDispatched = Schema.Struct({
  type: Schema.Literal("CodeDispatched"),
  execId: Schema.String,
  code: Schema.String,
  at: Schema.Number
})

// PackageCalled records one package call from inside a code body. `callId` is `{execId}.{n}`
// where n is the call's position in execution order, so a re-run of the same code lands on the
// same keys.
export const PackageCalled = Schema.Struct({
  type: Schema.Literal("PackageCalled"),
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
  at: Schema.Number
})

// PackageReturned records the answer to one package call. The committed pair is the replay
// cache: a re-run returns this result and never touches the world.
export const PackageReturned = Schema.Struct({
  type: Schema.Literal("PackageReturned"),
  callId: Schema.String,
  result: Schema.Unknown,
  at: Schema.Number
})

// BlockedOn is evidence, never a state: one attempt observed one reply absent. It suppresses
// re-deriving the blocked work until `awaiting` appears in the event set (a membership check,
// tla/Projection.tla), and it feeds the waits-for graph (packages/host/src/deadlock.ts). The
// raiser knows what it awaits (Park carries it); no method table exists.
export const BlockedOn = Schema.Struct({
  type: Schema.Literal("BlockedOn"),
  callId: Schema.String,
  awaiting: Schema.String,
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

// CodeSettled is the terminal of one execution: what the code returned, or why it threw. A
// thrown body is a settled execution with an error. Only the machinery's own death leaves no
// settle.
export const CodeSettled = Schema.Struct({
  type: Schema.Literal("CodeSettled"),
  execId: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  // Captured console output, capped by the sandbox (packages/code/src/sandbox.ts,
  // SandboxResult.logs). Absent when the body printed nothing.
  logs: Schema.optional(Schema.Array(Schema.String)),
  at: Schema.Number
})

export const CodeEvent = Schema.Union(
  CodeDispatched,
  BlockedOn,
  PackageCalled,
  PackageReturned,
  CodeSettled
)
export type CodeEvent = typeof CodeEvent.Type

// codeKeys is the code lane's dedup key fragment, owned beside its alphabet. cd/cs name the
// execution; pr names the call's recorded pair. A key names the scope its id is unique in, and
// no wider (execId and callId are minted per lane by the recorded machinery).
export const codeKeys: KeyFragment = {
  prefixes: ["cd:", "cs:", "pr:", "bk:"],
  keyOf: (e) => {
    const v = e as Record<string, unknown>
    switch (e.type) {
      case "CodeDispatched":
        return `cd:${String(v.execId)}`
      case "CodeSettled":
        return `cs:${String(v.execId)}`
      case "PackageReturned":
        return `pr:${String(v.callId)}`
      case "BlockedOn":
        // One row per blocked call: a re-parking attempt redelivers the same key and absorbs.
        return `bk:${String(v.callId)}`
      default:
        return undefined
    }
  }
}

// The constructors below are the alphabet's writing half: one per letter. The open Event
// stays the READER's contract (a fold survives an unknown type); the constructors gate the
// write side, where a misspelled field compiles and the cost is silent (a `calId` derives no
// dedup key, and the exactly-once membrane degrades with nothing to see). Each returns a plain
// Event, so nothing downstream changes. `at` is a parameter, never a clock read, so an
// emission stays a pure function of the log and the timestamp the runtime hands it.

type Stamped = { readonly turn?: string; readonly at: number }

export const codeDispatched = (fields: { readonly execId: string; readonly code: string } & Stamped): Event =>
  ({ type: "CodeDispatched", ...fields }) as Event

export const codeSettled = (
  fields: {
    readonly execId: string
    readonly result?: unknown
    readonly error?: string
    readonly logs?: ReadonlyArray<string>
  } & Stamped
): Event => ({ type: "CodeSettled", ...fields }) as Event

export const packageCalled = (
  fields: { readonly callId: string; readonly name: string; readonly arguments?: unknown } & Stamped
): Event => ({ type: "PackageCalled", ...fields }) as Event

export const packageReturned = (
  fields: {
    readonly callId: string
    readonly result?: unknown
    readonly tmp?: string
    readonly size?: number
    readonly preview?: string
    readonly logs?: ReadonlyArray<string>
  } & Stamped
): Event => ({ type: "PackageReturned", ...fields }) as Event

export const blockedOn = (fields: { readonly callId: string; readonly awaiting: string } & Stamped): Event =>
  ({ type: "BlockedOn", ...fields }) as Event
