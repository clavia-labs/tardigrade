If you're familiar with React, you know the concept of `UI = f(state)`. 

$$\mathrm{transitions} = f(\mathrm{log})$$
### Interface

```ts
// A Transition is one keyed unit of work: state in, events out. key and
// input are pure derivations of the event set, so a retried fire is the
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
### Example

The compaction reactor.

```ts
// Span is the input of one compaction: the summary so far, and the
// events to fold into it.
type Span = { summary: string; events: Event[] }

// compact folds a span into the next checkpoint.
const compact = async (span: Span): Promise<CompactionCompleted[]> => {
  const summary = await summarize(span.summary, span.events)
  return [completed(summary)]
}

// compaction enables one compact transition when the events since the
// last checkpoint outgrow the budget. The key is the event the next
// checkpoint keeps from, so a completion moves the checkpoint and
// retires the key: one fire per crossing.
const compaction: Reactor = (events) => {
  const checkpoint = lastCheckpoint(events)
  const since = events.slice(indexOf(events, checkpoint.keepFrom))
  if (estimateTokens(since) <= BUDGET) return []

  const cut = cutOf(since)
  return [{
    key: `compact/${cut.id}`,
    input: { summary: checkpoint.summary, events: since.slice(0, cut.at) },
    act: compact,
  }]
}
```

