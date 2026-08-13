# Concepts

This page defines the small vocabulary the framework builds on.

## Event

An event is one immutable fact represented by an `Envelope`.

```ts
interface Envelope {
  readonly type: string
  readonly [key: string]: unknown
}
```

Events use an open shape so modules can introduce domain vocabulary without changing core. [Events](events.md) defines the standard alphabet and dedup rules.

## Event Log

An event log is the ordered append-only history of one session. It is the source of truth for state, debugging, replay, evaluation, and recovery.

## Projection

A projection is a pure function from a log to a value.

```ts
type Projection<Value> = (log: ReadonlyArray<Envelope>) => Value
```

Projections reconstruct current state without adding facts to the log. The active turn, current checkpoint, and rendered model request are projections.

## Machine

A machine is behavior over the event log. Its state is reconstructed by folding events through named transitions.

Each state can define one work slot:

- `decide(log, now, context)` is pure and returns events.
- `act(log, context)` performs an effect and returns events that record the outcome.

`settle` repeatedly folds and runs ready work until the machine rests. `settleAll` reaches a fixpoint across a group of machines.

Use a machine when behavior must append facts, wait for events, or perform effects. A pure projection that changes a request does not need a machine.

## Module

A module is one typed unit of construction.

```ts
interface Module<Id, Provides, Requires, R> {
  readonly id: Id
  readonly version?: string
  readonly fingerprint?: unknown
  readonly provides?: Provides
  readonly requires?: Requires
  readonly setup: (context: ModuleContext<Requires>) => ModulePart<R>
}
```

Modules own their configuration and can contribute machines or projections. Module ids are unique. Compilation rejects ambiguous or incomplete compositions.

## Token and Binding

A token names a typed projection dependency. A binding associates that token with its projection.

```ts
const inferenceState = token<"inference.state", InferenceState>("inference.state")

provide(inferenceState, selectInferenceState)
```

A consumer lists tokens in `requires` and resolves them through its `ModuleContext`. TypeScript rejects missing dependencies for literal module tuples. Runtime compilation performs the same validation for generated JavaScript.

Bindings are deliberately constrained dependency injection. They inject pure projections of the log. Effectful capabilities use ports so replay and observation do not depend on hidden construction state.

## Port

A port is an effectful capability required by a machine, such as event storage, exclusive writing, time, routing, or spill storage. A runtime binds ports for a platform without changing the program.
