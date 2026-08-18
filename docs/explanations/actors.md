An actor is one event log and the reactors over it. The log is the only state: everything else is recomputed from it, so a crash loses nothing and two readers cannot disagree.

$$\mathrm{state} = f(\mathrm{log})$$

### Interface

```ts
// An Actor is the single writer of one log and the reactors over it. The
// platform serializes sends per actor, so appends never race
// (tla/Projection.tla).
type Actor = {
  reactors: Reactor[]
}

// send appends one event and settles the actor.
const send = async (actor: Actor, event: Event): Promise<void>

// settle renders every reactor and fires each transition the log does not
// record, until a full pass enables nothing. A fire that appends nothing
// while enabled dies loud (tla/Driver.tla, EventuallyServed).
const settle = async (actor: Actor): Promise<void>

// resting reports quiescence: no reactor enables a transition. The platform
// alarm may sleep only on a true answer (tla/Driver.tla, Accounting).
const resting = (actor: Actor, events: Event[]): boolean
```

The log is mailbox and state at once. A send lands as an event, reactors derive what it enables, fires append the results, and the new events enable the next round. Settling ends at quiescence, and quiescence is recomputable from the log alone, so the alarm can always re-derive whether the actor is truly done.

### Example

An agent is an actor: one log, three reactors, no references between them.

```ts
const agent: Actor = { reactors: [infer, tools, compaction] }
```

The reactors compose through event names alone. infer emits `ToolCalled`; that event is state the tools reactor derives from; its `ToolReturned` is state infer derives from; the growing log is what compaction watches. Adding a capability to an agent is adding a reactor to the list.
