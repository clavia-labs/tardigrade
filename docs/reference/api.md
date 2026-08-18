# API reference

Per-symbol contracts. Teaching material lives in the quickstart; rationale lives in explanations.

### Event

```ts
type Event = { type: string } & Record<string, unknown>
```

An Event is an open record: a type, and whatever the type carries. Stored events decode tolerantly; unknown types survive a read. Consumers narrow on type. An event is appended once and never edited.

### Projection

```ts
type Projection<T> = (events: Event[]) => T
```

A Projection derives a value from the event set. It must be pure and must ignore event order (tla/Projection.tla, ViewFaithful). It is recomputed on every read; it is never stored and never appends.

### Transition

```ts
type Transition<T, E extends Event = Event> = {
  key: string
  input: T
  act: (input: T) => Promise<E[]>
}
```

A Transition is one keyed unit of work: state in, events out. `key` is the transition's identity; the runtime fires a transition only when no record with its key exists, and a retried fire under the same key is absorbed. `input` is the data `act` receives. `key` and `input` must be projections of the event set (tla/Reactor.tla, CommitOne). `act` returns the events that record the work as done; it may be nondeterministic. `E` is the set of event types `act` may emit.

### Reactor

```ts
type Reactor = (events: Event[]) => Transition[]
```

A Reactor derives the transitions the log enables. It must be pure and must ignore event order. The runtime fires each transition whose key the log does not record and appends the results, keyed record last.

### Actor

```ts
type Actor = { reactors: Reactor[] }
```

An Actor is the single writer of one log and the reactors over it. The platform serializes sends per actor (tla/Projection.tla).

### send

```ts
const send: (actor: Actor, event: Event) => Promise<void>
```

send appends one event and settles the actor.

### settle

```ts
const settle: (actor: Actor) => Promise<void>
```

settle renders every reactor and fires each transition the log does not record, until a full pass enables nothing. A fire that appends nothing while its transition stays enabled dies loud (tla/Driver.tla, EventuallyServed).

### resting

```ts
const resting: (actor: Actor, events: Event[]) => boolean
```

resting reports quiescence: no reactor enables a transition. The platform alarm may be deleted only on a true answer (tla/Driver.tla, Accounting).

### Usage

```ts
type CostSource = "provider" | "table"

type Usage = {
  promptTokens: number
  completionTokens: number
  costUsd?: number
  costSource?: CostSource
  provider?: string
  model?: string
}

const usageIn: (events: Event[], turn: string) => Usage
```

Usage is what one model attempt spent. `ModelReturned` records it. `costUsd` is present when the figure is known: a provider bill, including zero, or a price table fill from token counts. Absence is unknown. `costSource` says which of those two produced the figure, so a billed dollar and a catalog estimate cannot be mistaken for each other. `provider` and `model` name who was called.

`usageIn(log, turn)` sums `ModelReturned` for that turn. Unknown is sticky: if any part omitted cost, the total omits `costUsd`. Mixed sources take `table`, the weaker label.
