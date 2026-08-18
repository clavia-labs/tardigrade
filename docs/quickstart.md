Welcome to the tardigrade documentation! This page will give you an introduction to the core concepts of tardigrade and teach you how to build your own durable agent harness.
### Events
Events are things that you care about.

```ts
// An Event is an open record
type Event = { type: string } & Record<string, unknown>

// Concrete events narrow the shape. These four are the agent's vocabulary.
type MessageReceived = { type: "MessageReceived"; text: string }
type ToolCalled = { type: "ToolCalled"; callId: string; name: string; arguments: unknown }
type ToolReturned = { type: "ToolReturned"; callId: string; result: unknown }
type TurnCompleted = { type: "TurnCompleted"; output: string }
```

An event is a fact, recorded once and never edited. Everything else in tardigrade is derived from the set of them.
### Projections
A projection is that derivation, named: a pure function from the event set to a value.

```ts
// A Projection derives a value from the event set. It is pure and ignores
// event order; it is recomputed on every read, never stored, never appended.
type Projection<T> = (events: Event[]) => T
```

```ts
// done: the turn has reached its terminal.
const done: Projection<boolean> = (events) =>
  events.some((e) => e.type === "TurnCompleted")
```

Notice there is no cache and no invalidation: the log is the source, so a projection can never be stale. This is `state = f(log)`, the way React's derived values are `f(state)`. If a piece of logic appends nothing, it is a projection, never a reactor; reactors exist only for work that must land in the log.

If you're familiar with React, you know the concept of `UI = f(state)`. Similarly in tardigrade, transitions are a function of state: `{transitions} = f(state)`; or more specifically: `{transitions} = f(logs)`

A transition is one keyed unit of work. It takes state in and returns events out. A reactor is a function that takes in an event log and returns a set of transitions.

```ts
// key and input are projections of the event set, so a retried fire is the
// same work, absorbed by its key (tla/Reactor.tla, CommitOne). act may be
// nondeterministic.
type Transition<T, E extends Event = Event> = {
  key: string
  input: T
  act: (input: T) => Promise<E[]>
}

// A Reactor derives the transitions the log enables. It must ignore event
// order (tla/Projection.tla, ViewFaithful). The runtime fires each key the
// log does not record and appends the results, keyed record last.
type Reactor = (events: Event[]) => Transition[]
```
### Actor
An actor is a set of reactors.
### Architecture

```mermaid
flowchart TB
  log[("event log")] -->|"events"| reactor["reactor"]
  reactor -->|"transitions = f(log)"| transitions["transitions"]
  transitions -->|"keys the log does not record"| act["act(input)"]
  act -->|"events, keyed record last"| log
```

### Example: an agent
An agent is three reactors over one log.
#### Tools
**Running tools.** Start with a projection: which calls have no result yet?

```ts
// unansweredCalls: the tool calls with no matching result.
const unansweredCalls: Projection<ToolCalled[]> = (events) =>
  events
    .filter((e) => e.type === "ToolCalled")
    .filter((c) => !events.some((e) => e.type === "ToolReturned" && e.callId === c.callId))
```

Notice that "unanswered" is the absence of an event. Absences are state too, and only a function over the whole set can see one.

```ts
// runTool executes one call.
const runTool = async (call: ToolCalled): Promise<ToolReturned[]> =>
  [{ type: "ToolReturned", callId: call.callId, result: await toolbox[call.name](call.arguments) }]

// tools: one transition per unanswered call.
const tools: Reactor = (events) =>
  unansweredCalls(events).map((call) => ({ key: call.callId, input: call, act: runTool }))
```
#### Inference
**Inference.** The other reactor asks the model what to do next.

```ts
// runLlm does one inference. The action lands as an event.
const runLlm = async (trajectory: Event[]): Promise<(ToolCalled | TurnCompleted)[]> => {
  const action = await model(trajectory)
  return action.kind === "call"
    ? [{ type: "ToolCalled", callId: action.callId, name: action.name, arguments: action.arguments }]
    : [{ type: "TurnCompleted", output: action.output }]
}

// infer: an inference is enabled when every call is answered and no terminal yet.
const infer: Reactor = (events) => {
  if (done(events)) return []
  if (unansweredCalls(events).length > 0) return []
  const attempt = events.filter((e) => e.type === "ToolReturned").length
  return [{ key: `llm/${attempt}`, input: events, act: runLlm }]
}
```

Notice the key: the count of answered calls. A crashed inference never records `llm/2`, so the next settle derives `llm/2` again and retries the same attempt. Durability, with no retry code.
#### Compaction
**Compaction.** The loop appends forever, and the trajectory grows with it. Keeping it small is a capability, so it is a reactor. Assume a token estimate `sizeOf(events)` and a `BUDGET` it compares against.

```ts
// CompactionCompleted is the checkpoint: the summary so far, and the index it covers.
// A render reads the summary plus the events after upTo; nothing is deleted.
type CompactionCompleted = { type: "CompactionCompleted"; summary: string; upTo: number }

// lastCheckpoint: the latest checkpoint, or the empty one.
const lastCheckpoint: Projection<{ summary: string; upTo: number }> = (events) =>
  events.findLast((e) => e.type === "CompactionCompleted") ?? { summary: "", upTo: 0 }
```

```ts
// A Span is the stretch owed a summary: from the checkpoint it starts at,
// up to the index the next checkpoint will cover.
type Span = { summary: string; events: Event[]; from: number; upTo: number }

// spanOf: the span owed a summary, or null while the log is under budget.
const spanOf: Projection<Span | null> = (events) => {
  const checkpoint = lastCheckpoint(events)
  const since = events.slice(checkpoint.upTo)
  if (sizeOf(since) <= BUDGET) return null
  return { summary: checkpoint.summary, events: since, from: checkpoint.upTo, upTo: events.length }
}

// compact folds a span into the next checkpoint.
const compact = async (span: Span): Promise<CompactionCompleted[]> => {
  const summary = await summarize(span.summary, span.events)
  return [{ type: "CompactionCompleted", summary, upTo: span.upTo }]
}

// compaction: enabled when the events since the checkpoint outgrow the budget.
const compaction: Reactor = (events) => {
  const span = spanOf(events)
  if (!span) return []
  return [{ key: `compact/${span.from}`, input: span, act: compact }]
}
```

Notice the shape the projection leaves behind: the reactor is now three lines, and every reactor on this page has the same anatomy: a projection derives the input, the reactor keys it, the act does the work. `input` is always the output of a projection.
#### Agent
**The agent.** Put the three reactors on one log and send it a message.

```ts
const agent: Actor = { reactors: [infer, tools, compaction] }

await send(agent, { type: "MessageReceived", text: "What changed in the deploy?" })
```

Adding a capability is adding a reactor to the list.

#### Architecture
The agent, as the loop: one log, three reactors deriving from it, fires landing back in it.

```mermaid
flowchart TB
  log[("event log")]
  log --> infer & tools & compaction
  infer -->|"ToolCalled or TurnCompleted"| log
  tools -->|"ToolReturned"| log
  compaction -->|"CompactionCompleted"| log
```




